/**
 * `pnpm --filter @hogee/redteam fisco:anchor <command>`: the TypeScript half of scripts/fisco/anchor.sh (P1 runs it;
 * this file never signs and never sends: `cast mktx` signs and `cast publish` sends, in anchor.sh).
 *   text      --pack <dir>                prints the anchor text and its calldata (the text's ASCII bytes, 0x-hex);
 *   check-raw --pack <dir> --raw <file> --nonce <n>
 *                                         checks a signed tx offline before it is published: chain 11155111,
 *                                         signer, to = itself, value 0, input = this pack's text, EIP-1559 within
 *                                         the send limits (gas ≤ 60,000, max fee ≤ 50 gwei, max priority fee ≤ 2 gwei)
 *                                         and at nonce <n> (the one anchor.sh read with `cast nonce`);
 *   capture   --pack <dir> --raw <file>   after `cast publish`: polls the receipt (with a timeout), reads its block,
 *                                         writes evidence/fisco/anchors/<packId>.sepolia.json exclusively, prints the path.
 * `--signer <address>` (check-raw, capture) is for the test suite's throwaway key only: the default is ANCHOR_SIGNER,
 * the hogee-deployer, and `make verify-fisco` accepts no other.
 * capture reads the RPC URL from SEPOLIA_RPC_URL_CAPTURE (preferred: it keeps a provider key off argv) or `--rpc`, else
 * the public node; https only (plain http only on 127.0.0.1), no userinfo, no redirects (assertCaptureUrl, rpc.ts);
 * eth_chainId must be 11155111 before anything else is asked. The URL is never printed. Fail closed: the sidecar is
 * written only after checkSepoliaAnchor accepts it, never over an existing file or through a link.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { keccak256, parseTransaction, type Hex } from "viem";
import { RawReceipt } from "../../../../tools/verify-evidence/src/bundle";
import { parseSignedTx } from "../../../../tools/verify-evidence/src/crypto";
import { ANCHOR_CHAIN_ID, ANCHOR_FORMAT, ANCHOR_SIGNER, anchorCalldataOf, anchorTextOf, checkSepoliaAnchor, type AnchorSidecar } from "../../../../tools/verify-evidence/src/fisco/anchor";
import { anchorPathOf } from "../../../../tools/verify-evidence/src/fisco/anchor-file";
import { PACK_READ_CAPS } from "../../../../tools/verify-evidence/src/fisco/cli";
import { loadPack } from "../../../../tools/verify-evidence/src/fisco/load";
import type { ParsedPack } from "../../../../tools/verify-evidence/src/fisco/pack";
import { readBundleDir } from "../../../../tools/verify-evidence/src/read-dir";
import { GuardError, httpTransport, nodeText, Rpc, type Transport } from "./rpc";
import { assertCaptureUrl, SEPOLIA_URL_ENV } from "./sepolia-code";

export const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** A raw signed tx file: one 0x-hex line, far below this. */
const MAX_RAW_FILE_BYTES = 16 * 1024;
const RAW_RE = /^0x([0-9a-fA-F]{2})+$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_TIMEOUT_S = 300;
const NONCE_RE = /^(0|[1-9][0-9]{0,15})$/;
const GWEI = 1_000_000_000n;
/**
 * What anchor.sh sets itself (never the RPC): an EIP-1559 tx whose worst case is bounded. A self-send of the ~220-byte
 * text costs 21,000 + 40 gas per byte (EIP-7623's calldata floor), about 30,000, so 60,000 is a cap, not a target.
 */
export const SEND_LIMITS = { gas: 60_000n, maxFeePerGas: 50n * GWEI, maxPriorityFeePerGas: 2n * GWEI } as const;
const POLL_MS = 4_000;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface LoadedAnchorPack {
  readonly dir: string;
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly pack: ParsedPack;
  readonly text: string;
  readonly calldata: Hex;
}

/** Reads the pack without following links (verify-fisco's caps), loads it strictly and computes its anchor text. */
export function readAnchorPack(dir: string): LoadedAnchorPack {
  const read = readBundleDir(dir, PACK_READ_CAPS);
  if (read.refused.length > 0) throw new GuardError(`the pack has files that cannot be read safely: ${nodeText(read.refused.slice(0, 2).join("; "), 300)}`);
  const loaded = loadPack(read.files);
  if (!loaded.pack) throw new GuardError(`the pack does not load: ${nodeText(loaded.check.detail ?? "invalid", 300)}`);
  if (basename(dir) !== loaded.pack.pack.packId) throw new GuardError(`the pack folder is not named after its packId ${loaded.pack.pack.packId}`);
  const text = anchorTextOf(loaded.pack, read.files);
  return { dir, files: read.files as Readonly<Record<string, Uint8Array>>, pack: loaded.pack, text, calldata: anchorCalldataOf(text) };
}

