/**
 * In-memory {@link SignedRowStore} for unit tests. Writes are conditional on the expected state, like the
 * pg store, and it enforces the G0-AUDIT (v-4) row CHECKs the real `payments` table has:
 * `payments_cancelled_iff_nonce_consumed`, `payments_nonce_consumed_by_foreign_tx`,
 * `payments_reverted_has_receipt` and `payments_superseded_tx_hashes_hex32`.
 */
import { INTENT_RELEASED_STATES } from '@hogee/db';
import type { Hex } from 'viem';
import type { FacilityDeployment, Landing, ListRowsOptions, SignedRow, SignedRowStore, SignTarget, Transition } from '../../src/index';
import { DEPLOYMENT, FACILITY } from './signed-rows';

export interface MemoryRow extends SignedRow {
  readonly revertReason: string | null;
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const same = (a: SignTarget, b: SignTarget) => a.table === b.table && a.facilityId === b.facilityId && a.id === b.id;

export class CheckViolation extends Error {
  override readonly name = 'CheckViolation';
}

function checkRow(r: MemoryRow): void {
  if (r.target.table !== 'payments') return;
  if (!r.supersededTxHashes.every((h) => HEX32.test(h))) throw new CheckViolation('payments_superseded_tx_hashes_hex32');
  if ((r.state === 'CANCELLED') !== (r.nonceConsumedByTxHash !== null)) throw new CheckViolation('payments_cancelled_iff_nonce_consumed');
  const c = r.nonceConsumedByTxHash;
  if (c !== null && (r.txHash === null || c === r.txHash || r.supersededTxHashes.includes(c))) {
    throw new CheckViolation('payments_nonce_consumed_by_foreign_tx');
  }
  if (r.state === 'REVERTED' && (r.block === null || r.txHash === null)) throw new CheckViolation('payments_reverted_has_receipt');
}

export class MemoryRowStore implements SignedRowStore {
  rows: MemoryRow[] = [];
  /** `facilities.deployment_id` / `chain_id` per facility: FACILITY names DEPLOYMENT. */
  facilities = new Map<string, FacilityDeployment>([[FACILITY, { deploymentId: DEPLOYMENT.deploymentId, chainId: DEPLOYMENT.chainId }]]);
  /** listRows calls (a pass refused up front must not list any row). */
  listCalls = 0;

  async readFacilityDeployment(facilityId: string): Promise<FacilityDeployment | null> {
    return this.facilities.get(facilityId) ?? null;
  }

  add(row: SignedRow): MemoryRow {
    const r: MemoryRow = { revertReason: null, ...row };
    checkRow(r);
    this.rows = [...this.rows, r];
    return r;
  }

  get(target: SignTarget): MemoryRow {
    const r = this.rows.find((x) => same(x.target, target));
    if (!r) throw new Error(`no row ${target.id}`);
    return r;
  }

  /** The payments unique index: is this row's intent still held? */
  holdsIntent(target: SignTarget): boolean {
    return !(INTENT_RELEASED_STATES as readonly string[]).includes(this.get(target).state);
  }

  private update(target: SignTarget, from: readonly string[], patch: (r: MemoryRow) => MemoryRow): boolean {
    const r = this.rows.find((x) => same(x.target, target));
    if (!r || !from.includes(r.state)) return false;
    const next = patch(r);
    checkRow(next);
    this.rows = this.rows.map((x) => (x === r ? next : x));
    return true;
  }

  async listRows(opts: ListRowsOptions): Promise<SignedRow[]> {
    this.listCalls += 1;
    return this.rows
      .filter((r) => r.chainId === opts.chainId && r.rawSignedTx !== null)
      .filter((r) => opts.facilityId === undefined || r.target.facilityId === opts.facilityId)
      .filter((r) => opts.states[r.target.table].includes(r.state))
      .sort((a, b) => ((a.nonce ?? 0n) < (b.nonce ?? 0n) ? -1 : (a.nonce ?? 0n) > (b.nonce ?? 0n) ? 1 : 0));
  }

  async transition(target: SignTarget, t: Transition): Promise<boolean> {
    return this.update(target, t.from, (r) => ({
      ...r,
      state: t.to,
      ...(t.txHash !== undefined ? { txHash: t.txHash.toLowerCase() as Hex } : {}),
      ...(t.block !== undefined ? { block: t.block } : {}),
      ...(t.revertReason !== undefined ? { revertReason: t.revertReason } : {}),
    }));
  }

  async recordLanding(target: SignTarget, l: Landing): Promise<boolean> {
    const landed = l.txHash.toLowerCase() as Hex;
    return this.update(target, l.from, (r) => {
      const superseded =
        r.target.table !== 'payments' || r.txHash === null || r.txHash === landed
          ? r.supersededTxHashes
          : [...r.supersededTxHashes.filter((h) => h !== landed), r.txHash];
      return { ...r, state: 'INCLUDED', txHash: landed, block: l.block, supersededTxHashes: superseded, ...(l.rawSignedTx ? { rawSignedTx: l.rawSignedTx } : {}) };
    });
  }

  async recordCancelled(target: SignTarget, c: { consumedBy: Hex }): Promise<boolean> {
    if (target.table !== 'payments') return false;
    return this.update(target, ['DROPPED'], (r) => ({ ...r, state: 'CANCELLED', nonceConsumedByTxHash: c.consumedBy.toLowerCase() as Hex }));
  }
}
