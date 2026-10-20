/**
 * From scripts/redteam (replay.sh runs it this way, with node directly, never through pnpm):
 * `node --import tsx src/fisco/cli.ts --keys-fd 3 --rpc http://127.0.0.1:8545 --deployment <D>/deploy/fisco-final-2.json
 *    --broadcast <D>/deploy/run-*.json --genesis <D>/facts/config.genesis --nodes 5 --sepolia-code <dir>/code-sepolia
 *    --native-tls <D>/facts/sdk --ledger-rpc http://127.0.0.1:8546
 *    [--sepolia-bundle evidence/ev-74756ea61a72ae7c] [--artifacts contracts/out] [--out evidence/fisco] 3< <(…)`
 *
 * Replays final-2 plus the refusals and the regulator's stops on the local FISCO BCOS mirror and writes
 * evidence/fisco/fm-<16hex>/ (pack v2). The four FINAL role keys and the regulator's key arrive on the inherited
 * descriptor `--keys-fd` only (role-keys.ts: five `NAME=0x<hex>` lines, read once, then closed); there is no
 * environment fallback, and a key found in the environment stops the run. The FINAL keys go to the worker's own loader
 * as a plain object; nothing prints or writes any key (the pack is secret-scanned before it gets its name, the SDK
 * TLS key and node4's raw node id included). Before the first send: the regulator's address must be the genesis
 * auth_admin_account, node4's ledger RPC must answer chain 20200, and the native RPC must serve the deploy receipts.
 * Node-supplied text is cleaned of control characters before it is printed. Standalone: no Postgres, no API, no
 * config.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSigners } from "@hogee/worker";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { FINAL_2, FISCO_CHAIN_ID, FISCO_FORMAT, txPath, codePath, CODE_NAMES, PACK_FILES, type CodeName, type StepsFile } from "../../../../tools/verify-evidence/src/fisco/pack";
import { urlSecrets } from "../safety";
import { broadcastCreates, captureCode, chainFile, deployTxFiles, parseGenesis, readArtifacts, readCodeDir, withHeadAtEnd, type GenesisFacts } from "./capture";
import { dateGuard, describeExpiry } from "./date-guard";
import { checkDeployInputs, deployerOf, deploymentFile, parseDeployManifest, readSepoliaBroadcast, SEPOLIA_BROADCAST_FILE } from "./deployment";
import { captureLedger } from "./ledger";
import { httpsNativeTransport, NativeRpc, readNativeTls, tlsKeySecretForms } from "./native-rpc";
import { finalReads, preflightReads, Reader } from "./reads";
import { FiscoRpc, GuardError, LedgerRpc, nodeText } from "./rpc";
import { REGULATOR_KEY_NAME, readRoleKeysFd, refuseKeysInEnv, RoleKeysError, type RoleKeys } from "./role-keys";
import { DEFAULT_RUNNER_OPTIONS, StepRunner } from "./runner";
import { runScenario } from "./scenario";
import { keySecretForms, softFounder } from "./sign";
import { bundleFileHashes, readSepoliaBundle } from "./source";
import { jsonFile, writePack } from "./writer";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface ReplayArgs {
  /** The inherited descriptor carrying the four role keys and the regulator's (replay.sh: 3). */
  readonly keysFd: number;
  readonly rpc: string;
  /** chain-up.sh's snapshot of node0's SDK files (ca.crt, sdk.crt, sdk.key): the native RPC's TLS identity. */
  readonly nativeTls: string;
  /** node4's (the regulator's observer) Web3 RPC: http://127.0.0.1:8546 only. */
  readonly ledgerRpc: string;
  readonly deployment: string;
  readonly broadcast: string;
  readonly genesis: string;
  readonly nodes: number;
  readonly sepoliaCode: string;
  readonly sepoliaBundle: string;
  readonly artifacts: string;
  readonly out: string;
}

