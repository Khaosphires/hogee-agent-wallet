import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, WorkerConfigError } from '../../src/config/env';

const BASE = {
  DATABASE_URL: 'postgres://worker@127.0.0.1:5432/hogee',
  DEPLOYMENT_ID: 'loop-1',
  MAX_FEE_GWEI: '30',
};

describe('loadWorkerConfig', () => {
  it('reads a local config with defaults', () => {
    const c = loadWorkerConfig(BASE);
    expect(c.chain.chain).toBe('local');
    expect(c.chain.rpcUrls).toEqual(['http://127.0.0.1:8545']);
    expect(c.deploymentId).toBe('loop-1');
    expect(c.chainTag).toBe('anvil');
    expect(c.keySet).toBe('LOOP');
    expect(c.maxFeeWei).toBe(30_000_000_000n);
    expect(c.lowBalanceWei).toBe(50_000_000_000_000_000n);
    expect(c.schedules).toEqual({ tick: '*/20 * * * *', reconcile: '* * * * *', settle: '* * * * *', relay: '* * * * *', recordSale: '* * * * *', timelock: '* * * * *', stageGate: '*/10 * * * *', agentActions: '* * * * *', cfoGuard: '*/10 * * * *' });
    expect(c.stuckPendingPasses).toBe(5);
    expect(c.payoutMaxAttempts).toBe(3);
    expect(c.payoutRail).toBe('mock');
    expect(c.dbTimeouts).toEqual({ statementTimeoutMs: 30_000, lockTimeoutMs: 5_000 });
    expect(c.maxSafetyFeeWei).toBe(300_000_000_000n); // 10 × MAX_FEE_GWEI
  });

  it('reads the safety-pause fee cap, never below MAX_FEE_GWEI', () => {
    expect(loadWorkerConfig({ ...BASE, MAX_SAFETY_FEE_GWEI: '500' }).maxSafetyFeeWei).toBe(500_000_000_000n);
    expect(() => loadWorkerConfig({ ...BASE, MAX_SAFETY_FEE_GWEI: '20' })).toThrow(/MAX_SAFETY_FEE_GWEI must be at least MAX_FEE_GWEI/);
    expect(() => loadWorkerConfig({ ...BASE, MAX_SAFETY_FEE_GWEI: 'high' })).toThrow(/MAX_SAFETY_FEE_GWEI/);
  });

  it('reads the DB session timeouts', () => {
    expect(loadWorkerConfig({ ...BASE, DB_STATEMENT_TIMEOUT_MS: '60000', DB_LOCK_TIMEOUT_MS: '2000' }).dbTimeouts).toEqual({ statementTimeoutMs: 60_000, lockTimeoutMs: 2_000 });
    expect(() => loadWorkerConfig({ ...BASE, DB_STATEMENT_TIMEOUT_MS: '0' })).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
    expect(() => loadWorkerConfig({ ...BASE, DB_LOCK_TIMEOUT_MS: 'soon' })).toThrow(/DB_LOCK_TIMEOUT_MS/);
  });

  it('uses LOCAL_RPC_URL for a local chain on another port', () => {
    expect(loadWorkerConfig({ ...BASE, LOCAL_RPC_URL: 'http://127.0.0.1:18547' }).chain.rpcUrls).toEqual(['http://127.0.0.1:18547']);
  });

  it('picks the FINAL key set for final-1 and the sepolia chain tag', () => {
    const c = loadWorkerConfig({
      ...BASE,
      DEPLOYMENT_ID: 'final-1',
      CHAIN: 'sepolia',
      SEPOLIA_RPC_URL: 'https://rpc-a.example/v2/abc',
      SEPOLIA_RPC_URL_FALLBACK: 'https://rpc-b.example/v2/def',
    });
    expect(c.keySet).toBe('FINAL');
    expect(c.chainTag).toBe('sepolia');
    expect(c.chain.pollingIntervalMs).toBeGreaterThanOrEqual(12_000);
  });

  it('requires DATABASE_URL, DEPLOYMENT_ID and MAX_FEE_GWEI', () => {
    for (const name of ['DATABASE_URL', 'DEPLOYMENT_ID', 'MAX_FEE_GWEI'] as const) {
      const env: Record<string, string | undefined> = { ...BASE, [name]: undefined };
      expect(() => loadWorkerConfig(env)).toThrow(new RegExp(name));
    }
  });

  it('rejects a deployment id that names no key set', () => {
    expect(() => loadWorkerConfig({ ...BASE, DEPLOYMENT_ID: 'demo-1' })).toThrow(WorkerConfigError);
  });

  it('rejects malformed numbers without echoing the value', () => {
    expect(() => loadWorkerConfig({ ...BASE, MAX_FEE_GWEI: 'lots' })).toThrow(/MAX_FEE_GWEI/);
    expect(() => loadWorkerConfig({ ...BASE, STUCK_PENDING_PASSES: '0' })).toThrow(/STUCK_PENDING_PASSES/);
    expect(() => loadWorkerConfig({ ...BASE, LOW_BALANCE_ETH: '-1' })).toThrow(/LOW_BALANCE_ETH/);
  });

  it('accepts mock or xendit; xendit only with a test-mode key, named but never echoed', () => {
    expect(() => loadWorkerConfig({ ...BASE, PAYOUT_RAIL: 'paypal' })).toThrow(/PAYOUT_RAIL/);
    expect(() => loadWorkerConfig({ ...BASE, PAYOUT_RAIL: 'xendit' })).toThrow(/XENDIT_SECRET_KEY/);
    const live = `xnd_production_${'x'.repeat(40)}`;
    try {
      loadWorkerConfig({ ...BASE, PAYOUT_RAIL: 'xendit', XENDIT_SECRET_KEY: live });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(live);
    }
    expect(loadWorkerConfig({ ...BASE, PAYOUT_RAIL: 'xendit', XENDIT_SECRET_KEY: `xnd_development_${'y'.repeat(40)}` }).payoutRail).toBe('xendit');
  });

  it('refuses a plain-http Sepolia provider (except loopback) without echoing it', () => {
    const sepolia = { ...BASE, CHAIN: 'sepolia', SEPOLIA_RPC_URL_FALLBACK: 'https://rpc-b.example/v2/def' };
    try {
      loadWorkerConfig({ ...sepolia, SEPOLIA_RPC_URL: 'http://rpc-a.example/v2/secret-key' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerConfigError);
      expect(String(error)).toMatch(/SEPOLIA_RPC_URL must be an https URL/);
      expect(String(error)).not.toContain('secret-key');
    }
    expect(loadWorkerConfig({ ...sepolia, SEPOLIA_RPC_URL: 'http://127.0.0.1:8545' }).chain.rpcUrls[0]).toBe('http://127.0.0.1:8545');
  });

  it('never puts a URL into an error message', () => {
    try {
      loadWorkerConfig({ ...BASE, CHAIN: 'sepolia', SEPOLIA_RPC_URL: 'https://rpc-a.example/v2/secret-key' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-key');
    }
  });
});
