/**
 * Which founder-signed settlements settle-spend looks up on-chain for adoption (audit run-4 v-2): a relayed OwnerSpend
 * or MilestoneRelease whose rows all ended without executing (the relayer's tx REVERTED behind a copy someone else
 * landed first, or the relay refused it) may still have been executed by another account. Pure selection only.
 */
import { describe, expect, it } from 'vitest';
import { isApiSpendProposalId } from '../../src/jobs/agent-actions-ids';
import { ADOPT_ALERT, ADOPTION_GRACE_S, adoptedFounderRowId, founderAdoptions as select, type FounderRowFacts } from '../../src/jobs/settle-adopt-founder';

const A = `0x${'a'.repeat(64)}` as const;
const B = `0x${'b'.repeat(64)}` as const;
const NOW = 1_800_000_000n;
const row = (id: string, kind: string, state: string, intentId: string = A, over: Partial<FounderRowFacts> = {}): FounderRowFacts => ({ id, kind, state, intentId, expiry: null, alerts: [], ...over });
const founderAdoptions = (rows: readonly FounderRowFacts[]) => select(rows, NOW);

describe('founderAdoptions', () => {
  it('looks up an OwnerSpend or MilestoneRelease whose rows all ended REVERTED, POLICY_DENIED or CANCELLED', () => {
    expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED')])).toEqual([{ kind: 'OWNER_SPEND', intentId: A, sourceId: 'owner:s1', held: false }]);
    expect(founderAdoptions([row('release:e1', 'RELEASE_MILESTONE', 'POLICY_DENIED', B.toUpperCase().replace('0X', '0x'))])).toEqual([
      { kind: 'RELEASE_MILESTONE', intentId: B, sourceId: 'release:e1', held: false },
    ]);
    // Several attempts at one intent: one lookup, from the latest row.
    expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'POLICY_DENIED'), row('owner:s2', 'OWNER_SPEND', 'CANCELLED')])).toEqual([
      { kind: 'OWNER_SPEND', intentId: A, sourceId: 'owner:s2', held: false },
    ]);
  });

  it('never looks up an intent a live row covers: in flight, settling, settled, or already adopted', () => {
    for (const state of ['POLICY_OK', 'SIGNED', 'BROADCAST', 'INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED']) {
      expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED'), row('x', 'OWNER_SPEND', state)])).toEqual([]);
    }
    expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED'), row(adoptedFounderRowId('OWNER_SPEND', A), 'OWNER_SPEND', 'FINALIZED')])).toEqual([]);
  });

  it('flags a DROPPED row that still holds the intent: alert only, it cannot be adopted while held', () => {
    expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED'), row('owner:s2', 'OWNER_SPEND', 'DROPPED')])).toEqual([
      { kind: 'OWNER_SPEND', intentId: A, sourceId: 'owner:s2', held: true },
    ]);
  });

  it('retires a group whose signatures all expired more than the grace before the finalized head (M3)', () => {
    const at = (expiry: bigint) => row('owner:s1', 'OWNER_SPEND', 'REVERTED', A, { expiry });
    expect(founderAdoptions([at(NOW - ADOPTION_GRACE_S - 1n)])).toEqual([]);
    expect(founderAdoptions([at(NOW - ADOPTION_GRACE_S)])).toHaveLength(1);
    expect(founderAdoptions([at(NOW + 60n)])).toHaveLength(1);
    // One signature still live (or of unknown expiry) keeps the group.
    expect(founderAdoptions([at(NOW - 10_000n), row('owner:s2', 'OWNER_SPEND', 'POLICY_DENIED', A, { expiry: null })])).toHaveLength(1);
  });

  it('retires a group after its final alert, keyed by kind (M3, L5)', () => {
    for (const alert of [ADOPT_ALERT.MISMATCH, ADOPT_ALERT.OWN_TX, ADOPT_ALERT.CLOSED]) {
      expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED', A, { alerts: [alert] })])).toEqual([]);
    }
    // A history alert is retried; a held alert retires only a group that is still held.
    expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED', A, { alerts: [ADOPT_ALERT.HISTORY] })])).toHaveLength(1);
    expect(founderAdoptions([row('owner:s1', 'OWNER_SPEND', 'REVERTED', A, { alerts: [ADOPT_ALERT.HELD] })])).toHaveLength(1);
    expect(founderAdoptions([row('owner:s2', 'OWNER_SPEND', 'DROPPED', A, { alerts: [ADOPT_ALERT.HELD] })])).toEqual([]);
    expect(founderAdoptions([row('owner:s2', 'OWNER_SPEND', 'DROPPED', A, { alerts: [ADOPT_ALERT.MISMATCH] })])).toHaveLength(1);
  });

  it('keeps kinds and intents apart and ignores every other kind', () => {
    const got = founderAdoptions([
      row('owner:s1', 'OWNER_SPEND', 'REVERTED', A),
      row('release:e1', 'RELEASE_MILESTONE', 'REVERTED', A),
      row('owner:s3', 'OWNER_SPEND', 'BROADCAST', B),
      row('pay-1', 'SPEND', 'REVERTED', B),
      row('reserve:x', 'WITHDRAW_RESERVE', 'REVERTED', B),
    ]);
    expect(got.map((c) => [c.kind, c.intentId, c.sourceId])).toEqual([
      ['OWNER_SPEND', A, 'owner:s1'],
      ['RELEASE_MILESTONE', A, 'release:e1'],
    ]);
  });

  it('names the adopted rows by kind and on-chain settlement id, and never as an API spend proposal', () => {
    expect(adoptedFounderRowId('OWNER_SPEND', A.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(`adopt-owner:${A}`);
    expect(adoptedFounderRowId('RELEASE_MILESTONE', B)).toBe(`adopt-release:${B}`);
    expect(isApiSpendProposalId(`adopt-owner:${A}`)).toBe(false);
    expect(isApiSpendProposalId(`adopt-release:${B}`)).toBe(false);
  });
});
