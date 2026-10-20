/**
 * The chain_actions outbox from the API side (D19). The API inserts an UNSIGNED `PENDING` row whose `request_json`
 * holds the typed call inputs (decimal strings, lowercase hex), then sends a queue job; the worker validates the row,
 * rebuilds the calldata with @hogee/chain, signs with the role key for that kind, and broadcasts. The API never
 * signs and never holds a key.
 */
import type { ChainAction } from "@hogee/core";
import type { PoolClient } from "pg";
import type { ApiDeps, ApiJob } from "../context";
import { newId } from "./ids";
import { jsonb, one, rows, type Q } from "./sql";

/** `<Contract>.<function>` kinds the API creates (the worker's relay knows each one's signer and checks). */
export type ActionKind =
  | "PlanRegistry.registerFounderKey"
  | "PlanRegistry.commitPlan"
  | "Treasury.openFacility"
  | "Treasury.fund"
  | "Treasury.bindPayee"
  | "Treasury.queueLoosen"
  | "Treasury.releaseStage"
  | "Treasury.cancelLoosen"
  | "Treasury.pause"
  | "Treasury.recordDenied"
  | "SalesOracle.recordSale";

export interface NewAction {
  readonly facilityId: string;
  readonly kind: ActionKind;
  /** The row this serves (facility, founder, plan row, order, exception, sale, denial). */
  readonly refId: string;
  readonly request: Readonly<Record<string, unknown>>;
}

/** Inserts the unsigned PENDING row inside the caller's transaction. */
export async function insertAction(q: PoolClient | Q, a: NewAction): Promise<ChainAction> {
  const id = newId("act");
  await q.query(`insert into chain_actions (id, facility_id, kind, ref_id, state, request_json) values ($1, $2, $3, $4, 'PENDING', $5::jsonb)`, [
    id,
    a.facilityId,
    a.kind,
    a.refId,
    jsonb({ v: 1, ...a.request }),
  ]);
  return { actionId: id, state: "PENDING" };
}

interface ActionRow {
  id: string;
  state: ChainAction["state"];
  tx_hash: string | null;
}

export const actionView = (r: ActionRow): ChainAction => ({ actionId: r.id, state: r.state, ...(r.tx_hash ? { txHash: r.tx_hash as ChainAction["txHash"] } : {}) });

/** The latest action of `kind` for `refId` that has not reverted (a retry returns it instead of a duplicate). */
export async function liveAction(q: Q, facilityId: string, kind: ActionKind, refId: string): Promise<ChainAction | null> {
  const r = await one<ActionRow>(
    q,
    `select id, state, tx_hash from chain_actions where facility_id = $1 and kind = $2 and ref_id = $3 and state <> 'REVERTED' order by created_at desc limit 1`,
    [facilityId, kind, refId],
  );
  return r ? actionView(r) : null;
}

export async function actionsFor(q: Q, facilityId: string, refId: string): Promise<ChainAction[]> {
  return (await rows<ActionRow>(q, `select id, state, tx_hash from chain_actions where facility_id = $1 and ref_id = $2 order by created_at`, [facilityId, refId])).map(actionView);
}

/** Wakes the worker. A lost job only delays the action: the worker also sweeps the outbox on a schedule. */
export async function wake(deps: ApiDeps, job: ApiJob, data: Readonly<Record<string, unknown>> = {}): Promise<void> {
  try {
    await deps.queue.send(job, data);
  } catch (error: unknown) {
    deps.log.warn("queue_send_failed", { job, error });
  }
}
