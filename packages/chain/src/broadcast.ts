/**
 * `eth_sendRawTransaction` of already-signed bytes, with the node's replies classified (§12.3). Used for
 * stored rows (sender.ts, recovery.ts) and for the no-op cancels that fill nonce holes (nonces.ts), so a
 * re-send after a crash is never mistaken for a failure.
 */
import { keccak256, type Hex } from 'viem';
import { errorText, redactError } from './errors';

/** The `eth_sendRawTransaction` call; a viem PublicClient satisfies it. */
export interface RawTxSender {
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

export type BroadcastStatus = 'sent' | 'already_known' | 'nonce_consumed';

export interface BroadcastResult {
  readonly status: BroadcastStatus;
  /** keccak256(raw), computed locally. */
  readonly txHash: Hex;
}

const ALREADY_KNOWN_RE = /already known|already imported|known transaction|transaction already exists|alreadyknown/i;
const NONCE_CONSUMED_RE = /nonce too low|nonce has already been used|noncetoolow|old nonce|oldnonce/i;
const REPLACEMENT_UNDERPRICED_RE = /replacement transaction underpriced|replacement fee too low|replacementnotallowed/i;

/**
 * `eth_sendRawTransaction` of stored bytes. "already known" counts as success; "nonce too low" is reported
 * as `nonce_consumed` (the caller checks the receipt: it may be this very tx, already mined). Any other
 * error is rethrown, redacted when it carries a URL (errors.ts; the original is its `cause`).
 */
export async function broadcast(client: RawTxSender, rawTx: Hex): Promise<BroadcastResult> {
  const txHash = keccak256(rawTx);
  try {
    await client.sendRawTransaction({ serializedTransaction: rawTx });
    return { status: 'sent', txHash };
  } catch (error: unknown) {
    const text = errorText(error);
    if (ALREADY_KNOWN_RE.test(text)) return { status: 'already_known', txHash };
    if (NONCE_CONSUMED_RE.test(text)) return { status: 'nonce_consumed', txHash };
    throw redactError(error);
  }
}

/** True when the node refused a tx because another one at the same nonce, with similar fees, is pending. */
export function isReplacementUnderpriced(error: unknown): boolean {
  return REPLACEMENT_UNDERPRICED_RE.test(errorText(error));
}
