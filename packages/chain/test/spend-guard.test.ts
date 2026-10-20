/**
 * Chain actions that move value (spend, ownerSpend, fundMilestone, releaseMilestone, and executeLoosen of a
 * reserve withdrawal) are signed only when an `eth_call` from the signer REVERTS with a Hogee error: they
 * exist for red-team forced reverts; real value moves go through `payments` rows.
 */
import { encodeErrorResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildExecuteLoosen,
  buildFundMilestone,
  buildOwnerSpend,
  buildPause,
  buildReleaseMilestone,
  guardValueMovingAction,
  HOGEE_KINDS,
  iTreasuryAbi,
  SpendActionRefusedError,
  type SpendGuardClient,
} from '../src/index';
import { milestoneRelease, ownerSpend } from './fixtures/rina';
import { ESCROW, spendPayment, TREASURY } from './fixtures/signed-rows';

const SIGNER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const h = (c: string): Hex => `0x${c.repeat(64)}`;
const sig = { kind: 0, data: `0x${'ab'.repeat(65)}` as Hex };
const capExceeded = encodeErrorResult({ abi: iTreasuryAbi, errorName: 'CapExceeded' });

type Outcome = { revert: Hex | null } | 'succeeds';

function fakeNode(outcome: Outcome, loosen?: { kind: number; status: number }) {
  const calls: { account: unknown; to: unknown; data: unknown; blockTag: unknown }[] = [];
  const client = {
    call: async (a: { account: unknown; to: unknown; data: unknown; blockTag?: unknown }) => {
      calls.push({ account: a.account, to: a.to, data: a.data, blockTag: a.blockTag });
      if (outcome === 'succeeds') return { data: '0x' as Hex };
      const rpc = Object.assign(new Error('execution reverted'), outcome.revert ? { data: outcome.revert } : {});
      throw Object.assign(new Error('Execution reverted for an unknown reason.'), { cause: rpc });
    },
    readContract: async (a: { functionName: string }) => {
      if (a.functionName !== 'queuedLoosen') throw new Error(`unexpected read ${a.functionName}`);
      return { kind: loosen?.kind ?? 0, target: h('0'), aux: h('0'), newValue: 0n, executableAt: 0n, expiresAt: 0n, status: loosen?.status ?? 0 };
    },
  };
  return { client: client as unknown as SpendGuardClient, calls };
}

const spend = spendPayment('inv-guard');
const guard = (client: SpendGuardClient, actionKind: string, to: Address, data: Hex) =>
  guardValueMovingAction(client, { actionKind, signer: SIGNER, request: { to, data } });

describe('guardValueMovingAction', () => {
  it('refuses a value-moving action whose simulated call succeeds (it would really spend)', async () => {
    const node = fakeNode('succeeds');
    const refused = guard(node.client, 'Treasury.spend', TREASURY, spend.data);
    await expect(refused).rejects.toThrow(SpendActionRefusedError);
    await expect(refused).rejects.toMatchObject({ reason: 'call_succeeds' });
    expect(node.calls[0]).toEqual({ account: SIGNER, to: TREASURY, data: spend.data, blockTag: 'latest' });
  });

  it('accepts one that reverts with a Hogee error (red-team evidence: CapExceeded, PayeeNotBound, …)', async () => {
    const node = fakeNode({ revert: capExceeded });
    expect(await guard(node.client, 'Treasury.spend', TREASURY, spend.data)).toMatchObject({ name: 'CapExceeded' });
    const notBound = encodeErrorResult({ abi: iTreasuryAbi, errorName: 'PayeeNotBound' });
    expect(await guard(fakeNode({ revert: notBound }).client, 'Treasury.spend', TREASURY, spend.data)).toMatchObject({ name: 'PayeeNotBound' });
  });

  it('refuses a revert that is not a Hogee custom error (Error(string), no data, a failed RPC)', async () => {
    const errorString = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['nope'],
    });
    for (const revert of [errorString, null]) {
      await expect(guard(fakeNode({ revert }).client, 'Treasury.spend', TREASURY, spend.data)).rejects.toMatchObject({
        name: 'SpendActionRefusedError',
        reason: 'not_a_hogee_revert',
      });
    }
  });

  it('simulates ownerSpend, fundMilestone and releaseMilestone too', async () => {
    const cases: [string, Address, Hex][] = [
      ['Treasury.ownerSpend', TREASURY, buildOwnerSpend({ req: ownerSpend, founder: sig }).data],
      ['MilestoneEscrow.fundMilestone', ESCROW, buildFundMilestone({ orderId: h('1'), idx: 1, amountMinor: 1n, decisionId: h('2'), rationaleHash: h('3') }).data],
      ['MilestoneEscrow.releaseMilestone', ESCROW, buildReleaseMilestone({ release: milestoneRelease, founder: sig }).data],
    ];
    for (const [kind, to, data] of cases) {
      const node = fakeNode('succeeds');
      await expect(guard(node.client, kind, to, data)).rejects.toMatchObject({ reason: 'call_succeeds' });
      expect(node.calls).toHaveLength(1);
    }
  });

  it('leaves actions that move no value alone (no simulation)', async () => {
    const node = fakeNode('succeeds');
    expect(await guard(node.client, 'Treasury.pause', TREASURY, buildPause().data)).toBeNull();
    const raise = fakeNode('succeeds', { kind: HOGEE_KINDS.LOOSEN_RAISE_PER_TX_CAP, status: HOGEE_KINDS.LOOSEN_STATUS_QUEUED });
    expect(await guard(raise.client, 'Treasury.executeLoosen', TREASURY, buildExecuteLoosen({ loosenId: h('9') }).data)).toBeNull();
    expect([...node.calls, ...raise.calls]).toEqual([]);
  });

  it('executeLoosen of a queued reserve withdrawal, or of a loosen whose kind is not known yet, must revert', async () => {
    const data = buildExecuteLoosen({ loosenId: h('9') }).data;
    const withdraw = fakeNode('succeeds', { kind: HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE, status: HOGEE_KINDS.LOOSEN_STATUS_QUEUED });
    await expect(guard(withdraw.client, 'Treasury.executeLoosen', TREASURY, data)).rejects.toMatchObject({ reason: 'call_succeeds' });
    const unknown = fakeNode({ revert: encodeErrorResult({ abi: iTreasuryAbi, errorName: 'TimelockActive' }) });
    expect(await guard(unknown.client, 'Treasury.executeLoosen', TREASURY, data)).toMatchObject({ name: 'TimelockActive' });
    expect(unknown.calls).toHaveLength(1);
    expect(encodeFunctionData({ abi: iTreasuryAbi, functionName: 'executeLoosen', args: [h('9')] })).toBe(data);
  });
});