/** A regular file (no link) of at most 16 KiB holding one raw signed tx as 0x-hex; returned lowercase. */
export function readRawFile(path: string): Hex {
  const st = lstatSync(path);
  if (!st.isFile() || st.size > MAX_RAW_FILE_BYTES) throw new GuardError("the --raw file is not a small regular file");
  const raw = readFileSync(path, "utf8").trim();
  if (!RAW_RE.test(raw)) throw new GuardError("the --raw file does not hold one 0x-hex signed tx");
  return raw.toLowerCase() as Hex;
}

/** The send limits (SEND_LIMITS), and the nonce read when one is given; GuardError otherwise. */
function checkSendLimits(full: ReturnType<typeof parseTransaction>, nonce: number | undefined): void {
  if (full.type !== "eip1559") throw new GuardError(`the signed tx is type ${full.type ?? "(none)"}, not EIP-1559`);
  const gas = full.gas ?? 0n;
  if (gas > SEND_LIMITS.gas) throw new GuardError(`the signed tx's gas limit ${gas} is over ${SEND_LIMITS.gas}`);
  const maxFee = full.maxFeePerGas ?? 0n;
  if (maxFee > SEND_LIMITS.maxFeePerGas) throw new GuardError(`the signed tx's max fee per gas ${maxFee} wei is over ${SEND_LIMITS.maxFeePerGas / GWEI} gwei`);
  const tip = full.maxPriorityFeePerGas ?? 0n;
  if (tip > SEND_LIMITS.maxPriorityFeePerGas) throw new GuardError(`the signed tx's max priority fee per gas ${tip} wei is over ${SEND_LIMITS.maxPriorityFeePerGas / GWEI} gwei`);
  if (nonce !== undefined && (full.nonce ?? 0) !== nonce) throw new GuardError(`the signed tx has nonce ${full.nonce ?? 0}, not the ${nonce} read`);
}

/**
 * Throws unless `raw` is `signer`'s value-0 self-send on Sepolia carrying exactly `calldata`, an EIP-1559 tx within
 * SEND_LIMITS, at `nonce` when given; returns its hash, type and gas limit.
 */
export function checkRawTx(raw: Hex, calldata: Hex, signer: string, nonce?: number): { readonly hash: Hex; readonly type: string; readonly gas: bigint } {
  const tx = parseSignedTx(raw);
  if (typeof tx === "string") throw new GuardError(tx);
  if (tx.chainId !== ANCHOR_CHAIN_ID) throw new GuardError(`the signed tx is for chain ${tx.chainId ?? "(none)"}, not Sepolia (${ANCHOR_CHAIN_ID})`);
  if (tx.from.toLowerCase() !== signer.toLowerCase()) throw new GuardError(`the signed tx is from ${tx.from}, not ${signer.toLowerCase()}`);
  if (tx.to === null || tx.to.toLowerCase() !== tx.from.toLowerCase()) throw new GuardError("the signed tx is not sent to its own signer");
  if (tx.data.toLowerCase() !== calldata.toLowerCase()) throw new GuardError("the signed tx input is not this pack's anchor text");
  const full = parseTransaction(raw);
  if ((full.value ?? 0n) !== 0n) throw new GuardError("the signed tx moves value; an anchor moves none");
  checkSendLimits(full, nonce);
  return { hash: keccak256(raw), type: full.type ?? "", gas: full.gas ?? 0n };
}

