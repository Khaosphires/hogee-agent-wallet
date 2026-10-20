/**
 * `SEPOLIA_RPC_URL_CAPTURE=<url> pnpm --filter @hogee/redteam fisco:sepolia-code -- --out <dir>` (or `--rpc <url>`;
 * the environment variable wins and keeps a provider key off argv): read-only capture of the final-2 code on Sepolia
 * for the mirror pack's code-sepolia/ (P1 runs it; no key, no send). Fail closed:
 *   - the URL must be https, or plain http on 127.0.0.1 only, without userinfo (the capture authenticates neither the
 *     block nor the code, so the transport must); redirects are never followed (rpc.ts httpTransport);
 *   - eth_chainId must be 11155111 (an RPC of any other chain, mainnet included, is refused before any other call);
 *   - one pinned block: the governance address and every eth_getCode are read at the block number captured first;
 *   - each of the five addresses (packages/chain/deployments/sepolia-final-2.json + Treasury.governance()) must hold code;
 *   - <out>/code-sepolia must not exist: it is created by a non-recursive mkdir that fails on anything already there (a
 *     planted symlink included), and each file is created exclusively without following links.
 * Node answers are shape-checked before use (the head's number is a JSON-RPC quantity, governance() one 32-byte hex
 * word), and the failure line is cleaned with `nodeText`. The URL is never printed or written (a provider URL can
 * carry a key).
 */
import { closeSync, constants, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeployment } from "@hogee/chain";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { CODE_NAMES, CodeMeta, codePath, FINAL_2, SEPOLIA_CHAIN_ID, type CodeName } from "../../../../tools/verify-evidence/src/fisco/pack";
import { GuardError, httpTransport, LOOPBACK_HOST, nodeText, Rpc, type Transport } from "./rpc";

export const SEPOLIA_URL_ENV = "SEPOLIA_RPC_URL_CAPTURE";
const GOVERNANCE_ABI = parseAbi(["function governance() view returns (address)"]);
const CODE_RE = /^0x([0-9a-fA-F]{2})+$/;
/** A JSON-RPC quantity of at most 64 bits (no leading zeros). */
const QUANTITY_RE = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;
/** One ABI word (an address return). */
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const NEW_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Creates `path` (it must not exist; a symlink there is not followed) and writes `text`. */
function writeNewFile(path: string, text: string): void {
  const fd = openSync(path, NEW_FILE, 0o644);
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Creates `dir` itself (its parent may be created); fails if anything, a symlink included, is already there. */
function makeFreshDir(dir: string, parent: string): void {
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "EEXIST") throw new GuardError(`${dir} already exists; refusing to overwrite`);
    throw error;
  }
}

export interface CaptureResult {
  readonly meta: CodeMeta;
  readonly sizes: Readonly<Record<CodeName, number>>;
}

