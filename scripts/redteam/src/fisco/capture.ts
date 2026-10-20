/**
 * What the pack records about the mirror besides the steps: chain.json (client, genesis facts incl. the auth check and
 * its admin, clock unit, P256 precompile, gas price, the head at the end and its hash, node4's observer proposal), the
 * deploy txs re-serialised from eth_getTransactionByHash (rawSource "rebuilt", each must hash to its tx hash, with its
 * native receipt), code/ (eth_getCode of the five contracts at one block) and artifacts.json (forge out/).
 * Every reader fails closed; nothing here sends.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, serializeTransaction, type Hex } from "viem";
import {
  ArtifactsFile,
  CODE_NAMES,
  CodeMeta,
  FISCO_CHAIN_ID,
  TxFile,
  type ChainFile,
  type CodeName,
  type DeployedName,
} from "../../../../tools/verify-evidence/src/fisco/pack";
import { JsonRpcError, nodeText, type Rpc } from "./rpc";
import type { StepRunner } from "./runner";

export class CaptureError extends Error {
  override readonly name = "CaptureError";
}

const MS_CLOCK_THRESHOLD = 1_000_000_000_000n;
const P256_PRECOMPILE = "0x0000000000000000000000000000000000000100";

export interface GenesisFacts {
  readonly consensus: string;
  readonly sealerCount: number;
  readonly features: Record<string, number>;
  readonly txGasLimit?: string;
  /** [executor] is_auth_check and auth_admin_account (lowercase; null when absent). */
  readonly auth: { readonly check: boolean; readonly admin: Hex | null };
}

/** chain.json as known before the first send; the end fields come from `withHeadAtEnd`. */
export type ChainStart = Omit<ChainFile, "headHashAtEnd" | "observerNode">;
export type ChainEnd = Pick<ChainFile, "headAtEnd" | "headHashAtEnd" | "observerNode">;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The facts chain.json needs from a FISCO config.genesis (INI): consensus type, sealer entries, [features], tx gas
 * limit, and [executor] is_auth_check / auth_admin_account (never node ids).
 */
export function parseGenesis(text: string): GenesisFacts {
  let section = "";
  let consensus = "";
  let sealerCount = 0;
  let txGasLimit: string | undefined;
  let authCheck = false;
  let authAdmin: Hex | null = null;
  const features: Record<string, number> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[;#].*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      continue;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] as string).trim();
    const value = (kv[2] as string).trim();
    if (section === "consensus" && key === "consensus_type") consensus = value;
    if (section === "consensus" && /^node\.[0-9]+$/.test(key)) sealerCount += 1;
    if (section === "tx" && key === "gas_limit" && /^[0-9]+$/.test(value)) txGasLimit = value;
    if (section === "executor" && key === "is_auth_check") authCheck = value === "true";
    if (section === "executor" && key === "auth_admin_account") {
      if (!ADDRESS_RE.test(value)) throw new CaptureError("genesis auth_admin_account is not an address");
      authAdmin = value.toLowerCase() as Hex;
    }
    if (section === "features" && /^[a-z0-9_]{1,64}$/.test(key)) {
      if (value !== "0" && value !== "1") throw new CaptureError(`genesis feature ${key} = ${value} (expected 0 or 1)`);
      features[key] = Number(value);
    }
  }
  if (!consensus || sealerCount === 0) throw new CaptureError("the genesis names no consensus type or no sealer");
  return { consensus, sealerCount, features, ...(txGasLimit ? { txGasLimit } : {}), auth: { check: authCheck, admin: authAdmin } };
}

/** Whether 0x100 verifies a fresh, valid P-256 signature (RIP-7212 / EIP-7951 input layout). */
export async function p256PrecompilePresent(rpc: Rpc): Promise<boolean> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const message = Buffer.from("hogee fisco-mirror p256 probe");
  const rs = sign("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" });
  const jwk = publicKey.export({ format: "jwk" });
  const xy = Buffer.concat([Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]);
  const input = `0x${Buffer.concat([createHash("sha256").update(message).digest(), rs, xy]).toString("hex")}` as Hex;
  try {
    const out = await rpc.call({ to: P256_PRECOMPILE, data: input });
    return BigInt(out === "0x" ? 0 : out) === 1n;
  } catch (error: unknown) {
    if (error instanceof JsonRpcError) return false;
    throw error;
  }
}

/**
 * chain.json before the first send (the end fields filled in by `withHeadAtEnd`). gasPrice "0x0" is the price every tx
 * in the pack paid as served (`txs`), not eth_gasPrice: what the node suggests is not what the mirror's txs carry. The
 * genesis must run with auth checks on and name an admin (the regulator); anything else stops before the first send.
 */