export interface CaptureOptions {
  readonly signer?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls eth_getTransactionReceipt until it is served (or the timeout passes). */
async function receiptOf(rpc: Rpc, hash: Hex, o: CaptureOptions): Promise<Record<string, unknown>> {
  const now = o.now ?? (() => new Date());
  const deadline = now().getTime() + (o.timeoutMs ?? DEFAULT_TIMEOUT_S * 1000);
  for (;;) {
    const r = await rpc.receipt(hash);
    if (r !== null) return r;
    if (now().getTime() >= deadline) throw new GuardError(`no receipt for ${hash} before the timeout; re-run capture with the same --raw later`);
    await (o.sleep ?? wait)(o.pollMs ?? POLL_MS);
  }
}

const lstatOrNull = (path: string): ReturnType<typeof lstatSync> | null => {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
};

/** Creates <anchors>/ if needed (never through a link) and writes `text` to `path`, which must not exist. */
function writeSidecar(path: string, text: string): void {
  const folder = dirname(path);
  try {
    mkdirSync(folder);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  }
  const st = lstatSync(folder);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new GuardError(`${folder} is not a real folder; refusing to write`);
  let fd: number;
  try {
    fd = openSync(path, NEW_FILE, 0o644);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "EEXIST") throw new GuardError(`${path} already exists; refusing to overwrite`);
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new GuardError(`${path} is not a regular file`);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/**
 * After `cast publish`: chain id first, then the receipt (status 1) and its block; the sidecar is checked with
 * checkSepoliaAnchor before it is written. Returns the path written.
 */
export async function captureAnchor(rpc: Rpc, p: LoadedAnchorPack, raw: Hex, o: CaptureOptions = {}): Promise<{ readonly path: string; readonly sidecar: AnchorSidecar }> {
  const signer = o.signer ?? ANCHOR_SIGNER;
  const { hash } = checkRawTx(raw, p.calldata, signer);
  const path = anchorPathOf(p.dir, p.pack.pack.packId);
  if (lstatOrNull(path) !== null) throw new GuardError(`${path} already exists; refusing to overwrite`);
  const chainId = await rpc.chainId();
  if (chainId !== ANCHOR_CHAIN_ID) throw new GuardError(`the RPC serves chain ${chainId}, not Sepolia (${ANCHOR_CHAIN_ID}); refused`);
  const served = RawReceipt.safeParse(await receiptOf(rpc, hash, o));
  if (!served.success) throw new GuardError("the served receipt does not match the receipt schema");
  const receipt = served.data;
  if (receipt.status !== "0x1") throw new GuardError(`the anchor tx ${hash} is mined with status ${receipt.status}; not anchored`);
  const block = await rpc.block(Number(BigInt(receipt.blockNumber)));
  if (!block || typeof block.hash !== "string" || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new GuardError("the receipt's block is not served with the same hash (a reorg?); re-run capture later");
  const sidecar = {
    format: ANCHOR_FORMAT,
    packId: p.pack.pack.packId,
    text: p.text,
    txHash: hash,
    rawSignedTx: raw,
    receipt,
    block: { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp },
    capturedAt: (o.now ?? (() => new Date()))().toISOString(),
  } as AnchorSidecar;
  const text = `${JSON.stringify(sidecar, null, 2)}\n`;
  const check = checkSepoliaAnchor(p.files, text, { signer });
  if (!check.ok) throw new GuardError(`the captured sidecar does not check out: ${check.detail ?? "invalid"}`);
  writeSidecar(path, text);
  return { path, sidecar };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`missing ${flag} <value>`);
  return v;
}

function signerArg(argv: readonly string[]): string {
  const s = argValue(argv, "--signer") ?? ANCHOR_SIGNER;
  if (!ADDRESS_RE.test(s)) throw new GuardError("--signer must be a 0x address");
  return s;
}

type Print = (line: string) => void;

export async function anchorMain(
  argv: readonly string[],
  transport?: (url: string) => Transport,
  env: Readonly<Record<string, string | undefined>> = process.env,
  print: Print = (l) => process.stdout.write(`${l}\n`),
  o: CaptureOptions = {},
): Promise<void> {
  const [command, ...rest] = argv;
  const packDir = argValue(rest, "--pack");
  if (!packDir || !["text", "check-raw", "capture"].includes(command ?? "")) throw new Error("usage: fisco:anchor text|check-raw|capture --pack <dir> [--raw <file>] [--nonce <n>] [--signer <address>]");
  const p = readAnchorPack(packDir);
  if (command === "text") {
    print(`text: ${p.text}`);
    print(`calldata: ${p.calldata}`);
    return;
  }
  const rawPath = argValue(rest, "--raw");
  if (!rawPath) throw new Error("missing --raw <file>");
  const raw = readRawFile(rawPath);
  const signer = signerArg(rest);
  if (signer.toLowerCase() !== ANCHOR_SIGNER.toLowerCase()) process.stderr.write(`note: --signer is not the hogee-deployer; make verify-fisco will not accept this anchor\n`);
  if (command === "check-raw") {
    const nonce = argValue(rest, "--nonce");
    if (nonce === undefined) throw new GuardError("check-raw needs --nonce <n> (the nonce read before signing)");
    if (!NONCE_RE.test(nonce)) throw new GuardError("--nonce must be a whole number without leading zeros");
    const { hash, type, gas } = checkRawTx(raw, p.calldata, signer, Number(nonce));
    print(`ok: ${type} tx ${hash} by ${signer.toLowerCase()} to itself on chain ${ANCHOR_CHAIN_ID}, value 0, input = the anchor text, nonce ${nonce}, gas limit ${gas}, fee caps within the send limits`);
    return;
  }
  const fromEnv = env[SEPOLIA_URL_ENV];
  const url = fromEnv !== undefined && fromEnv !== "" ? fromEnv : (argValue(rest, "--rpc") ?? DEFAULT_SEPOLIA_RPC);
  assertCaptureUrl(url);
  const timeout = argValue(rest, "--timeout");
  if (timeout !== undefined && !/^[1-9][0-9]{0,4}$/.test(timeout)) throw new GuardError("--timeout must be whole seconds (1-99999)");
  const rpc = new Rpc((transport ?? httpTransport)(url));
  const { path, sidecar } = await captureAnchor(rpc, p, raw, { ...o, signer, ...(timeout ? { timeoutMs: Number(timeout) * 1000 } : {}) });
  print(`anchored: Sepolia block ${BigInt(sidecar.block.number)}, tx ${sidecar.txHash}`);
  print(`sidecar: ${path}`);
}

const isMain = process.argv[1]?.endsWith("fisco/anchor.ts") === true;
if (isMain) {
  anchorMain(process.argv.slice(2)).catch((error: unknown) => {
    // The message never carries the URL: the transport and guards above leave it out.
    process.stderr.write(`fisco:anchor failed: ${error instanceof Error ? `${error.name}: ${nodeText(error.message, 500)}` : "error"}\n`);
    process.exit(1);
  });
}
