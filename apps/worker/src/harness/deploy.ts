/**
 * Local deploy of the loop-1 set through contracts/script/DeployLoop.s.sol, or of the final-1 set through
 * DeployFinal.s.sol (Anvil only). The deployer is an Anvil default account broadcasting with `--unlocked` (Anvil signs
 * for its own accounts), so no key is ever passed to forge. The child gets a minimal env: never this process's env,
 * which may hold signer keys. Gas limits come from the node (FORGE_NODE_GAS_ARGS), so the same deploy works on Anvil's
 * default hardfork and on a chain with Amsterdam state-creation prices (a Sepolia fork).
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseDeployment, type DeploymentManifest } from '@hogee/chain';
import { mnemonicToAccount, type HDAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';

const run = promisify(execFile);

/** Anvil's public test mnemonic: its ten default accounts are well known and only ever hold Anvil ETH. */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export function anvilAccount(index: number): HDAccount {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
}

export const CONTRACTS_DIR = fileURLToPath(new URL('../../../../contracts/', import.meta.url));

/** forge's own gas simulation runs evm_version cancun (~7x under Amsterdam's EIP-8037 state creation): let the node estimate each tx. */
export const FORGE_NODE_GAS_ARGS = ['--skip-simulation', '--slow'] as const;

/** The forge CLI arguments of a local deploy: `sender` broadcasts with --unlocked (no key reaches forge). */
export function forgeScriptArgs(script: string, rpcUrl: string, sender: Address): string[] {
  return ['script', script, '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', sender, ...FORGE_NODE_GAS_ARGS];
}

export interface DeployLoopOptions {
  readonly rpcUrl: string;
  readonly deployer: Address;
  readonly lender: Address;
  readonly oracle: Address;
  readonly judgingWindowEnd: bigint;
  readonly platformPayees: readonly { readonly id: string; readonly payoutAccountHash: Hex }[];
  readonly deploymentId?: string;
  readonly coolingSeconds?: number;
  readonly contractsDir?: string;
}

const BEGIN = 'BEGIN DEPLOYMENT JSON';
const END = 'END DEPLOYMENT JSON';

/** The manifest JSON DeployLoop / DeployFinal print between their BEGIN/END markers. */
export function manifestFromScriptOutput(stdout: string): DeploymentManifest {
  const start = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END);
  if (start < 0 || end < start) throw new Error('DeployLoop output has no deployment manifest');
  return parseDeployment(JSON.parse(stdout.slice(start + BEGIN.length, end).trim()) as unknown);
}

export async function deployLoop(o: DeployLoopOptions): Promise<DeploymentManifest> {
  return deployWith('script/DeployLoop.s.sol:DeployLoop', o, o.deploymentId ?? 'loop-1');
}

/**
 * The final-1 set (PlanRegistry, Treasury, MilestoneEscrow, SalesOracle) through contracts/script/DeployFinal.s.sol,
 * with DeployLoop's inputs; its loosening timelock is the script's Anvil default (120 s).
 */
export async function deployFinal(o: DeployLoopOptions): Promise<DeploymentManifest> {
  return deployWith('script/DeployFinal.s.sol:DeployFinal', o, o.deploymentId ?? 'final-1');
}

async function deployWith(script: string, o: DeployLoopOptions, deploymentId: string): Promise<DeploymentManifest> {
  const foundryBin = `${homedir()}/.foundry/bin`;
  const env: Record<string, string> = {
    PATH: `${foundryBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: homedir(),
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    DEPLOYMENT_ID: deploymentId,
    CHAIN_TAG: 'anvil',
    LENDER_ADDRESS: o.lender,
    ORACLE_ADDRESS: o.oracle,
    JUDGING_WINDOW_END: o.judgingWindowEnd.toString(),
    COOLING_SECONDS: String(o.coolingSeconds ?? 120),
    PLATFORM_PAYEE_IDS: o.platformPayees.map((p) => p.id).join(','),
    PLATFORM_PAYOUT_HASHES: o.platformPayees.map((p) => p.payoutAccountHash).join(','),
  };
  const { stdout } = await run('forge', forgeScriptArgs(script, o.rpcUrl, o.deployer), { cwd: o.contractsDir ?? CONTRACTS_DIR, env, maxBuffer: 16 * 1024 * 1024 });
  return manifestFromScriptOutput(stdout);
}
