/**
 * The signed bytes of a mined tx, rebuilt from the node's copy of it (its fields and signature). Recovery and the
 * finality watcher use it when an earlier version of a fee-bumped row is the one that landed: the row then stores the
 * landed tx's own bytes with its hash, so the evidence export keeps keccak256(raw_signed_tx) = tx_hash (19 Oct, Sepolia:
 * a safety pause() landed at its original fee while the row held the bump).
 *
 * Fails closed: null unless the rebuilt bytes hash back to `hash` exactly (or the node has no copy, or the type is one
 * this repo never signs). The caller then keeps the bytes it already stores.
 */
import { keccak256, serializeTransaction, type Hex, type Signature, type TransactionSerializable } from 'viem';
import type { HogeePublicClient } from './clients';

/** Types the worker signs (and Anvil / Sepolia return); blob and set-code txs are never ours. */
const REBUILDABLE = new Set(['legacy', 'eip2930', 'eip1559']);

export async function minedSignedBytes(client: Pick<HogeePublicClient, 'getTransaction'>, hash: Hex): Promise<Hex | null> {
  let tx: Awaited<ReturnType<HogeePublicClient['getTransaction']>>;
  try {
    tx = await client.getTransaction({ hash });
  } catch {
    return null;
  }
  const n = tx as unknown as { type?: string; r?: Hex; s?: Hex; v?: bigint; yParity?: number; input?: Hex };
  if (!n.type || !REBUILDABLE.has(n.type) || !n.r || !n.s) return null;
  const signature = (n.type === 'legacy' ? { r: n.r, s: n.s, v: n.v } : { r: n.r, s: n.s, yParity: n.yParity }) as Signature;
  let raw: Hex;
  try {
    raw = serializeTransaction({ ...tx, data: n.input ?? '0x' } as unknown as TransactionSerializable, signature);
  } catch {
    return null;
  }
  return keccak256(raw).toLowerCase() === hash.toLowerCase() ? raw : null;
}