/** Reads the five final-2 codes at one block and writes <outDir>/code-sepolia/{<Name>.hex, meta.json}. */
export async function captureSepoliaCode(rpc: Rpc, outDir: string, now: Date = new Date()): Promise<CaptureResult> {
  const chainId = await rpc.chainId();
  if (chainId !== SEPOLIA_CHAIN_ID) throw new GuardError(`the RPC serves chain ${chainId}, not Sepolia (${SEPOLIA_CHAIN_ID}); refused`);
  const dir = join(outDir, "code-sepolia");
  if (existsSync(dir)) throw new GuardError(`${dir} already exists; refusing to overwrite`);
  const deployment = loadDeployment(FINAL_2.chainTag, FINAL_2.deploymentId);
  if (deployment.chainId !== SEPOLIA_CHAIN_ID) throw new GuardError("sepolia-final-2.json is not a Sepolia deployment");
  const head = await rpc.block("latest");
  if (!head || typeof head.number !== "string" || typeof head.hash !== "string") throw new GuardError("the latest block is not served");
  if (!QUANTITY_RE.test(head.number)) throw new GuardError("the latest block's number is not a JSON-RPC quantity; refused");
  const blockNumber = Number(BigInt(head.number));
  if (!Number.isSafeInteger(blockNumber)) throw new GuardError("the latest block's number is out of range; refused");
  const c = deployment.contracts;
  if (!c.MilestoneEscrow || !c.SalesOracle) throw new GuardError("sepolia-final-2.json lacks MilestoneEscrow or SalesOracle");
  const treasury = c.Treasury.address.toLowerCase() as Hex;
  const ret: unknown = await rpc.call({ to: treasury, data: encodeFunctionData({ abi: GOVERNANCE_ABI, functionName: "governance" }) }, blockNumber);
  if (typeof ret !== "string" || !WORD_RE.test(ret)) throw new GuardError("Treasury.governance() did not answer one 32-byte hex word; refused");
  const governance = (decodeFunctionResult({ abi: GOVERNANCE_ABI, functionName: "governance", data: ret as Hex }) as string).toLowerCase() as Hex;
  const addresses: Record<CodeName, Hex> = {
    PlanRegistry: c.PlanRegistry.address.toLowerCase() as Hex,
    Treasury: treasury,
    TreasuryGovernance: governance,
    MilestoneEscrow: c.MilestoneEscrow.address.toLowerCase() as Hex,
    SalesOracle: c.SalesOracle.address.toLowerCase() as Hex,
  };
  const codes = new Map<CodeName, string>();
  for (const name of CODE_NAMES) {
    const code = await rpc.code(addresses[name], blockNumber);
    if (typeof code !== "string" || !CODE_RE.test(code)) throw new Error(`${name} at ${addresses[name]} holds no code at block ${blockNumber}`);
    codes.set(name, code.toLowerCase());
  }
  const meta = CodeMeta.parse({ chainId, blockNumber, blockHash: head.hash.toLowerCase(), capturedAt: now.toISOString(), addresses });
  makeFreshDir(dir, outDir);
  for (const name of CODE_NAMES) writeNewFile(join(outDir, codePath(name, true)), `${codes.get(name) as string}\n`);
  writeNewFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  const sizes = Object.fromEntries(CODE_NAMES.map((n) => [n, ((codes.get(n) as string).length - 2) / 2])) as Record<CodeName, number>;
  return { meta, sizes };
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`missing ${flag} <value>`);
  return v;
}

/** https for any host; plain http only on 127.0.0.1 (a local relay); no userinfo. GuardError never echoes the URL. */
export function assertCaptureUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError("the Sepolia RPC URL does not parse");
  }
  if (u.username !== "" || u.password !== "") throw new GuardError("the Sepolia RPC URL must not carry userinfo");
  if (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === LOOPBACK_HOST)) return;
  throw new GuardError(`the Sepolia RPC URL must be https (plain http only on ${LOOPBACK_HOST})`);
}

export async function sepoliaCodeMain(argv: readonly string[], transport?: (url: string) => Transport, env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const fromEnv = env[SEPOLIA_URL_ENV];
  const url = fromEnv !== undefined && fromEnv !== "" ? fromEnv : argValue(argv, "--rpc");
  if (!url) throw new Error(`set ${SEPOLIA_URL_ENV} (preferred) or pass --rpc <url>`);
  const out = argValue(argv, "--out");
  if (!out) throw new Error("missing --out <value>");
  assertCaptureUrl(url);
  const rpc = new Rpc((transport ?? httpTransport)(url));
  const { meta, sizes } = await captureSepoliaCode(rpc, out);
  process.stdout.write(`code-sepolia captured at block ${meta.blockNumber} (${meta.blockHash}): ${CODE_NAMES.map((n) => `${n} ${sizes[n]} B`).join(", ")}\n`);
}

/** The one line printed on failure: the error's class and message, cleaned of control and bidi characters and clipped. */
export function failureLine(error: unknown): string {
  // The message never carries the URL (the transport and guards above leave it out), but it can carry a node's text.
  return `fisco:sepolia-code failed: ${error instanceof Error ? `${nodeText(error.name, 60)}: ${nodeText(error.message, 500)}` : "error"}`;
}

const isMain = process.argv[1]?.endsWith("sepolia-code.ts") === true;
if (isMain) {
  sepoliaCodeMain(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${failureLine(error)}\n`);
    process.exit(1);
  });
}
