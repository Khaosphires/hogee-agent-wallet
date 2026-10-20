/**
 * The anchor of a bundle: what a judge compares with the chain, because an offline verifier has no trust root of its
 * own (run-6 v-6). The deployment's contract addresses, the newest block (number and hash) in blocks.json, and every
 * tx hash the bundle shows mined. VERIFIED means internally consistent; the chain's agreement with this anchor (on
 * Sepolia Etherscan, or through `--rpc`, online.ts) is what makes it chain truth.
 */
import { explorerOf, type ParsedBundle } from "./bundle";
import { CONTRACT_NAMES } from "./summary";
import { quantity } from "./util";

export interface BundleAnchor {
  readonly chainId: number;
  readonly chainTag: string;
  readonly deploymentId: string;
  /** The explorer pinned for the chain (explorerOf), never the bundle's own: null on a local chain. */
  readonly explorer: string | null;
  /** Contract name → lowercase address. */
  readonly contracts: Readonly<Record<string, string>>;
  /** The newest block in blocks.json. */
  readonly head: { readonly number: number; readonly hash: string } | null;
  /** Every tx whose receipt the bundle holds, sorted. */
  readonly txHashes: readonly string[];
}

export function anchorOf(b: ParsedBundle): BundleAnchor {
  const contracts: Record<string, string> = {};
  for (const name of CONTRACT_NAMES) {
    const c = b.contracts.contracts[name];
    if (c) contracts[name] = c.address.toLowerCase();
  }
  let head: BundleAnchor["head"] = null;
  for (const block of b.blocks) {
    const n = quantity(block.number);
    if (n !== null && (head === null || n > BigInt(head.number))) head = { number: Number(n), hash: block.hash.toLowerCase() };
  }
  return {
    chainId: b.contracts.chainId,
    chainTag: b.contracts.chainTag,
    deploymentId: b.contracts.deploymentId,
    explorer: explorerOf(b.contracts.chainId),
    contracts,
    head,
    txHashes: [...b.receipts.keys()].sort(),
  };
}

/** The anchor as printed by the CLI (one item per line). */
export function anchorLines(a: BundleAnchor): string[] {
  const where = a.explorer ? `${a.explorer}` : `chain ${a.chainId}`;
  return [
    `Anchor (compare with ${where}):`,
    `  chain ${a.chainId} (${a.chainTag}), deployment ${a.deploymentId}`,
    ...Object.entries(a.contracts).map(([name, address]) => `  ${name.padEnd(15)} ${address}`),
    `  newest block    ${a.head ? `${a.head.number} ${a.head.hash}` : "(none)"}`,
    `  ${a.txHashes.length} transactions:`,
    ...a.txHashes.map((h) => `    ${a.explorer ? `${a.explorer}/tx/${h}` : h}`),
  ];
}
