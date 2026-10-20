/**
 * Fixtures for the Sepolia anchor tests: a pack that LOADS under the current schema (the shared fixture of
 * ./fixture-steps.ts, lifted to pack format 2 field by field when it is still at format 1, so these tests do not wait
 * for the v2 fixture; once that fixture is v2 it is used as is), and a sidecar signed by a fixed test key (never the
 * hogee-deployer: the checker is told to accept the test key through its test-only `signer` option).
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak256, parseTransaction, serializeTransaction, toHex, type Hex, type TransactionSerializable } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { anchorCalldataOf, anchorTextOf, ANCHOR_FORMAT } from "../../src/fisco/anchor";
import { loadPack } from "../../src/fisco/load";
import { FISCO_FORMAT, packIdOf } from "../../src/fisco/pack";
import { buildPack } from "./fixture-steps";
import { reindex, type Files } from "./tamper";

export const ANCHOR_KEY: PrivateKeyAccount = privateKeyToAccount(`0x${"a1".repeat(32)}`);
export const OTHER_KEY: PrivateKeyAccount = privateKeyToAccount(`0x${"a2".repeat(32)}`);
export const SIGNER = ANCHOR_KEY.address.toLowerCase();
const h = (label: string): Hex => keccak256(toHex(label));
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const REGULATOR = privateKeyToAccount(`0x${"88".repeat(32)}`).address.toLowerCase();

/** A format-1 pack lifted to format 2: only what loadPack's schemas need (no check beyond "pack files" is run). */
function liftToV2(files: Files): Files {
  const pack = JSON.parse(files["pack.json"] as string) as Record<string, unknown>;
  if (pack.format === FISCO_FORMAT) return files;
  const out: Files = { ...files };
  const core = { format: FISCO_FORMAT, createdAt: pack.createdAt, gitCommit: pack.gitCommit, sourceBundle: pack.sourceBundle } as Parameters<typeof packIdOf>[0];
  out["pack.json"] = json({ format: core.format, packId: packIdOf(core), createdAt: core.createdAt, gitCommit: core.gitCommit, sourceBundle: core.sourceBundle });
  const steps = JSON.parse(files["steps.json"] as string) as Record<string, unknown>;
  out["steps.json"] = json({ ...steps, format: FISCO_FORMAT });
  const chain = JSON.parse(files["chain.json"] as string) as { headAtEnd: number } & Record<string, unknown>;
  const headHashAtEnd = h(`head:${chain.headAtEnd}`);
  out["chain.json"] = json({
    ...chain,
    headHashAtEnd,
    auth: { check: true, admin: REGULATOR },
    observerNode: { index: 4, proposalTx: h("observer-proposal"), proposalBlock: 1, weight: 0, nodeIdKeccak: h("node4") },
  });
  const deployment = JSON.parse(files["deployment.json"] as string) as { roles: Record<string, string> } & Record<string, unknown>;
  out["deployment.json"] = json({ ...deployment, roles: { ...deployment.roles, regulator: REGULATOR } });
  for (const path of Object.keys(files).filter((p) => p.startsWith("txs/"))) out[path] = json({ ...JSON.parse(files[path] as string), native: null });
  out["ledger.json"] = json({
    node: "node4-observer",
    head: { number: chain.headAtEnd, hash: headHashAtEnd },
    blocks: [{ number: 0, hash: h("genesis"), parentHash: `0x${"0".repeat(64)}`, timestamp: 0, txs: [] }],
    node0Keccak: h("node0"),
  });
  return reindex(out);
}

export interface AnchorPack {
  readonly files: Files;
  readonly packId: string;
  readonly text: string;
}

export async function anchorPack(): Promise<AnchorPack> {
  const files = liftToV2((await buildPack()).files);
  const loaded = loadPack(files);
  if (!loaded.pack) throw new Error(`the anchor fixture pack does not load: ${loaded.check.detail ?? ""}`);
  return { files, packId: loaded.pack.pack.packId, text: anchorTextOf(loaded.pack, files) };
}

export const BLOCK = { number: "0x8a1b2c", hash: h("sepolia-block"), parentHash: h("sepolia-parent"), timestamp: "0x68f56a00" } as const;

export interface SidecarParts {
  readonly key?: PrivateKeyAccount;
  /** Edits the unsigned tx before signing (chain, to, value, data, type). */
  readonly tx?: (t: TransactionSerializable) => TransactionSerializable;
  /** Edits the sidecar object last (after txHash and receipt are derived). */
  readonly edit?: (s: Record<string, any>) => void;
}

/** A sidecar for `text`, as `fisco:anchor capture` writes it, signed by ANCHOR_KEY unless told otherwise. */
export async function sidecarOf(a: AnchorPack, o: SidecarParts = {}): Promise<string> {
  const key = o.key ?? ANCHOR_KEY;
  const base: TransactionSerializable = {
    type: "eip1559",
    chainId: 11_155_111,
    nonce: 7,
    to: key.address,
    value: 0n,
    data: anchorCalldataOf(a.text),
    gas: 30_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  };
  const raw = await key.signTransaction((o.tx ?? ((t) => t))(base) as never);
  const txHash = keccak256(raw);
  const from = key.address.toLowerCase();
  const sidecar: Record<string, any> = {
    format: ANCHOR_FORMAT,
    packId: a.packId,
    text: a.text,
    txHash,
    rawSignedTx: raw,
    receipt: {
      status: "0x1",
      cumulativeGasUsed: "0x1c9c38",
      logs: [],
      logsBloom: `0x${"0".repeat(512)}`,
      type: "0x2",
      transactionHash: txHash,
      transactionIndex: "0x3",
      blockHash: BLOCK.hash,
      blockNumber: BLOCK.number,
      gasUsed: "0x5ef4",
      effectiveGasPrice: "0x3b9aca01",
      from,
      to: from,
      contractAddress: null,
    },
    block: { ...BLOCK },
    capturedAt: "2026-10-20T08:00:00.000Z",
  };
  o.edit?.(sidecar);
  return json(sidecar);
}

/** The same signed tx with (r, n − s) and the other recovery bit (EIP-2's malleated twin): same signer, another hash. */
export function highSTwin(raw: Hex): Hex {
  const { r, s, v, yParity, ...unsigned } = parseTransaction(raw) as ReturnType<typeof parseTransaction> & { r: Hex; s: Hex; v?: bigint; yParity?: number };
  const flipped = toHex(secp256k1.CURVE.n - BigInt(s), { size: 32 });
  if (unsigned.type !== "legacy") return serializeTransaction(unsigned as TransactionSerializable, { r, s: flipped, yParity: yParity === 1 ? 0 : 1 });
  // v = 27 + bit, or chainId·2 + 35 + bit: an odd v carries bit 0.
  const twinV = (v as bigint) % 2n === 1n ? (v as bigint) + 1n : (v as bigint) - 1n;
  return serializeTransaction(unsigned as TransactionSerializable, { r, s: flipped, v: twinV });
}
