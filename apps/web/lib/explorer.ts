/**
 * Block-explorer links, pinned by chain id exactly as tools/verify-evidence pins them (G0-DECISIONS §16 M5, §18 L2):
 * Sepolia → Etherscan, every other chain (Anvil included) → no link. A link is never taken from a bundle row's
 * `explorerUrl`, a manifest's `verifiedUrl`, the API or an env var, so a tampered bundle can't send a judge to a
 * lookalike site or to another real transaction. A value that isn't a well-formed hash or address gets no link.
 *
 * Kept here rather than imported from @hogee/verify-evidence so every page that shows a hash doesn't pull in the
 * verifier; explorer.test.ts holds the two to the same map and the same URLs.
 */
import type { ApiMode } from "@hogee/core";

export const PINNED_EXPLORERS: Readonly<Record<number, string>> = { 11_155_111: "https://sepolia.etherscan.io" };

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The explorer pinned for a chain, or null (a local chain, an unknown chain, or no chain id). */
export function explorerOf(chainId: number | null | undefined): string | null {
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || !Object.hasOwn(PINNED_EXPLORERS, chainId)) return null;
  return PINNED_EXPLORERS[chainId] ?? null;
}

/** `<explorer>/tx/<hash>` (lowercase hex), or null when the chain has no explorer or the hash is malformed. */
export function txUrl(chainId: number | null | undefined, hash: string): string | null {
  const base = explorerOf(chainId);
  return base && TX_HASH.test(hash) ? `${base}/tx/${hash.toLowerCase()}` : null;
}

/** `<explorer>/address/<address>#code` (lowercase hex), or null when the chain has no explorer or the address is malformed. */
export function addressUrl(chainId: number | null | undefined, address: string): string | null {
  const base = explorerOf(chainId);
  return base && ADDRESS.test(address) ? `${base}/address/${address.toLowerCase()}#code` : null;
}

/** `<explorer>/block/<number>`, or null when the chain has no explorer or the number is not a block number. */
export function blockUrl(chainId: number | null | undefined, blockNumber: number): string | null {
  const base = explorerOf(chainId);
  return base && Number.isSafeInteger(blockNumber) && blockNumber >= 0 ? `${base}/block/${blockNumber}` : null;
}

/**
 * How a transaction hash is shown: an explorer link, or plain text with a `note` for its hover title and, for a
 * replay hash, a visible `tag`.
 */
export interface TxLink {
  readonly href: string | null;
  readonly note: string | null;
  readonly tag: string | null;
}

export interface TxLinkContext {
  /** The session's mode (undefined while the session loads). */
  readonly mode: ApiMode | undefined;
  readonly sessionChainId?: number | undefined;
  /** The chain an evidence bundle row records this hash on, for a hash taken from a bundle row. */
  readonly bundleChainId?: number | undefined;
}

const NO_EXPLORER = "no public website shows this blockchain";

/**
 * Where a transaction hash may link (run-9 critic gap 3). Live: the explorer pinned for the bundle row's chain, else
 * the session's. Replay: only a hash an evidence bundle row records (`bundleChainId`), because the offline demo mints
 * every other hash itself (deposits, signatures, payments), and such a hash must not look like a real transaction on
 * a public explorer. Mock, or no session yet: never.
 */
export function txLinkOf(hash: string, at: TxLinkContext): TxLink {
  if (at.mode === "live") {
    const href = txUrl(at.bundleChainId ?? at.sessionChainId, hash);
    return { href, note: href ? null : NO_EXPLORER, tag: null };
  }
  if (at.mode === "replay") {
    if (at.bundleChainId === undefined) return { href: null, note: "recording: made offline for this demo, not a real receipt", tag: "replay" };
    const href = txUrl(at.bundleChainId, hash);
    return { href, note: href ? null : NO_EXPLORER, tag: null };
  }
  return { href: null, note: "practice data: not on a blockchain", tag: null };
}

/** FISCO BCOS's Web3 chain id (the mirror's local chain, REG-BRIEF fisco-proof): named, never pinned to an explorer. */
const CHAIN_NAMES: Readonly<Record<number, string>> = { 11_155_111: "Sepolia", 31_337: "Anvil (local)", 20_200: "FISCO BCOS (local)" };

/** "Sepolia · 11155111", "Anvil (local) · 31337", "FISCO BCOS (local) · 20200" or "chain 5". */
export function chainLabel(chainId: number): string {
  const name = Object.hasOwn(CHAIN_NAMES, chainId) ? CHAIN_NAMES[chainId] : undefined;
  return name ? `${name} · ${chainId}` : `chain ${chainId}`;
}
