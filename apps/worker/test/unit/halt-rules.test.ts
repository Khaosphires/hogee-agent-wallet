import type { FinalityOutcome, NonceReconcileResult, RecoveryOutcome } from '@hogee/chain';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { agentKeyPauseId, judgeAgentKeyUse, judgeFacilityPass, judgeNoncePass, nonCanonicalRows, unresolvedSettlementRows } from '../../src/jobs/halt-rules';

const target = { table: 'payments' as const, facilityId: 'fac-1', id: 'p-1' };
const H: Hex = `0x${'1'.repeat(64)}`;
const NOT_CANONICAL = 'receipt block is not the canonical block at its height; retried next pass';

function rec(action: RecoveryOutcome['action'], detail?: string): RecoveryOutcome {
  return { target, nonce: 3n, storedTxHash: H, action, fromState: 'BROADCAST', toState: 'BROADCAST', ...(detail ? { detail } : {}) };
}
function fin(action: FinalityOutcome['action'], detail?: string, id = 'p-1'): FinalityOutcome {
  return { target: { ...target, id }, nonce: 3n, action, fromState: 'INCLUDED', toState: 'INCLUDED', ...(detail ? { detail } : {}) };
}

describe('judgeFacilityPass', () => {
  const base = { facilityId: 'fac-1', recovery: [], finality: [], nonCanonicalPasses: new Map<string, number>(), unresolvedPasses: new Map<string, number>(), stuckThreshold: 3 };

  it('a clean pass halts nothing', () => {
    expect(judgeFacilityPass({ ...base, recovery: [rec('rebroadcast'), rec('included')], finality: [fin('finalized')] })).toEqual({ halts: [], alerts: [] });
  });

  it('halts on any recovery or finality error outcome', () => {
    expect(judgeFacilityPass({ ...base, recovery: [rec('error', 'Error: boom')] }).halts).toEqual([
      { reason: 'RECOVERY_ERROR', detail: { facilityId: 'fac-1', row: 'payments/p-1', nonce: '3', detail: 'Error: boom' } },
    ]);
    expect(judgeFacilityPass({ ...base, finality: [fin('error', 'Error: rpc')] }).halts[0]?.reason).toBe('FINALITY_ERROR');
  });

  it('halts when a non-canonical pending stays stuck for N passes, not before', () => {
    const passes = (n: number) => new Map([['payments/p-1', n]]);
    expect(judgeFacilityPass({ ...base, finality: [fin('pending', NOT_CANONICAL)], nonCanonicalPasses: passes(2) }).halts).toEqual([]);
    expect(judgeFacilityPass({ ...base, finality: [fin('pending', NOT_CANONICAL)], nonCanonicalPasses: passes(3) }).halts[0]).toMatchObject({
      reason: 'NON_CANONICAL_STUCK',
      detail: { row: 'payments/p-1', passes: 3 },
    });
  });

  it('only alerts on unresolved rows (they wait for a human, holding their intent)', () => {
    const v = judgeFacilityPass({ ...base, recovery: [rec('unresolved', 'intent executed on-chain by a tx that is not this row’s')], finality: [fin('unresolved', 'x')] });
    expect(v.halts).toEqual([]);
    expect(v.alerts.map((a) => a.reason)).toEqual(['UNRESOLVED_ROW', 'UNRESOLVED_ROW']);
  });
});

