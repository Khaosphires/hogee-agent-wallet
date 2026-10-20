/**
 * The one writer of `founder_enrolment_codes` and `rejected_founder_keys` (G2, closes security-audit run-4 lead 5).
 *
 * Callers pass `codeHash` = keccak256(utf8(code)) (Ethereum Keccak-256, never NIST SHA3) and never the code, so a code
 * is neither stored nor logged here. Every time is the caller's clock (`now`): the API judges expiry on its wall clock,
 * the same base as the WebAuthn registration challenge. Functions that write more than one row must run inside the
 * caller's transaction (BEGIN … COMMIT on one client); they lock the founder row first, so concurrent issues and
 * consumes serialise per founder.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { HEX32_PATTERN } from './schema/columns';

/** node-postgres `query` (a Pool, or a PoolClient inside BEGIN … COMMIT). */
export type EnrolmentQueryable = Pick<PoolClient, 'query'>;

export interface OpenEnrolmentCode {
  readonly id: string;
  readonly founderId: string;
  readonly codeHash: string;
  readonly expiresAt: Date;
}

export interface IssueEnrolmentCode {
  readonly facilityId: string;
  readonly founderId: string;
  readonly id: string;
  readonly codeHash: string;
  readonly now: Date;
  readonly expiresAt: Date;
}

export interface FounderKeyRejection {
  readonly facilityId: string;
  readonly founderId: string;
  readonly credentialId: string;
  readonly now: Date;
}

const HEX32 = new RegExp(HEX32_PATTERN);

function checkHash(codeHash: string): string {
  const h = codeHash.toLowerCase();
  if (!HEX32.test(h)) throw new Error('founder enrolment: codeHash must be a 32-byte hex keccak256');
  return h;
}

async function rowsOf<T extends QueryResultRow>(q: EnrolmentQueryable, text: string, values: unknown[]): Promise<T[]> {
  return (await q.query<T>(text, values)).rows;
}

/** Locks the founder row (FOR UPDATE); false when the founder does not exist in this facility. */
export async function lockFounder(q: EnrolmentQueryable, facilityId: string, founderId: string): Promise<boolean> {
  const r = await rowsOf(q, 'select 1 as x from founders where facility_id = $1 and id = $2 for update', [facilityId, founderId]);
  return r.length === 1;
}

/**
 * Revokes the facility's open code (if any) and stores the new one. In a transaction. Returns how many codes it revoked
 * (0 or 1: at most one is open, `founder_enrolment_codes_one_open`).
 */
export async function issueEnrolmentCode(q: EnrolmentQueryable, c: IssueEnrolmentCode): Promise<number> {
  if (!(c.expiresAt.getTime() > c.now.getTime())) throw new Error('founder enrolment: a code must expire after it is issued');
  const codeHash = checkHash(c.codeHash);
  if (!(await lockFounder(q, c.facilityId, c.founderId))) throw new Error('founder enrolment: no such founder in this facility');
  const revoked = await q.query(
    'update founder_enrolment_codes set revoked_at = $2 where facility_id = $1 and used_at is null and revoked_at is null',
    [c.facilityId, c.now],
  );
  await q.query(
    `insert into founder_enrolment_codes (id, facility_id, founder_id, code_hash, code_expires_at)
     values ($1, $2, $3, $4, $5)`,
    [c.id, c.facilityId, c.founderId, codeHash, c.expiresAt],
  );
  return revoked.rowCount ?? 0;
}

/** The facility's open code if it is still unexpired at `now` (unused, unrevoked), else null. */
export async function openEnrolmentCode(q: EnrolmentQueryable, facilityId: string, now: Date): Promise<OpenEnrolmentCode | null> {
  const [r] = await rowsOf<{ id: string; founder_id: string; code_hash: string; code_expires_at: Date }>(
    q,
    `select id, founder_id, code_hash, code_expires_at from founder_enrolment_codes
      where facility_id = $1 and used_at is null and revoked_at is null and code_expires_at > $2`,
    [facilityId, now],
  );
  return r ? { id: r.id, founderId: r.founder_id, codeHash: r.code_hash, expiresAt: r.code_expires_at } : null;
}