export async function chainFile(rpc: Rpc, genesis: GenesisFacts, nodeCount: number, headAtStart: number): Promise<ChainStart> {
  if (!genesis.auth.check || !genesis.auth.admin) throw new CaptureError("the genesis does not run with is_auth_check=true and an auth_admin_account");
  const [clientVersion, chainId, latest] = await Promise.all([rpc.request<string>("web3_clientVersion"), rpc.chainId(), rpc.block("latest")]);
  if (chainId !== FISCO_CHAIN_ID) throw new CaptureError(`chain ${chainId} is not the mirror`);
  if (!latest || typeof latest.timestamp !== "string" || BigInt(latest.timestamp) >= MS_CLOCK_THRESHOLD) throw new CaptureError("the block timestamp is not in seconds");
  if (nodeCount < genesis.sealerCount) throw new CaptureError(`${nodeCount} nodes but ${genesis.sealerCount} sealers`);
  return {
    // Node-chosen free text in a published file: control and format characters replaced.
    clientVersion: nodeText(String(clientVersion), 200),
    chainId: FISCO_CHAIN_ID,
    nodeCount,
    sealerCount: genesis.sealerCount,
    observerCount: nodeCount - genesis.sealerCount,
    consensus: nodeText(genesis.consensus, 40),
    genesis: { features: genesis.features, ...(genesis.txGasLimit ? { txGasLimit: genesis.txGasLimit } : {}) },
    evm: { timestampUnit: "seconds", p256At0x100: await p256PrecompilePresent(rpc) },
    txType: "legacy",
    gasPrice: "0x0",
    headAtStart,
    headAtEnd: headAtStart,
    auth: { check: true, admin: genesis.auth.admin },
  };
}

/**
 * The final chain.json: the head after the last step and its hash, node4's observer proposal (ledger.ts), once every
 * tx is known to be legacy at gas price 0.
 */
export function withHeadAtEnd(c: ChainStart, end: ChainEnd, txs: readonly TxFile[]): ChainFile {
  const { headAtEnd } = end;
  for (const t of txs) {
    if (!t.tx) continue;
    const served = t.tx as Record<string, unknown>;
    if (served.gasPrice !== undefined && BigInt(String(served.gasPrice)) !== 0n) throw new CaptureError(`tx ${t.hash} paid gas price ${String(served.gasPrice)}, not 0`);
    if (served.type !== undefined && served.type !== "0x0") throw new CaptureError(`tx ${t.hash} is type ${String(served.type)}, not legacy`);
  }
  if (headAtEnd < c.headAtStart) throw new CaptureError("the head moved backwards");
  return { ...c, headAtEnd, headHashAtEnd: end.headHashAtEnd.toLowerCase(), observerNode: end.observerNode };
}

interface BroadcastTx {
  readonly hash: string;
  readonly contractName: string | null;
  readonly contractAddress: string | null;
  readonly transactionType: string;
  readonly arguments: readonly string[] | null;
  readonly transaction: { readonly from: string };
}

/** The CREATE txs of a DeployFinal broadcast run JSON, by contract name. */
export function broadcastCreates(json: unknown): Map<DeployedName, BroadcastTx> {
  const txs = (json as { transactions?: unknown }).transactions;
  if (!Array.isArray(txs)) throw new CaptureError("the broadcast file has no transactions");
  const out = new Map<DeployedName, BroadcastTx>();
  for (const t of txs as BroadcastTx[]) {
    if (t.transactionType !== "CREATE") continue;
    const name = t.contractName as DeployedName;
    if (!["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle"].includes(name) || out.has(name)) throw new CaptureError(`unexpected CREATE of ${String(t.contractName)} in the broadcast`);
    out.set(name, t);
  }
  if (out.size !== 4) throw new CaptureError(`the broadcast holds ${out.size} of the 4 final-2 CREATE txs`);
  return out;
}

/**
 * The signed legacy deploy tx as served, re-serialised. A field the node leaves out where Ethereum would serve a zero
 * (value, gasPrice) is taken as zero, and `data` stands in for `input`: either way keccak256 of the result must equal
 * the tx hash, so a wrong guess fails closed. FISCO 3.17.1 serves `v` as the bare y-parity (0 or 1) even for an
 * EIP-155 tx; it is read as 27 + parity, which viem re-encodes as the EIP-155 v for chain 20200.
 */
export function rebuildLegacy(tx: Record<string, unknown>): Hex {
  const q = (k: string, fallback?: bigint): bigint => {
    const v = tx[k];
    if (v === undefined && fallback !== undefined) return fallback;
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]*$/.test(v)) throw new CaptureError(`the served tx has no ${k}`);
    return v === "0x" ? 0n : BigInt(v);
  };
  if (tx.type !== undefined && tx.type !== "0x0") throw new CaptureError(`deploy tx ${String(tx.hash)} is type ${String(tx.type)}, not legacy`);
  const data = (tx.input ?? tx.data) as Hex | undefined;
  if (typeof data !== "string") throw new CaptureError("the served tx has no input");
  const servedV = q("v");
  const v = servedV === 0n || servedV === 1n ? 27n + servedV : servedV;
  const raw = serializeTransaction(
    { type: "legacy", chainId: FISCO_CHAIN_ID, nonce: Number(q("nonce")), gasPrice: q("gasPrice", 0n), gas: q("gas"), value: q("value", 0n), data, ...(tx.to ? { to: tx.to as Hex } : {}) },
    { r: tx.r as Hex, s: tx.s as Hex, v },
  );
  if (keccak256(raw) !== String(tx.hash).toLowerCase()) throw new CaptureError(`the rebuilt deploy tx does not hash to ${String(tx.hash)}`);
  return raw;
}

