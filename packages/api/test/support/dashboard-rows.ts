/**
 * Synthetic rows for the dashboard live tests, written straight to the test Postgres within every CHECK of
 * packages/db: payments (unsigned, or "mined" with fake signed columns), and a SECOND facility with its own payee,
 * chain actions, a submitted signature request and a committed plan, so the tests can prove none of its rows reach
 * this facility's routes (T31). Every hex value is generated at runtime; nothing here touches the chain.
 */
import { randomBytes } from "node:crypto";
import { RINA_IDS, type LineKey } from "@hogee/core";
import { lineKeyToLineId } from "../../src/chain-lib";
import { uuidv7 } from "../../src/services/ids";
import type { Q } from "../../src/services/sql";

export const hex32 = (): string => `0x${randomBytes(32).toString("hex")}`;
const address = (): string => `0x${randomBytes(20).toString("hex")}`;
const ZERO32 = `0x${"0".repeat(64)}`;

export interface PaymentSeed {
  readonly id?: string;
  readonly kind?: "SPEND" | "OWNER_SPEND" | "WITHDRAW_RESERVE";
  readonly lineKey?: LineKey;
  readonly amountMinor?: string;
  /** PROPOSED / POLICY_DENIED are unsigned; INCLUDED gets fake signed columns and needs `block`. */
  readonly state?: "PROPOSED" | "POLICY_DENIED" | "INCLUDED";
  readonly block?: bigint;
  readonly createdAt?: Date;
  readonly traceId?: string;
}

const payeeOf = (kind: PaymentSeed["kind"], lineKey: LineKey | null): string => {
  if (kind === "WITHDRAW_RESERVE") return RINA_IDS.taxPayeeId;
  return lineKey === "PLATFORM_FEES" ? RINA_IDS.platformFeesPayeeId : RINA_IDS.adsPayeeId;
};

/** One payment row; returns its id. The payee must exist for the facility (platform payees do after open). */
export async function insertPayment(q: Q, facilityId: string, seed: PaymentSeed = {}): Promise<string> {
  const id = seed.id ?? `pay-${uuidv7()}`;
  const kind = seed.kind ?? "SPEND";
  const lineKey = kind === "WITHDRAW_RESERVE" ? null : (seed.lineKey ?? "ADS");
  const agent = kind === "SPEND";
  const mined = seed.state === "INCLUDED";
  if (mined && seed.block === undefined) throw new Error("a mined row needs its block");
  const createdAt = (seed.createdAt ?? new Date()).toISOString();
  await q.query(
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state,
       signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, decision_id, rationale_hash, trace_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)`,
    [
      id,
      facilityId,
      kind,
      hex32(),
      lineKey,
      lineKey ? lineKeyToLineId(lineKey).toLowerCase() : null,
      payeeOf(kind, lineKey),
      seed.amountMinor ?? "1500",
      kind === "WITHDRAW_RESERVE" ? ZERO32 : hex32(),
      seed.state ?? "PROPOSED",
      mined ? address() : null,
      mined ? 31337 : null,
      mined ? `0x02${randomBytes(40).toString("hex")}` : null,
      mined ? BigInt(`0x${randomBytes(5).toString("hex")}`).toString() : null,
      mined ? hex32() : null,
      mined ? (seed.block as bigint).toString() : null,
      agent ? uuidv7() : null,
      agent ? hex32() : null,
      seed.traceId ?? `trace:${id}`,
      createdAt,
    ],
  );
  return id;
}

/** A second tenant on the same deployment: facility row and its own ADS platform payee. */
export async function insertFacility(q: Q, facilityId: string, deploymentId: string): Promise<void> {
  await q.query(
    `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id)
     values ($1, '1000000', 'MYR', 300, $2, $3, 31337)`,
    [facilityId, address(), deploymentId],
  );
  await q.query(
    `insert into payees (id, facility_id, kind, display_name, payout_account_hash, status) values ($1, $2, 'platform', 'Other tenant ads', $3, 'BOUND')`,
    [RINA_IDS.adsPayeeId, facilityId, hex32()],
  );
}

/** An unsigned (PENDING) chain action of `kind`, e.g. an officer's Treasury.openFacility. */
export async function insertChainAction(q: Q, facilityId: string, kind: string): Promise<void> {
  await q.query(`insert into chain_actions (id, facility_id, kind, ref_id, state, request_json) values ($1, $2, $3, $2, 'PENDING', '{}'::jsonb)`, [
    `act-${uuidv7()}`,
    facilityId,
    kind,
  ]);
}

/** A consumed (SUBMITTED) founder signature request. */
export async function insertSubmittedSignature(q: Q, facilityId: string): Promise<void> {
  await q.query(
    `insert into signature_requests (id, facility_id, kind, ref_id, method, typed_data_json, digest, challenge_b64url, display_model_json, nonce, expires_at, status, submitted_at)
     values ($1, $2, 'PlanApproval', 'draft-other', 'passkey', '{}'::jsonb, $3, 'AA', '{}'::jsonb, 1, 1, 'SUBMITTED', now())`,
    [`sig-${uuidv7()}`, facilityId, hex32()],
  );
}

/** A COMMITTED plan v1 signed at `signedAt`. */
export async function insertCommittedPlan(q: Q, facilityId: string, signedAt: Date): Promise<void> {
  await q.query(
    `insert into plans (id, facility_id, plan_id, version, prev_plan_hash, plan_hash, manifest_json, country_pack_hash, status, signed_at)
     values ($1, $2, $3, 1, $4, $5, '{}'::jsonb, $6, 'COMMITTED', $7)`,
    [`plan-${uuidv7()}`, facilityId, hex32(), ZERO32, hex32(), hex32(), signedAt.toISOString()],
  );
}

/** Removes every row the helpers above wrote for a synthetic tenant (FK order). */
export async function deleteFacility(q: Q, facilityId: string): Promise<void> {
  for (const table of ["payments", "traces", "signature_requests", "chain_actions", "plans", "payees", "facilities"]) {
    await q.query(`delete from ${table} where facility_id = $1`, [facilityId]);
  }
}