/**
 * Marks the code used by `credentialId`, only if it is still open and unexpired at `now`. Run it in the transaction
 * that stores the key: false means someone else used, revoked or outlived it, and the caller must roll back.
 */
export async function consumeEnrolmentCode(
  q: EnrolmentQueryable,
  c: { readonly facilityId: string; readonly id: string; readonly credentialId: string; readonly now: Date },
): Promise<boolean> {
  const r = await q.query(
    `update founder_enrolment_codes set used_at = $3, used_credential_id = $4
      where facility_id = $1 and id = $2 and used_at is null and revoked_at is null and code_expires_at > $3`,
    [c.facilityId, c.id, c.now, c.credentialId],
  );
  return r.rowCount === 1;
}

/**
 * Rejects the founder's PENDING key `credentialId`: records it in `rejected_founder_keys` and clears the founder's
 * credential so a new enrolment can start. In a transaction. Never touches a REGISTERED key (the update matches only
 * PENDING_LENDER); false when that key is not the founder's pending one.
 */
export async function rejectPendingFounderKey(q: EnrolmentQueryable, r: FounderKeyRejection): Promise<boolean> {
  const [key] = await rowsOf<{ qx: string; qy: string; passkey_registered_at: Date | null }>(
    q,
    `select qx, qy, passkey_registered_at from founders
      where facility_id = $1 and id = $2 and passkey_credential_id = $3 and key_status = 'PENDING_LENDER' and qx is not null and qy is not null
      for update`,
    [r.facilityId, r.founderId, r.credentialId],
  );
  if (!key) return false;
  await q.query(
    `insert into rejected_founder_keys (facility_id, credential_id, founder_id, qx, qy, registered_at, rejected_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [r.facilityId, r.credentialId, r.founderId, key.qx, key.qy, key.passkey_registered_at, r.now],
  );
  const cleared = await q.query(
    `update founders set passkey_credential_id = null, qx = null, qy = null, passkey_registered_at = null
      where facility_id = $1 and id = $2 and passkey_credential_id = $3 and key_status = 'PENDING_LENDER'`,
    [r.facilityId, r.founderId, r.credentialId],
  );
  if (cleared.rowCount !== 1) throw new Error('founder enrolment: the pending key changed during its rejection');
  // Audit run-7: a code the officer issued while this key was pending must not outlive the rejection, or its holder
  // could take the freed slot. A fresh enrolment needs a code issued after the reject.
  await q.query('update founder_enrolment_codes set revoked_at = $2 where facility_id = $1 and used_at is null and revoked_at is null', [r.facilityId, r.now]);
  return true;
}

/** A key as the officer reviews it: its credential id, and its P-256 point when known. */
export interface FounderKeyIdentity {
  readonly credentialId: string;
  readonly qx?: string | null;
  readonly qy?: string | null;
}

/**
 * Whether the officer rejected this key in this facility: its credential id, or (audit run-7) its public key (qx, qy)
 * under any credential id, so a rejected P-256 key cannot come back under a new credential.
 */
export async function isFounderKeyRejected(q: EnrolmentQueryable, facilityId: string, key: FounderKeyIdentity): Promise<boolean> {
  const qx = key.qx ? key.qx.toLowerCase() : null;
  const qy = key.qy ? key.qy.toLowerCase() : null;
  const r = await rowsOf(
    q,
    `select 1 as x from rejected_founder_keys
      where facility_id = $1 and (credential_id = $2 or ($3::text is not null and $4::text is not null and lower(qx) = $3 and lower(qy) = $4))
      limit 1`,
    [facilityId, key.credentialId, qx, qy],
  );
  return r.length === 1;
}