export function parseArgs(argv: readonly string[]): ReplayArgs {
  const get = (flag: string, fallback?: string): string => {
    const i = argv.indexOf(flag);
    const v = i >= 0 ? argv[i + 1] : fallback;
    if (!v || v.startsWith("--")) throw new Error(`missing ${flag} <value>`);
    return v;
  };
  // The mirror is 4 sealers + 1 observer (FISCO-BRIEF); --nodes only changes for another topology.
  const nodes = Number(get("--nodes", "5"));
  if (!Number.isInteger(nodes) || nodes < 1 || nodes > 16) throw new Error("--nodes must be 1-16");
  const keysFd = get("--keys-fd");
  if (!/^[0-9]{1,4}$/.test(keysFd) || Number(keysFd) < 3) throw new Error("--keys-fd must be a descriptor number of 3 or more");
  return {
    keysFd: Number(keysFd),
    rpc: get("--rpc"),
    nativeTls: get("--native-tls"),
    ledgerRpc: get("--ledger-rpc"),
    deployment: get("--deployment"),
    broadcast: get("--broadcast"),
    genesis: get("--genesis"),
    nodes,
    sepoliaCode: get("--sepolia-code"),
    sepoliaBundle: get("--sepolia-bundle", join(REPO_ROOT, "evidence", FINAL_2.runId)),
    artifacts: get("--artifacts", join(REPO_ROOT, "contracts", "out")),
    out: get("--out", join(REPO_ROOT, "evidence", "fisco")),
  };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const gitCommit = (): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
/** Lines can carry node-supplied text (probe errors): control characters never reach the terminal. */
const say = (line: string): void => void process.stdout.write(`${nodeText(line)}\n`);

/**
 * The five senders' addresses (lowercase). Throws (before the first send) unless they are five distinct keys and the
 * regulator is the genesis auth_admin_account: the chain's committee governor and auth admin is the account chain-up.sh
 * passed to build_chain.sh (`-a`), and only it can freeze, ban and lift.
 */
export function senderRoles(s: Readonly<Record<"lender" | "oracle" | "agent" | "relayer" | "regulator", { readonly address: string }>>, genesis: Pick<GenesisFacts, "auth">): Record<"lender" | "oracle" | "agent" | "relayer" | "regulator", Hex> {
  const roles = {
    lender: s.lender.address.toLowerCase() as Hex,
    oracle: s.oracle.address.toLowerCase() as Hex,
    agent: s.agent.address.toLowerCase() as Hex,
    relayer: s.relayer.address.toLowerCase() as Hex,
    regulator: s.regulator.address.toLowerCase() as Hex,
  };
  if (new Set(Object.values(roles)).size !== 5) throw new GuardError("the regulator's key is one of the FINAL role keys");
  if (!genesis.auth.check || genesis.auth.admin !== roles.regulator) throw new GuardError("the regulator key is not the genesis auth_admin_account of an auth-checking chain");
  return roles;
}

/**
 * privateKeyToAccount for the regulator's key, with its error replaced (as apps/worker/src/config/keys.ts does): a
 * 64-hex value outside the secp256k1 range (0, or at least the curve order) makes viem/noble throw a message quoting
 * the value. The RoleKeysError names the variable only and carries no `cause`.
 */
export function regulatorAccountOf(key: Hex): PrivateKeyAccount {
  try {
    return privateKeyToAccount(key);
  } catch {
    throw new RoleKeysError(`${REGULATOR_KEY_NAME} is not a valid secp256k1 private key`);
  }
}

/** Wait for node4 to reach node0's head after the last step. */
const LEDGER_WAIT = { timeoutMs: 120_000, pollMs: 500, sleep: DEFAULT_RUNNER_OPTIONS.sleep };

export async function replay(a: ReplayArgs, keys: RoleKeys): Promise<string> {
  const rpc = new FiscoRpc(a.rpc);
  await rpc.requireChain();
  const ledgerRpc = new LedgerRpc(a.ledgerRpc);
  if ((await ledgerRpc.chainId()) !== FISCO_CHAIN_ID) throw new GuardError(`node4's ledger RPC does not serve chain ${FISCO_CHAIN_ID}`);
  const tls = readNativeTls(a.nativeTls);
  const native = new NativeRpc(httpsNativeTransport(tls));
  const secrets = [...keySecretForms(Object.values(keys)), ...urlSecrets([a.rpc, a.ledgerRpc]), ...tlsKeySecretForms(tls)];
  const { [REGULATOR_KEY_NAME]: regulatorKey, ...finalKeys } = keys;
  // The worker's loader, given a plain object (never process.env); its scrub then only empties that object.
  const signers = loadSigners({ ...finalKeys }, "FINAL", { scrub: true });
  const regulator = regulatorAccountOf(regulatorKey);
  const founder = softFounder();
  secrets.push(...founder.secretForms());
  const src = readSepoliaBundle(a.sepoliaBundle);
  const earliest = dateGuard(src.manifest, BigInt(Math.floor(Date.now() / 1000)));
  const manifestJson = readJson(a.deployment);
  const broadcast = readJson(a.broadcast);
  const { contracts } = parseDeployManifest(manifestJson);
  const genesis = parseGenesis(readFileSync(a.genesis, "utf8"));
  const artifacts = readArtifacts(a.artifacts);
  const sepoliaCode = readCodeDir(a.sepoliaCode);
  const roles = senderRoles({ ...signers, regulator }, genesis);
  const deployer = deployerOf(broadcast);
  const reader = new Reader(rpc, contracts);
  const runner = new StepRunner(rpc, native, contracts, { lender: signers.lender, oracle: signers.oracle, agent: signers.agent, relayer: signers.relayer, regulator }, DEFAULT_RUNNER_OPTIONS);
  const chainAtStart = await chainFile(rpc, genesis, a.nodes, await rpc.blockNumber());
  // Everything that can be read and checked before the first send is: a capture problem must not cost a run.
  // One read: the bytes hashed into deployment.json and checked here are the bytes the pack stores.
  const sepoliaBroadcast = readSepoliaBroadcast(join(REPO_ROOT, SEPOLIA_BROADCAST_FILE));
  const sepoliaBroadcastBytes = sepoliaBroadcast.bytes;
  checkDeployInputs(broadcast, sepoliaBroadcastBytes);
  const deployTxs = await deployTxFiles(rpc, runner, broadcastCreates(broadcast), contracts);
  // A dry run of the ledger capture on the chain so far (the observer proposal, the deploys): node4's Web3 shape is
  // checked while the mirror is still untouched, not only after the last step.
  const startHead = await rpc.block(chainAtStart.headAtStart);
  if (!startHead || typeof startHead.hash !== "string") throw new GuardError(`block ${chainAtStart.headAtStart} is not served`);
  await captureLedger(rpc, ledgerRpc, { number: chainAtStart.headAtStart, hash: startHead.hash }, roles.regulator, LEDGER_WAIT);
  const preflight = await runner.snapshot(await preflightReads(rpc, reader, { lender: roles.lender, oracle: roles.oracle, earliestExpiry: describeExpiry(earliest) }));
  say(`preflight ok at block ${preflight.block}; replaying ${FINAL_2.deploymentId} on chain 20200`);
  const result = await runScenario({
    runner,
    reader,
    src,
    contracts,
    signers: { lender: signers.lender, agent: signers.agent, regulator },
    deployer,
    founder,
    nowSeconds: () => BigInt(Math.floor(Date.now() / 1000)),
    sleep: DEFAULT_RUNNER_OPTIONS.sleep,
    randomNonce: () => BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`),
  });
  for (const s of runner.steps) say(`  #${s.seq} ${s.id} ${s.outcome.kind}${s.probe.error ? ` (probe: ${s.probe.error})` : ""}`);
  const final = await runner.snapshot(await finalReads(reader, result.orderId, result.settlementIds, roles.agent));
  const headEnd = await rpc.blockNumber();
  const headBlock = await rpc.block(headEnd);
  if (!headBlock || typeof headBlock.hash !== "string") throw new GuardError(`block ${headEnd} is not served`);
  // node4's copy of blocks 0..headEnd, equal to node0's; then the raw node id it found joins the secret scan.
  const ledger = await captureLedger(rpc, ledgerRpc, { number: headEnd, hash: headBlock.hash }, roles.regulator, LEDGER_WAIT);
  secrets.push(ledger.observerNodeId);
  say(`ledger ok: node4 serves blocks 0..${headEnd}, the same as node0's (node0's digest recorded in ledger.json)`);
  const deployment = await deploymentFile({ manifestJson, broadcast, sepoliaBroadcastBytes, src, reader, roles });
  const code = await captureCode(rpc, { ...contracts, TreasuryGovernance: deployment.contracts.TreasuryGovernance.address as Hex } as Record<CodeName, Hex>, 20_200);
  const steps: StepsFile = { format: FISCO_FORMAT, preflight, steps: runner.steps, final };
  const allTxs = [...deployTxs, ...runner.txs.values()];
  const files = new Map<string, string>([
    [PACK_FILES.chain, jsonFile(withHeadAtEnd(chainAtStart, { headAtEnd: headEnd, headHashAtEnd: headBlock.hash, observerNode: ledger.observerNode }, allTxs))],
    [PACK_FILES.ledger, jsonFile(ledger.ledger)],
    [PACK_FILES.deployment, jsonFile(deployment)],
    [PACK_FILES.steps, jsonFile(steps)],
    [PACK_FILES.artifacts, jsonFile(artifacts)],
    [PACK_FILES.plan, jsonFile(result.plan)],
    [PACK_FILES.t28, jsonFile(result.t28)],
    [PACK_FILES.sepoliaBroadcast, sepoliaBroadcast.text],
    [PACK_FILES.codeMeta, jsonFile(code.meta)],
    [PACK_FILES.sepoliaCodeMeta, jsonFile(sepoliaCode.meta)],
    ...CODE_NAMES.map((n) => [codePath(n), `${code.hex.get(n) as string}\n`] as const),
    ...CODE_NAMES.map((n) => [codePath(n, true), `${sepoliaCode.hex.get(n) as string}\n`] as const),
    ...allTxs.map((t) => [txPath(t.hash), jsonFile(t)] as const),
  ]);
  const core = { format: FISCO_FORMAT, createdAt: new Date().toISOString(), gitCommit: gitCommit(), sourceBundle: { runId: FINAL_2.runId, files: bundleFileHashes(src) } };
  const { dir } = writePack(a.out, core, files, secrets);
  say(`pack written: ${dir}`);
  return dir;
}

/** The CLI: no role key in the environment, the arguments, then the keys from `--keys-fd` (read and closed first). */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Promise<string> {
  refuseKeysInEnv(env);
  const args = parseArgs(argv);
  const keys = readRoleKeysFd(args.keysFd);
  return replay(args, keys);
}

const isMain = process.argv[1]?.endsWith(join("fisco", "cli.ts")) === true;
if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Error text only (no stack): guards and transports never put a URL or key into a message; node text is cleaned.
    process.stderr.write(`fisco:replay failed: ${nodeText(error instanceof Error ? `${error.name}: ${error.message}` : "error")}\n`);
    process.exit(1);
  });
}
