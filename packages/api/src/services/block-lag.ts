/**
 * Reads pinned to a block number on a load-balanced RPC (fix-cfo-load). A public endpoint such as Sepolia's publicnode
 * answers each call from any of its backends, and they do not see a new block at the same moment: the API reads the
 * head from one backend, then asks another for that block, which answers "not found" for a second or two. Live log,
 * 19 Oct: `BlockNotFoundError: Block at number "11946073" could not be found.` and a 502 on GET /api/cfo.
 *
 * So a read pinned to a block retries ONCE, after BLOCK_LAG_RETRY_MS, when its error says the block is unknown
 * (isBlockLagError). Any other error, or a second failure, propagates: the callers fail closed as before. Reading at a
 * lag (head − n) was not chosen: on Anvil every transaction mines its own block, so a lagged read would miss the
 * newest payment, and the report cache is keyed by the head block's hash.
 */

/** The wait before the one retry: a lagging backend catches up within about a second. */
export const BLOCK_LAG_RETRY_MS = 1_000;
/** viem errors thrown when a node does not know a block (or a transaction in it) yet. */
const LAG_ERROR_NAMES: ReadonlySet<string> = new Set(["BlockNotFoundError", "TransactionNotFoundError", "TransactionReceiptNotFoundError"]);
/** Node messages for a block it has not seen: geth / reth "header not found", erigon / nethermind "unknown block". */
const LAG_DETAILS = /\b(?:header not found|unknown block|block not found)\b/i;
/** How deep the cause chain is followed (viem wraps an RPC error two or three times). */
const MAX_CAUSE_DEPTH = 8;

export interface BlockLagOptions {
  /** Default BLOCK_LAG_RETRY_MS. */
  readonly delayMs?: number;
  /** Default: a timer. Tests pass one that does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once, before the retry, with the error that caused it. */
  readonly onRetry?: (error: unknown) => void;
}

const texts = (e: Error): readonly unknown[] => [e.message, (e as { details?: unknown }).details, (e as { shortMessage?: unknown }).shortMessage];

/** True when `error` (or one of its causes) says the node has not seen the block it was asked about. */
export function isBlockLagError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let e: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && e instanceof Error && !seen.has(e); depth += 1) {
    seen.add(e);
    if (LAG_ERROR_NAMES.has(e.name)) return true;
    if (texts(e).some((t) => typeof t === "string" && LAG_DETAILS.test(t))) return true;
    e = e.cause;
  }
  return false;
}

const timer = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `read()`, and once more after a short wait when it failed with a block-lag error. At most two attempts. */
export async function retryOnBlockLag<T>(read: () => Promise<T>, o: BlockLagOptions = {}): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if (!isBlockLagError(error)) throw error;
    o.onRetry?.(error);
    await (o.sleep ?? timer)(o.delayMs ?? BLOCK_LAG_RETRY_MS);
    return read();
  }
}

/** A short, secret-free description of a lag error for the log (its name, not the RPC URL in viem's message). */
export const lagErrorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
