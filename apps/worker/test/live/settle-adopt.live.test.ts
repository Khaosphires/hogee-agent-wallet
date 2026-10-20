/**
 * Audit run-4 (v-2) on final-1 worlds (Anvil + Postgres, MockRail): Treasury.ownerSpend and
 * MilestoneEscrow.releaseMilestone accept any submitter, so a third party that copies the relayer's pending
 * founder-signed call and lands it first opens the settlement while the relayer's row ends REVERTED. settle-spend must
 * adopt that execution from the finalized chain, pay it exactly once and have the ORACLE confirm it, with an ALERT.
 * Re-check M3, M4, L5, L7: lookups read single blocks (they run against an RPC that caps eth_getLogs at 10 blocks), a
 * settlement already closed is not adopted, and every non-adoption outcome alerts once by kind and is then retired.
 */
import { buildConfirmSettlement, iTreasuryAbi, type HogeePublicClient } from '@hogee/chain';
import { createWalletClient, getAbiItem, http, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runSettle } from '../../src/jobs/settle';
import { adoptedFounderRowId } from '../../src/jobs/settle-adopt-founder';
import { payoutAccountRef } from '../../src/rail/rail';
import { silentLogger } from '../../src/runtime/log';
import { activeHalt, clearHalt } from '../../src/store/halt';
import { finalizeAll, LIVE, LIVE_TIMEOUT_MS, newWorld, openLive, RPC_URL, type Live, type World } from '../support/live';
import { finalize, prepareCopiedOwnerSpend, prepareCopiedRelease, withdrawReserve, type CopiedCase } from '../support/settle-kinds';

/** The client of an RPC that refuses eth_getLogs over more than `max` blocks (the Alchemy free tier allows 10). */
function cappedLogs(client: HogeePublicClient, max = 10n): HogeePublicClient {
  const getLogs = async (args: { fromBlock?: unknown; toBlock?: unknown }) => {
    const { fromBlock, toBlock } = args;
    if (typeof fromBlock !== 'bigint' || typeof toBlock !== 'bigint' || toBlock - fromBlock + 1n > max) throw new Error(`eth_getLogs is limited to a ${max}-block range`);
    return (client.getLogs as (a: unknown) => Promise<unknown>)(args);
  };
  return new Proxy(client, { get: (target, prop, receiver) => (prop === 'getLogs' ? getLogs : Reflect.get(target, prop, receiver)) });
}

/** The client of a non-archive RPC: isIntentUsed below the finalized head fails. */
function noHistory(client: HogeePublicClient, head: bigint): HogeePublicClient {
  const readContract = async (args: { functionName?: string; blockNumber?: bigint }) => {
    if (args.functionName === 'isIntentUsed' && args.blockNumber !== undefined && args.blockNumber < head) throw new Error('missing trie node');
    return (client.readContract as (a: unknown) => Promise<unknown>)(args);
  };
  return new Proxy(client, { get: (target, prop, receiver) => (prop === 'readContract' ? readContract : Reflect.get(target, prop, receiver)) });
}

const CONFIRMED = getAbiItem({ abi: iTreasuryAbi, name: 'SettlementConfirmed' });

const CASES = [
  { kind: 'OWNER_SPEND' as const, prepare: prepareCopiedOwnerSpend },
  { kind: 'RELEASE_MILESTONE' as const, prepare: prepareCopiedRelease },
];