/** txs/<hash>.json of the four deploy txs (rebuilt raw bytes, as served tx/receipt, block, native receipt). */
export async function deployTxFiles(rpc: Rpc, runner: StepRunner, creates: Map<DeployedName, BroadcastTx>, addresses: Readonly<Record<DeployedName, Hex>>): Promise<TxFile[]> {
  const out: TxFile[] = [];
  for (const [name, b] of creates) {
    if (b.contractAddress?.toLowerCase() !== addresses[name]) throw new CaptureError(`${name}: the broadcast's address is not the deployment's`);
    const hash = b.hash.toLowerCase() as Hex;
    const [tx, receipt] = await Promise.all([rpc.tx(hash), rpc.receipt(hash)]);
    if (!tx || !receipt) throw new CaptureError(`${name}: deploy tx ${hash} is not served`);
    if (receipt.status !== "0x1" || String(receipt.contractAddress).toLowerCase() !== addresses[name]) throw new CaptureError(`${name}: deploy receipt is not a successful CREATE of ${addresses[name]}`);
    // Schema-checked before the first send: a served shape the pack refuses (e.g. zero-padded quantities) stops the
    // run while the mirror is still untouched.
    out.push(TxFile.parse({ hash, rawSignedTx: rebuildLegacy(tx).toLowerCase(), rawSource: "rebuilt", tx, receipt, block: await runner.blockOf(receipt), native: await runner.nativeReceipt(hash, receipt) }));
  }
  return out;
}

/** eth_getCode of the five contracts at one block. */
export async function captureCode(rpc: Rpc, addresses: Readonly<Record<CodeName, Hex>>, chainId: number, now: Date = new Date()): Promise<{ meta: CodeMeta; hex: Map<CodeName, string> }> {
  const head = await rpc.block("latest");
  if (!head || typeof head.number !== "string" || typeof head.hash !== "string") throw new CaptureError("the latest block is not served");
  const blockNumber = Number(BigInt(head.number));
  const hex = new Map<CodeName, string>();
  for (const name of CODE_NAMES) {
    const code = (await rpc.code(addresses[name], blockNumber)).toLowerCase();
    if (!/^0x([0-9a-f]{2})+$/.test(code)) throw new CaptureError(`${name} has no code at block ${blockNumber}`);
    hex.set(name, code);
  }
  return { meta: CodeMeta.parse({ chainId, blockNumber, blockHash: head.hash.toLowerCase(), capturedAt: now.toISOString(), addresses }), hex };
}

/** code-sepolia/ as fisco:sepolia-code wrote it: `dir` is that folder or the --out folder holding it. */
export function readCodeDir(given: string): { meta: CodeMeta; hex: Map<CodeName, string> } {
  const dir = existsSync(join(given, "meta.json")) ? given : join(given, "code-sepolia");
  const meta = CodeMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")));
  const hex = new Map<CodeName, string>();
  for (const name of CODE_NAMES) {
    const text = readFileSync(join(dir, `${name}.hex`), "utf8").trim();
    if (!/^0x([0-9a-f]{2})+$/.test(text)) throw new CaptureError(`${dir}/${name}.hex is not lowercase hex code`);
    hex.set(name, text);
  }
  return { meta, hex };
}

interface ForgeArtifact {
  bytecode: { object: string };
  deployedBytecode: { object: string; immutableReferences?: Record<string, { start: number; length: number }[]> };
  metadata: { compiler: { version: string }; settings: { evmVersion: string; optimizer: { enabled: boolean; runs: number } } };
}

/** artifacts.json from forge's out/ (the five contracts; one compiler, EVM version and optimizer setting). */
export function readArtifacts(outDir: string): ArtifactsFile {
  const arts = CODE_NAMES.map((name) => [name, JSON.parse(readFileSync(join(outDir, `${name}.sol`, `${name}.json`), "utf8")) as ForgeArtifact] as const);
  const first = (arts[0] as (typeof arts)[number])[1].metadata;
  for (const [name, a] of arts) {
    const m = a.metadata;
    if (m.compiler.version !== first.compiler.version || m.settings.evmVersion !== first.settings.evmVersion || JSON.stringify(m.settings.optimizer) !== JSON.stringify(first.settings.optimizer)) {
      throw new CaptureError(`${name} was built with other compiler settings than ${(arts[0] as (typeof arts)[number])[0]}`);
    }
  }
  return ArtifactsFile.parse({
    solc: first.compiler.version,
    evmVersion: first.settings.evmVersion,
    optimizer: { enabled: first.settings.optimizer.enabled, runs: first.settings.optimizer.runs },
    contracts: Object.fromEntries(
      arts.map(([name, a]) => [name, { bytecode: a.bytecode.object.toLowerCase(), deployedBytecode: a.deployedBytecode.object.toLowerCase(), immutableReferences: a.deployedBytecode.immutableReferences ?? {} }]),
    ),
  });
}