describe('unresolved settlement attestations', () => {
  const base = { facilityId: 'fac-1', recovery: [], finality: [], nonCanonicalPasses: new Map<string, number>(), stuckThreshold: 3 };
  const settle = (action: RecoveryOutcome['action'], id: string): RecoveryOutcome => ({ ...rec(action), target: { table: 'chain_actions', facilityId: 'fac-1', id } });

  it('lists only settle-confirm / settle-fail actions that recovery or finality left unresolved', () => {
    const rows = unresolvedSettlementRows([settle('unresolved', 'settle-confirm:p-1'), settle('unresolved', 'setup:fund'), settle('rebroadcast', 'settle-fail:p-2')], [
      { ...fin('unresolved', 'x'), target: { table: 'chain_actions', facilityId: 'fac-1', id: 'settle-fail:p-3' } },
    ]);
    expect(rows).toEqual([
      { table: 'chain_actions', id: 'settle-confirm:p-1' },
      { table: 'chain_actions', id: 'settle-fail:p-3' },
    ]);
  });

  it('halts when a settlement attestation stays unresolved for N passes, not before', () => {
    const recovery = [settle('unresolved', 'settle-confirm:p-1')];
    const passes = (n: number) => new Map([['chain_actions/settle-confirm:p-1', n]]);
    expect(judgeFacilityPass({ ...base, recovery, unresolvedPasses: passes(2) }).halts).toEqual([]);
    expect(judgeFacilityPass({ ...base, recovery, unresolvedPasses: passes(3) }).halts[0]).toMatchObject({
      reason: 'SETTLEMENT_UNRESOLVED_STUCK',
      detail: { row: 'chain_actions/settle-confirm:p-1', passes: 3 },
    });
  });
});

describe('nonCanonicalRows', () => {
  it('lists the rows whose pending comes from a non-canonical receipt', () => {
    expect(nonCanonicalRows([fin('pending', NOT_CANONICAL, 'a'), fin('pending', 'nonce not consumed at finalized', 'b'), fin('finalized', undefined, 'c')])).toEqual([
      { table: 'payments', id: 'a' },
    ]);
  });
});

describe('judgeNoncePass', () => {
  const inspection = {
    signer: '0x00000000000000000000000000000000000000b1',
    chainId: 31337,
    chainLatest: 1n,
    chainPending: 1n,
    dbNext: 1n,
    open: [],
    holes: [],
    externalUse: false,
    advancedTo: null,
    cancels: [],
  } as unknown as NonceReconcileResult;

  it('halts on an occupied hole-fill', () => {
    const v = judgeNoncePass('agent', { ...inspection, holes: [5n], cancels: [{ nonce: 5n, txHash: H, status: 'occupied' }] });
    expect(v.halts).toEqual([{ reason: 'NONCE_HOLE_OCCUPIED', detail: { role: 'agent', signer: inspection.signer, nonce: '5', txHash: H } }]);
  });

  it('only alerts on a sent cancel or on key use outside the allocator by the oracle, lender or relayer key', () => {
    for (const role of ['oracle', 'lender', 'relayer']) {
      const v = judgeNoncePass(role, { ...inspection, externalUse: true, advancedTo: 4n, cancels: [{ nonce: 2n, txHash: H, status: 'sent' }] });
      expect(v.halts).toEqual([]);
      expect(v.alerts.map((a) => a.reason)).toEqual(['NONCE_HOLE_FILLED', 'EXTERNAL_KEY_USE']);
    }
  });

  it('halts on agent key use outside the allocator (M4: no wait for the orphan watch at finalized)', () => {
    const v = judgeNoncePass('agent', { ...inspection, chainPending: 4n, externalUse: true, advancedTo: 4n });
    expect(v.halts).toEqual([{ reason: 'EXTERNAL_AGENT_KEY_USE', detail: { role: 'agent', signer: inspection.signer, dbNext: '1', chainPending: '4' } }]);
    expect(v.alerts).toEqual([]);
  });
});

describe('judgeAgentKeyUse', () => {
  const base = { signer: '0x00000000000000000000000000000000000000A1', chainId: 31337, chainLatest: 3n, chainPending: 3n, dbNext: 3n, open: [], holes: [], externalUse: false } as const;

  it('is null while every agent nonce came from the allocator (or before the key has a nonces row)', () => {
    expect(judgeAgentKeyUse(base)).toBeNull();
    expect(judgeAgentKeyUse({ ...base, dbNext: null, chainPending: 9n })).toBeNull();
  });

  it('a pending count above the allocator is a halt finding with its own safety-pause request id', () => {
    const f = judgeAgentKeyUse({ ...base, chainPending: 5n, externalUse: true });
    expect(f).toEqual({ reason: 'EXTERNAL_AGENT_KEY_USE', detail: { role: 'agent', signer: base.signer, dbNext: '3', chainPending: '5' } });
    expect(agentKeyPauseId(base.signer, 3n)).toBe(`agent-key:${base.signer.toLowerCase()}:3`);
  });
});
