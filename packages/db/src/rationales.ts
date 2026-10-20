/**
 * The one writer of `rationales` (task 1.16): every decision writer calls it inside the transaction that stores its
 * payment or denial row, with the exact object it hashed, so the evidence bundle carries the preimage of every
 * commitment. It stores; it never computes or changes a hash (the writer's hash goes on-chain unchanged).
 * Identical rationales share one row (the first decision id is kept).
 */

/** Anything with node-postgres `query` (a Pool, a PoolClient inside BEGIN … COMMIT). */
export interface RationaleQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export interface RationaleRecord {
  readonly facilityId: string;
  /** The commitment the writer recorded: keccak256(utf8(JCS(rationale))) today. */
  readonly rationaleHash: string;
  readonly decisionId: string | null;
  /** The plain-JSON object that was hashed. */
  readonly rationale: unknown;
  /** Reserved for the §7.2 salted form; no writer sets it yet. */
  readonly salt?: string | null;
}

export async function insertRationale(q: RationaleQueryable, r: RationaleRecord): Promise<void> {
  await q.query(
    `insert into rationales (facility_id, rationale_hash, decision_id, rationale_json, salt)
     values ($1, $2, $3, $4::jsonb, $5)
     on conflict (facility_id, rationale_hash) do nothing`,
    [r.facilityId, r.rationaleHash.toLowerCase(), r.decisionId, JSON.stringify(r.rationale), r.salt ?? null],
  );
}
