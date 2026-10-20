import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DeploymentError,
  deploymentFileName,
  deploymentTags,
  loadDeployment,
  parseDeployment,
  toBytes32Tag,
} from '../src/index';

const loop1 = {
  chainId: 11155111,
  deploymentId: 'loop-1',
  chainTag: 'sepolia',
  contracts: {
    PlanRegistry: { address: '0x5fbdb2315678afecb367f032d93f642f64180aa3' },
    Treasury: {
      address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      verifiedUrl: 'https://sepolia.etherscan.io/address/0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512#code',
    },
  },
  blockNumber: 9_400_000,
  deployedAt: '2026-10-16T09:00:00Z',
};

describe('parseDeployment', () => {
  it('accepts a loop-1 manifest (two contracts) and checksums addresses', () => {
    const m = parseDeployment(loop1);
    expect(m.contracts.PlanRegistry.address).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
    expect(m.contracts.Treasury.verifiedUrl).toMatch(/^https:/);
    expect(m.contracts.MilestoneEscrow).toBeUndefined();
  });

  it('accepts a final-1 manifest with all four contracts', () => {
    const m = parseDeployment({
      ...loop1,
      deploymentId: 'final-1',
      contracts: {
        ...loop1.contracts,
        MilestoneEscrow: { address: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' },
        SalesOracle: { address: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9' },
      },
    });
    expect(Object.keys(m.contracts)).toEqual(['PlanRegistry', 'Treasury', 'MilestoneEscrow', 'SalesOracle']);
  });

  it.each([
    ['not an object', null, /JSON object/],
    ['missing Treasury', { ...loop1, contracts: { PlanRegistry: loop1.contracts.PlanRegistry } }, /Treasury is required/],
    ['bad address', { ...loop1, contracts: { ...loop1.contracts, Treasury: { address: '0x1234' } } }, /address/],
    ['unknown contract', { ...loop1, contracts: { ...loop1.contracts, Vault: { address: loop1.contracts.PlanRegistry.address } } }, /unknown contracts: Vault/],
    ['http verifiedUrl', { ...loop1, contracts: { ...loop1.contracts, Treasury: { address: loop1.contracts.Treasury.address, verifiedUrl: 'http://x' } } }, /https/],
    ['non-UTC deployedAt', { ...loop1, deployedAt: '2026-10-16T09:00:00+08:00' }, /deployedAt/],
    ['zero chainId', { ...loop1, chainId: 0 }, /chainId/],
    ['bad label', { ...loop1, deploymentId: 'Loop 1' }, /deploymentId/],
    ['float block', { ...loop1, blockNumber: 1.5 }, /blockNumber/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => parseDeployment(input)).toThrow(DeploymentError);
    expect(() => parseDeployment(input)).toThrow(message);
  });
});

describe('file naming and tags', () => {
  it('names files <chain>-<deploymentId>.json', () => {
    expect(deploymentFileName('sepolia', 'final-1')).toBe('sepolia-final-1.json');
    expect(() => deploymentFileName('../etc', 'x')).toThrow(DeploymentError);
  });

  it('derives the bytes32 constructor tags', () => {
    expect(deploymentTags(loop1)).toEqual({ chainTag: toBytes32Tag('sepolia'), deploymentId: toBytes32Tag('loop-1') });
  });
});

describe('loadDeployment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hogee-deployments-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads and validates a manifest from a directory', () => {
    writeFileSync(join(dir, 'sepolia-loop-1.json'), JSON.stringify(loop1));
    expect(loadDeployment('sepolia', 'loop-1', { dir }).chainId).toBe(11155111);
  });

  it('rejects a manifest whose content does not match its file name', () => {
    writeFileSync(join(dir, 'sepolia-final-1.json'), JSON.stringify(loop1));
    expect(() => loadDeployment('sepolia', 'final-1', { dir })).toThrow(/does not match/);
  });

  it('reports missing files and invalid JSON as DeploymentError', () => {
    expect(() => loadDeployment('sepolia', 'nope', { dir })).toThrow(DeploymentError);
    writeFileSync(join(dir, 'anvil-loop-1.json'), '{not json');
    expect(() => loadDeployment('anvil', 'loop-1', { dir })).toThrow(/not valid JSON/);
  });

  it('defaults to packages/chain/deployments', () => {
    expect(() => loadDeployment('sepolia', 'does-not-exist')).toThrow(/packages\/chain\/deployments/);
  });
});
