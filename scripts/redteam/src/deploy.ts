/**
 * final-1 on Anvil through contracts/script/DeployFinal.s.sol, exactly as the API's live tests deploy it: Anvil's
 * default account #0 broadcasts with --unlocked (Anvil signs for its own accounts, so no key is ever passed to forge),
 * the lender and oracle are the runtime-generated worker keys, and the static platform payees are the ones the caller
 * names (country.ts: one country's demo registry, or ALL_DEMO_PAYEES for a final-1 both founders share), never the
 * API's default list, so a change of that default cannot change what a world deploys. The child gets a minimal env:
 * never this process's env. Gas limits come from the node (FORGE_NODE_GAS_ARGS), so the same deploy works on Anvil's
 * default hardfork and on a chain with Amsterdam state-creation prices (a Sepolia fork).
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Address } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { parseDeploymentJson, platformPayeeDeployArgs, type Deployment, type OnboardedPayee } from "./api-internals";
import { REPO_ROOT } from "./config";

const run = promisify(execFile);

/** Anvil's public test mnemonic: its default accounts only ever hold Anvil ETH. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const anvilAccount = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });

export const FOUNDRY_BIN = join(homedir(), ".foundry", "bin");

/** forge's own gas simulation runs evm_version cancun (~7x under Amsterdam's EIP-8037 state creation): let the node estimate each tx. */
export const FORGE_NODE_GAS_ARGS = ["--skip-simulation", "--slow"] as const;

/** The forge CLI arguments of the Anvil final-1 deploy: `sender` broadcasts with --unlocked (no key reaches forge). */
export function forgeDeployArgs(rpcUrl: string, sender: Address): string[] {
  return ["script", "script/DeployFinal.s.sol:DeployFinal", "--rpc-url", rpcUrl, "--broadcast", "--unlocked", "--sender", sender, ...FORGE_NODE_GAS_ARGS];
}

export interface AnvilDeployOptions {
  readonly rpcUrl: string;
  readonly deploymentId: string;
  readonly lender: Address;
  readonly oracle: Address;
  readonly judgingWindowEnd: bigint;
  readonly coolingSeconds: number;
  readonly timelockSeconds: number;
  readonly observer?: Address;
  /** The payees whose platform payout hashes Treasury fixes at deploy (platform source only are used). */
  readonly payees: readonly OnboardedPayee[];
}

export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: `${FOUNDRY_BIN}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: homedir(),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ...extra,
  };
}

/** The manifest JSON DeployFinal prints between its BEGIN/END markers. */
export function manifestFromOutput(stdout: string): unknown {
  const start = stdout.indexOf("BEGIN DEPLOYMENT JSON");
  const end = stdout.indexOf("END DEPLOYMENT JSON");
  if (start < 0 || end < start) throw new Error("DeployFinal printed no manifest");
  return JSON.parse(stdout.slice(start + "BEGIN DEPLOYMENT JSON".length, end).trim()) as unknown;
}

export async function deployFinalAnvil(o: AnvilDeployOptions): Promise<{ deployment: Deployment; raw: unknown; stdout: string }> {
  const payees = platformPayeeDeployArgs(o.payees);
  const env = minimalEnv({
    DEPLOYMENT_ID: o.deploymentId,
    CHAIN_TAG: "anvil",
    LENDER_ADDRESS: o.lender,
    ORACLE_ADDRESS: o.oracle,
    JUDGING_WINDOW_END: o.judgingWindowEnd.toString(),
    COOLING_SECONDS: String(o.coolingSeconds),
    LOOSEN_TIMELOCK_SECONDS: String(o.timelockSeconds),
    PLATFORM_PAYEE_IDS: payees.ids,
    PLATFORM_PAYOUT_HASHES: payees.hashes,
    ...(o.observer ? { OBSERVER_ADDRESS: o.observer } : {}),
  });
  const { stdout } = await run("forge", forgeDeployArgs(o.rpcUrl, anvilAccount(0).address), { cwd: join(REPO_ROOT, "contracts"), env, maxBuffer: 16 * 1024 * 1024 });
  const raw = manifestFromOutput(stdout);
  return { deployment: parseDeploymentJson(raw), raw, stdout };
}
