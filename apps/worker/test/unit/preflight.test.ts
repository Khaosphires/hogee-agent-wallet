/**
 * Startup preflight against the chain, with a fake client: the lender and oracle keys must be the deployment's roles
 * (as before); on a final-1 manifest Treasury's escrow and sales-oracle links must name the manifest's contracts, and a
 * manifest without MilestoneEscrow must not front a Treasury that links one (re-check L9: it would silently switch off
 * the MilestoneFunded orphan watch and the observer mirror); a set observer is never one of the worker's own keys
 * (re-check L-3: its cancelLoosen veto would be the worker's).
 */
import type { DeploymentManifest } from '@hogee/chain';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  getAddress,
  HttpRequestError,
  parseAbi,
  zeroAddress,
  type Address,
} from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { keyEnvName, loadSigners, SIGNER_ROLES } from '../../src/config/keys';
import { checkDeploymentOnChain, WorkerStartError, type PreflightClient } from '../../src/runtime/app';

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const REGISTRY = addr(0xa01);
const TREASURY = addr(0xa02);
const ESCROW = addr(0xa03);
const SALES = addr(0xa04);
const STRANGER = addr(0xbad);

const signers = loadSigners(Object.fromEntries(SIGNER_ROLES.map((r) => [keyEnvName(r, 'FINAL'), generatePrivateKey()])), 'FINAL');

const finalManifest: DeploymentManifest = {
  chainId: 31337,
  deploymentId: 'final-1',
  chainTag: 'anvil',
  contracts: { PlanRegistry: { address: REGISTRY }, Treasury: { address: TREASURY }, MilestoneEscrow: { address: ESCROW }, SalesOracle: { address: SALES } },
  blockNumber: 1,
  deployedAt: '2026-10-17T00:00:00Z',
};
const loopManifest: DeploymentManifest = {
  ...finalManifest,
  deploymentId: 'loop-1',
  contracts: { PlanRegistry: { address: REGISTRY }, Treasury: { address: TREASURY } },
};

const escrowAbi = parseAbi(['function escrow() view returns (address)']);
/** What viem throws for an eth_call that reverts (e.g. a loop-1 Treasury without escrow()). */
const reverted = () =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: escrowAbi, functionName: 'escrow' }), {
    abi: escrowAbi,
    functionName: 'escrow',
    contractAddress: TREASURY,
  });

type View = Address | (() => Error);

/** A chain that serves the deployment's own roles and links, with `over` replacing any view ("Contract.fn"). */
function chain(over: Record<string, View> = {}) {
  const reads: string[] = [];
  const views: Record<string, View> = {
    'PlanRegistry.lender': signers.lender.address,
    'Treasury.oracle': signers.oracle.address,
    'Treasury.escrow': ESCROW,
    'Treasury.salesOracle': SALES,
    'Treasury.observer': zeroAddress,
    ...over,
  };
  const names: Record<string, string> = { [REGISTRY]: 'PlanRegistry', [TREASURY]: 'Treasury' };
  const client = {
    getChainId: async () => 31337,
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      const key = `${names[getAddress(address)] ?? address}.${functionName}`;
      reads.push(key);
      const v = views[key];
      if (v === undefined) throw new Error(`unexpected read ${key}`);
      if (typeof v === 'function') throw v();
      return v;
    },
  } as unknown as PreflightClient;
  return { client, reads };
}

const check = (deployment: DeploymentManifest, over?: Record<string, View>) => checkDeploymentOnChain({ client: chain(over).client, deployment, signers });

describe('checkDeploymentOnChain: roles (fail closed)', () => {
  it('accepts a final-1 deployment whose roles, links and observer are as configured', async () => {
    const c = chain();
    await expect(checkDeploymentOnChain({ client: c.client, deployment: finalManifest, signers })).resolves.toBeUndefined();
    expect(c.reads.sort()).toEqual(['PlanRegistry.lender', 'Treasury.escrow', 'Treasury.observer', 'Treasury.oracle', 'Treasury.salesOracle']);
  });

  it('refuses a lender or oracle key that is not the deployment role', async () => {
    await expect(check(finalManifest, { 'PlanRegistry.lender': STRANGER })).rejects.toThrow(/FINAL lender key is not the deployment's lender/);
    await expect(check(finalManifest, { 'Treasury.oracle': STRANGER })).rejects.toThrow(/FINAL oracle key is not the deployment's oracle/);
  });
});

describe('checkDeploymentOnChain: the final-1 links (re-check L9)', () => {
  it("refuses a manifest MilestoneEscrow that is not Treasury's escrow", async () => {
    await expect(check(finalManifest, { 'Treasury.escrow': STRANGER })).rejects.toThrow(WorkerStartError);
    await expect(check(finalManifest, { 'Treasury.escrow': STRANGER })).rejects.toThrow(/MilestoneEscrow .* is not Treasury\.escrow\(\)/);
  });

  it("refuses a manifest SalesOracle that is not Treasury's sales oracle, or a final-1 manifest without one", async () => {
    await expect(check(finalManifest, { 'Treasury.salesOracle': STRANGER })).rejects.toThrow(/SalesOracle .* is not Treasury\.salesOracle\(\)/);
    const { SalesOracle: _dropped, ...noSales } = finalManifest.contracts;
    await expect(check({ ...finalManifest, contracts: noSales })).rejects.toThrow(/SalesOracle \(none\) is not Treasury\.salesOracle\(\)/);
  });

  it('refuses a manifest without MilestoneEscrow in front of a Treasury that links one', async () => {
    await expect(check(loopManifest)).rejects.toThrow(/manifest has no MilestoneEscrow, but Treasury\.escrow\(\) is 0x0+a03/i);
  });

  it('accepts a manifest without MilestoneEscrow when Treasury links none (loop-1 shape, escrow() = 0); no observer read', async () => {
    const c = chain({ 'Treasury.escrow': zeroAddress, 'Treasury.observer': signers.relayer.address });
    await expect(checkDeploymentOnChain({ client: c.client, deployment: loopManifest, signers })).resolves.toBeUndefined();
    expect(c.reads).not.toContain('Treasury.observer');
    expect(c.reads).not.toContain('Treasury.salesOracle');
  });

  it('treats a reverting escrow() as the loop-1 shape (the loop-1-src Treasury has no such view)', async () => {
    await expect(check(loopManifest, { 'Treasury.escrow': reverted })).resolves.toBeUndefined();
  });

  it('fails closed when the escrow() probe fails for any other reason (an RPC error is not a revert)', async () => {
    const down = () => new HttpRequestError({ url: 'http://127.0.0.1:1' });
    await expect(check(loopManifest, { 'Treasury.escrow': down })).rejects.toThrow(HttpRequestError);
  });
});

describe('checkDeploymentOnChain: the observer is never a worker key (re-check L-3)', () => {
  it('accepts no observer (zero) or an observer on its own key', async () => {
    await expect(check(finalManifest, { 'Treasury.observer': zeroAddress })).resolves.toBeUndefined();
    await expect(check(finalManifest, { 'Treasury.observer': STRANGER })).resolves.toBeUndefined();
  });

  it.each(['agent', 'oracle', 'lender', 'relayer'] as const)('refuses an observer that is the worker %s key', async (role) => {
    const observer = signers[role].address;
    await expect(check(finalManifest, { 'Treasury.observer': observer })).rejects.toThrow(WorkerStartError);
    await expect(check(finalManifest, { 'Treasury.observer': observer.toLowerCase() as Address })).rejects.toThrow(
      new RegExp(`FINAL ${role} key is the deployment's observer`),
    );
  });
});
