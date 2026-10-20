/**
 * Startup preflight against real deployments (Anvil): checkDeploymentOnChain accepts a final-1 set with its full
 * manifest, refuses the same Treasury behind a manifest that drops or swaps MilestoneEscrow / SalesOracle (re-check L9),
 * classifies a real eth_call revert of escrow() as the loop-1 shape, and refuses a final-1 set whose observer is the
 * worker's relayer key (re-check L-3; the contracts keep the other three roles off the observer themselves).
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { DeploymentManifest } from '@hogee/chain';
import { generatePrivateKey } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyEnvName, loadSigners, SIGNER_ROLES } from '../../src/config/keys';
import { anvilAccount, CONTRACTS_DIR, deployFinal, forgeScriptArgs, manifestFromScriptOutput } from '../../src/harness/deploy';
import { platformPayeeHashes } from '../../src/harness/rina';
import { checkDeploymentOnChain } from '../../src/runtime/app';
import { DAY, LIVE, LIVE_TIMEOUT_MS, openLive, RPC_URL, type Live } from '../support/live';

const run = promisify(execFile);
const signers = loadSigners(Object.fromEntries(SIGNER_ROLES.map((r) => [keyEnvName(r, 'FINAL'), generatePrivateKey()])), 'FINAL');
const label = () => `final-${Math.random().toString(16).slice(2, 10)}`;

/** DeployFinal with OBSERVER_ADDRESS set (the harness deploys without an observer). Minimal env, no key. */
async function deployFinalWithObserver(observer: string, judgingWindowEnd: bigint): Promise<DeploymentManifest> {
  const payees = platformPayeeHashes();
  const env: Record<string, string> = {
    PATH: `${homedir()}/.foundry/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: homedir(),
    DEPLOYMENT_ID: label(),
    CHAIN_TAG: 'anvil',
    LENDER_ADDRESS: signers.lender.address,
    ORACLE_ADDRESS: signers.oracle.address,
    OBSERVER_ADDRESS: observer,
    JUDGING_WINDOW_END: judgingWindowEnd.toString(),
    COOLING_SECONDS: '120',
    PLATFORM_PAYEE_IDS: payees.map((p) => p.id).join(','),
    PLATFORM_PAYOUT_HASHES: payees.map((p) => p.payoutAccountHash).join(','),
  };
  const args = forgeScriptArgs('script/DeployFinal.s.sol:DeployFinal', RPC_URL as string, anvilAccount(0).address);
  const { stdout } = await run('forge', args, { cwd: CONTRACTS_DIR, env, maxBuffer: 16 * 1024 * 1024 });
  return manifestFromScriptOutput(stdout);
}

describe.skipIf(!LIVE)('startup preflight on Anvil (re-check L9, L-3)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  let deployment: DeploymentManifest;
  let judgingWindowEnd: bigint;
  beforeAll(async () => {
    live = await openLive();
    judgingWindowEnd = (await live.client.getBlock({ blockTag: 'latest' })).timestamp + 30n * DAY;
    deployment = await deployFinal({
      deploymentId: label(),
      rpcUrl: RPC_URL as string,
      deployer: anvilAccount(0).address,
      lender: signers.lender.address,
      oracle: signers.oracle.address,
      judgingWindowEnd,
      platformPayees: platformPayeeHashes(),
    });
  }, LIVE_TIMEOUT_MS);
  afterAll(async () => {
    await live?.close();
  });

  const check = (d: DeploymentManifest) => checkDeploymentOnChain({ client: live.client, deployment: d, signers });

  it('accepts a final-1 set with its full manifest (no observer)', async () => {
    await expect(check(deployment)).resolves.toBeUndefined();
  });

  it('refuses the final-1 Treasury behind a manifest without MilestoneEscrow (the orphan watch would be off)', async () => {
    const { MilestoneEscrow: _escrow, SalesOracle: _sales, ...loopShaped } = deployment.contracts;
    await expect(check({ ...deployment, contracts: loopShaped })).rejects.toThrow(/manifest has no MilestoneEscrow, but Treasury\.escrow\(\) is 0x/);
  });

  it('refuses a manifest whose MilestoneEscrow or SalesOracle is not the one Treasury links', async () => {
    const c = deployment.contracts;
    const swapped = { ...c, MilestoneEscrow: c.SalesOracle!, SalesOracle: c.MilestoneEscrow! };
    await expect(check({ ...deployment, contracts: swapped })).rejects.toThrow(/MilestoneEscrow .* is not Treasury\.escrow\(\)/);
    await expect(check({ ...deployment, contracts: { ...c, SalesOracle: c.PlanRegistry } })).rejects.toThrow(/SalesOracle .* is not Treasury\.salesOracle\(\)/);
  });

  it("treats a real eth_call revert of escrow() as the loop-1 shape (a contract with oracle() but no escrow())", async () => {
    // SalesOracle exposes oracle() (the role check passes) and has no escrow(): the probe reverts on the node.
    const contracts = { PlanRegistry: deployment.contracts.PlanRegistry, Treasury: deployment.contracts.SalesOracle! };
    await expect(check({ ...deployment, contracts })).resolves.toBeUndefined();
  });

  it("refuses a final-1 set whose observer is the worker's relayer key", async () => {
    const watched = await deployFinalWithObserver(signers.relayer.address, judgingWindowEnd);
    await expect(check(watched)).rejects.toThrow(/FINAL relayer key is the deployment's observer/);
  });
});
