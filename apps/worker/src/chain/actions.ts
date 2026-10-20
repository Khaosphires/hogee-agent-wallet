/**
 * Non-payment transactions through the `chain_actions` outbox (G0 decision; §12.3 crash safety): the row is created
 * first (deterministic id, so a re-run finds it), then signed + stored by @hogee/chain `signAndStore` (Postgres
 * nonce, raw tx saved before broadcast), then broadcast. Recovery and finality move it on from there.
 */
import { sendStored, signAndStore, type BroadcastResult, type DeploymentManifest, type SenderClient, type SignTarget, type StoredTx, type TxRequest, type TxSigner } from '@hogee/chain';
import { chainActions, type Db } from '@hogee/db';
import { jsonParam } from '../store/pg';

export interface ActionSpec {
  readonly facilityId: string;
  /** Deterministic (e.g. `settle-confirm:<paymentId>`), so a retry after a crash reuses the row. */
  readonly id: string;
  /** `<Contract>.<function>`, e.g. `Treasury.confirmSettlement`. */
  readonly kind: string;
  readonly refId?: string;
  readonly request: TxRequest;
  /** Stored for audit (the decoded intent of the call, never a key). */
  readonly requestJson?: unknown;
}

export interface ActionContext {
  readonly db: Db;
  readonly client: SenderClient;
  readonly deployment: DeploymentManifest;
  readonly chainId: number;
  readonly capWei: bigint;
}

export const actionTarget = (facilityId: string, id: string): SignTarget => ({ table: 'chain_actions', facilityId, id });

/** Inserts the PENDING row unless it exists. Returns true when this call created it. */
export async function ensureAction(db: Db, spec: ActionSpec): Promise<boolean> {
  const created = await db
    .insert(chainActions)
    .values({
      id: spec.id,
      facilityId: spec.facilityId,
      kind: spec.kind,
      refId: spec.refId ?? null,
      state: 'PENDING',
      requestJson: spec.requestJson === undefined ? null : (JSON.parse(jsonParam(spec.requestJson)) as unknown),
    })
    .onConflictDoNothing()
    .returning({ id: chainActions.id });
  return created.length === 1;
}

/**
 * ensureAction, then signAndStore (idempotent: an already-signed row returns its stored tx and signs nothing),
 * then broadcast of the stored bytes. Nothing is signed unless `request` is bound to the facility's deployment.
 */
export async function sendAction(ctx: ActionContext, spec: ActionSpec, account: TxSigner): Promise<{ stored: StoredTx; sent: BroadcastResult }> {
  await ensureAction(ctx.db, spec);
  const stored = await signAndStore(ctx.db, {
    target: actionTarget(spec.facilityId, spec.id),
    request: spec.request,
    account,
    client: ctx.client,
    chainId: ctx.chainId,
    capWei: ctx.capWei,
    deployment: ctx.deployment,
  });
  const sent = await sendStored(ctx.db, ctx.client, stored);
  return { stored, sent };
}
