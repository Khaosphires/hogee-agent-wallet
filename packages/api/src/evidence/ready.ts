/**
 * Readiness of an evidence export (run-6 re-check M1), checked synchronously under the export lock, before anything is
 * collected and before the run is claimed. A refusal therefore reaches the POST caller as 409 with its reason, and it
 * leaves no FAILED row and arms no interval (retention.ts): the founder can export again as soon as the chain settles.
 *   - The `finalized` head is read first (one RPC).
 *   - No row is in flight: every payment or chain action that names a tx is in a mined state (or is a CANCELLED
 *     payment, whose nonce consumer fetch.ts proves).
 *   - The newest block any row records is at or below the finalized head.
 * Two aggregate queries. The background build (fetch.ts) still re-checks every receipt against the node and the head,
 * so a row that changes between this check and the collect still fails closed, as a FAILED run.
 */
import type { ApiDeps, Scope } from "../context";
import { EvidenceChainError, finalizedHead, MINED_ACTION_STATES, MINED_PAYMENT_STATES, type Request } from "./fetch";

type ReadyRow = { in_flight: number; first_id: string | null; first_state: string | null; newest: string | null };

/** Throws EvidenceChainError (a refusal the route answers as CONFLICT) unless the facility's evidence is settled. */
export async function assertExportReady(deps: Pick<ApiDeps, "db" | "client">, scope: Scope): Promise<void> {
  const finalized = await finalizedHead(deps.client.request as unknown as Request);
  const r = await deps.db.$client.query<ReadyRow>(
    `with flight as (
       select id, state::text as state from payments
        where facility_id = $1 and tx_hash is not null and state::text <> 'CANCELLED' and state::text <> all($2::text[])
       union all
       select id, state::text as state from chain_actions
        where facility_id = $1 and tx_hash is not null and state::text <> all($3::text[])
     ), first as (select id, state from flight order by id collate "C" limit 1)
     select (select count(*)::int from flight) as in_flight, (select id from first) as first_id, (select state from first) as first_state,
       greatest((select max(block) from payments where facility_id = $1 and tx_hash is not null),
                (select max(block) from chain_actions where facility_id = $1 and tx_hash is not null))::text as newest`,
    [scope.facilityId, [...MINED_PAYMENT_STATES], [...MINED_ACTION_STATES]],
  );
  const row = r.rows[0];
  if (row && row.in_flight > 0) {
    throw new EvidenceChainError(`${row.in_flight} row(s) still name a tx in flight (first: ${row.first_id} is ${row.first_state}): export again once the worker has settled them`);
  }
  const newest = row?.newest ? BigInt(row.newest) : null;
  if (newest !== null && newest > finalized) {
    throw new EvidenceChainError(`the newest tx is in block ${newest}, above the finalized block ${finalized}: export again once it is final`);
  }
}
