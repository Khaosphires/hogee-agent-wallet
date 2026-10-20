/**
 * G2 (closes security-audit run-4 lead 5): founder passkey enrolment. Before G2 any client that reached the API between
 * `facility/open` and the founder's registration could take the PENDING_LENDER slot. Now the loan officer issues a
 * one-time code, the registration challenge is bound to it, and `/api/passkey/register/verify` consumes it in the
 * same transaction that stores the key. The officer can reject a pending key, which frees the slot for a new
 * enrolment. Writers: `src/founder-enrolment.ts` only.
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, hex32, hex32Checks, tenantFk, tstz } from './columns';
import { facilityRef, founders } from './tenancy';

/**
 * One row per issued code. Only `code_hash` = keccak256(utf8(code)) is stored (Ethereum Keccak-256, never NIST SHA3);
 * the code itself is shown to the officer once. A code is open while unused and unrevoked: at most one per facility
 * (the partial unique index; issuing a new one revokes the old). Expiry is wall-clock time (`code_expires_at`, 15 min,
 * the registration challenge's time base) and is judged by the caller's clock at use, not stored as a status.
 */
export const founderEnrolmentCodes = pgTable(
  'founder_enrolment_codes',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    founderId: text('founder_id').notNull(),
    codeHash: hex32('code_hash').notNull(),
    codeExpiresAt: tstz('code_expires_at').notNull(),
    /** Set by the registration that consumed it, with the credential it let in. */
    usedAt: tstz('used_at'),
    usedCredentialId: text('used_credential_id'),
    /** Set when a newer code replaced it. */
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'founder_enrolment_codes_pk', columns: [t.facilityId, t.id] }),
    tenantFk('founder_enrolment_codes_founder_fk', [t.facilityId, t.founderId], [founders.facilityId, founders.id]),
    uniqueIndex('founder_enrolment_codes_one_open').on(t.facilityId).where(sql`${t.usedAt} IS NULL AND ${t.revokedAt} IS NULL`),
    ...hex32Checks('founder_enrolment_codes', [t.codeHash]),
    check('founder_enrolment_codes_used_names_credential', sql`(${t.usedAt} IS NULL) = (${t.usedCredentialId} IS NULL)`),
    check('founder_enrolment_codes_used_xor_revoked', sql`${t.usedAt} IS NULL OR ${t.revokedAt} IS NULL`),
  ],
);

/**
 * Keys the loan officer rejected while they were pending (never one registered on-chain). The founder row is cleared
 * in the same transaction, so a new enrolment can start; a rejected credential can never be pending or approved again.
 */
export const rejectedFounderKeys = pgTable(
  'rejected_founder_keys',
  {
    facilityId: facilityRef(),
    credentialId: text('credential_id').notNull(),
    founderId: text('founder_id').notNull(),
    qx: hex32('qx').notNull(),
    qy: hex32('qy').notNull(),
    registeredAt: tstz('registered_at'),
    rejectedAt: tstz('rejected_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'rejected_founder_keys_pk', columns: [t.facilityId, t.credentialId] }),
    tenantFk('rejected_founder_keys_founder_fk', [t.facilityId, t.founderId], [founders.facilityId, founders.id]),
    ...hex32Checks('rejected_founder_keys', [t.qx, t.qy]),
  ],
);
