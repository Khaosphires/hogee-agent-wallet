/** Tampering helpers for the FISCO pack tests: edit a file, swap a tx for a re-signed one, re-index hashes.json. */
import { keccak256, parseTransaction, serializeTransaction, type Hex, type TransactionSerializableLegacy } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { hashesFileOf } from "../../src/index";

export type Files = Record<string, string>;

/** Re-computes hashes.json (an attacker who also rewrites the hash index). */
export function reindex(files: Files): Files {
  const { "hashes.json": _old, ...rest } = files;
  return { ...rest, "hashes.json": hashesFileOf(rest) };
}

/** Edits one JSON file, then re-indexes. */
export function edit(files: Files, path: string, change: (v: any) => void): Files {
  const v = JSON.parse(files[path] as string) as unknown;
  change(v);
  return reindex({ ...files, [path]: `${JSON.stringify(v, null, 2)}\n` });
}

/** Replaces `from` with `to` in every path and body, then re-indexes. */
export function swap(files: Files, from: string, to: string): Files {
  const out: Files = {};
  for (const [p, b] of Object.entries(files)) out[p.replaceAll(from.toLowerCase(), to.toLowerCase())] = b.replaceAll(from, to).replaceAll(from.toLowerCase(), to.toLowerCase());
  return reindex(out);
}

export const txFile = (files: Files, hash: string): { rawSignedTx: Hex; tx: Record<string, unknown> | null } => JSON.parse(files[`txs/${hash.toLowerCase()}.json`] as string);

/**
 * Re-signs a step's tx with `signer` after `change` edits the legacy fields (data, chainId, type, …) and swaps it in
 * everywhere (hash, raw bytes): what a forger with the key could write.
 */
export async function resign(files: Files, hash: string, signer: PrivateKeyAccount, change: (tx: TransactionSerializableLegacy & Record<string, unknown>) => Record<string, unknown>): Promise<{ files: Files; hash: Hex }> {
  const old = txFile(files, hash).rawSignedTx;
  const parsed = parseTransaction(old) as TransactionSerializableLegacy & Record<string, unknown>;
  const { r: _r, s: _s, v: _v, yParity: _y, ...unsigned } = parsed as Record<string, unknown>;
  const raw = await signer.signTransaction(change(unsigned as never) as never);
  const next = keccak256(raw);
  return { files: swap(swap(files, old, raw), hash, next), hash: next };
}

export const serialize = serializeTransaction;