describe.skipIf(!LIVE)('settle-spend adopts founder-signed settlements a third party executed first (final-1, MockRail)', { timeout: LIVE_TIMEOUT_MS }, () => {
  let live: Live;
  beforeAll(async () => {
    live = await openLive();
  }, LIVE_TIMEOUT_MS);
  afterEach(async () => {
    await clearHalt(live.db.$client, silentLogger, { by: 'test-teardown', note: 'next test', ackThrough: 'all', abandonPause: true });
  });
  afterAll(async () => {
    await live?.close();
  });

  const q = () => live.db.$client;
  const payment = async (w: World, id: string) =>
    (await q().query('select kind, state, payout_status, payout_attempt, tx_hash, settlement_id from payments where facility_id = $1 and id = $2', [w.facilityId, id])).rows[0];
  const payouts = async (c: CopiedCase) =>
    (await q().query(`select amount_minor::text as amount_minor, destination from hogee_worker.mock_payouts where reference_id like $1 || ':%'`, [c.copyTx.toLowerCase()])).rows;
  const settlementState = async (w: World, id: Hex) =>
    Number(await live.client.readContract({ address: w.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: 'settlementState', args: [id] }));

  const alertCount = async (w: World, reasonCode: string) =>
    Number((await q().query('select count(*)::int as n from traces where facility_id = $1 and reason_code = $2', [w.facilityId, reasonCode])).rows[0].n);
  const capped = (w: World) => w.deps({ client: cappedLogs(live.client) });

  it.each(CASES)('$kind: the copy is adopted, paid once and confirmed on-chain; the relayer row stays REVERTED', async ({ kind, prepare }) => {
    const c = await prepare(live);
    const { w } = c;
    const adopted = adoptedFounderRowId(kind, c.settlementId);
    expect((await payment(w, c.sourceId)).state).toBe('REVERTED');
    expect(await settlementState(w, c.settlementId)).toBe(0); // open, and no row of ours would settle it

    const first = await runSettle(capped(w), [w.facilityId]);
    expect(first[0]?.payments).toEqual([expect.objectContaining({ paymentId: adopted, step: 'request_payout', detail: 'SUCCEEDED' })]);
    expect(await payment(w, adopted)).toMatchObject({ kind, tx_hash: c.copyTx.toLowerCase(), settlement_id: c.settlementId.toLowerCase() });
    expect(await payouts(c)).toEqual([{ amount_minor: c.amountMinor.toString(), destination: payoutAccountRef(c.destination) }]);
    const alert = await q().query(`select summary from traces where facility_id = $1 and kind = 'ALERT' and reason_code = 'EXECUTED_BY_THIRD_PARTY'`, [w.facilityId]);
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0].summary).toContain(c.copyTx.toLowerCase());

    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ paymentId: adopted, step: 'confirm' })]);
    await live.test.mine({ blocks: 1 });
    await finalize(w);
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ paymentId: adopted, step: 'close', detail: 'SETTLED' })]);
    expect(await payment(w, adopted)).toMatchObject({ state: 'SETTLED', payout_status: 'SUCCEEDED', payout_attempt: 1 });
    expect(await settlementState(w, c.settlementId)).toBe(1);
    const confirmed = await live.client.getLogs({ address: w.deployment.contracts.Treasury.address, event: CONFIRMED, fromBlock: BigInt(w.deployment.blockNumber), toBlock: 'latest' });
    expect(confirmed.map((l) => l.args.settlementId?.toLowerCase())).toEqual([c.settlementId.toLowerCase()]);

    // Exactly once: later passes adopt and pay nothing more, and nothing halted.
    expect((await runSettle(w.deps(), [w.facilityId]))[0]?.payments).toEqual([]);
    expect(await payouts(c)).toHaveLength(1);
    expect((await payment(w, c.sourceId)).state).toBe('REVERTED');
    expect(await activeHalt(q())).toBeNull();
    expect((await q().query(`select count(*)::int as n from traces where facility_id = $1 and reason_code = 'EXECUTED_BY_THIRD_PARTY'`, [w.facilityId])).rows[0].n).toBe(1);
  });

  it('never adopts a settlement that is already closed on-chain; alerts once and retires it (audit run-4 M4)', async () => {
    const c = await prepareCopiedOwnerSpend(live);
    const { w } = c;
    // The settlement was confirmed (here by the oracle key used outside the worker) before the worker adopted it.
    const oracle = createWalletClient({ account: w.signers.oracle, chain: anvil, transport: http(RPC_URL) });
    const hash = await oracle.sendTransaction({ to: w.deployment.contracts.Treasury.address, data: buildConfirmSettlement({ settlementId: c.settlementId, payoutRefHash: `0x${'02'.repeat(32)}` }).data });
    expect((await live.client.waitForTransactionReceipt({ hash })).status).toBe('success');
    await finalizeAll(live);
    expect((await runSettle(capped(w), [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ step: 'error', detail: expect.stringContaining('already confirmed or failed') })]);
    expect(await payment(w, adoptedFounderRowId('OWNER_SPEND', c.settlementId))).toBeUndefined();
    expect((await runSettle(capped(w), [w.facilityId]))[0]?.payments).toEqual([]);
    expect(await alertCount(w, 'ADOPTION_SETTLEMENT_CLOSED')).toBe(1);
    expect(await payouts(c)).toHaveLength(0);
  });

  it('a copy that is not the founder-signed row alerts once as a mismatch, then is never looked up again (M3, L5)', async () => {
    const c = await prepareCopiedOwnerSpend(live);
    const { w } = c;
    await q().query('update payments set amount_minor = amount_minor + 1 where facility_id = $1 and id = $2', [w.facilityId, c.sourceId]);
    expect((await runSettle(capped(w), [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ step: 'error', detail: 'the finalized OwnerSpent is not the founder-signed row' })]);
    expect((await runSettle(capped(w), [w.facilityId]))[0]?.payments).toEqual([]);
    expect(await alertCount(w, 'ADOPTION_MISMATCH')).toBe(1);
    expect(await alertCount(w, 'EXECUTED_BY_THIRD_PARTY')).toBe(0);
  });

  it('an RPC without historical state alerts once and retries quietly; adoption completes once it can (M3)', async () => {
    const c = await prepareCopiedOwnerSpend(live);
    const { w } = c;
    const head = (await live.client.getBlock({ blockTag: 'finalized' })).number;
    const archiveless = w.deps({ client: noHistory(cappedLogs(live.client), head) });
    expect((await runSettle(archiveless, [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ step: 'error', detail: expect.stringContaining('historical state') })]);
    expect((await runSettle(archiveless, [w.facilityId]))[0]?.payments).toEqual([]);
    expect(await alertCount(w, 'ADOPTION_HISTORY_UNAVAILABLE')).toBe(1);
    expect((await runSettle(capped(w), [w.facilityId]))[0]?.payments).toEqual([expect.objectContaining({ paymentId: adoptedFounderRowId('OWNER_SPEND', c.settlementId), step: 'request_payout' })]);
  });

  it('adopts a reserve withdrawal through an RPC that caps eth_getLogs at 10 blocks (audit run-4 L7)', async () => {
    const w = await newWorld(live, { final: true });
    const loosenId = await withdrawReserve(w, 4_000n);
    const out = await runSettle(capped(w), [w.facilityId]);
    expect(out[0]?.payments).toEqual([expect.objectContaining({ paymentId: `reserve:${loosenId}`, step: 'request_payout', detail: 'SUCCEEDED' })]);
  });
});
