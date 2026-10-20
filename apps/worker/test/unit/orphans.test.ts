/**
 * Orphan classification (T29) with a fake query: a MilestoneEscrow `MilestoneFunded` is agent-key use, an orphan unless
 * it matches a FUND_MILESTONE payment the worker signed (same off-chain intent id and rationaleHash, and stored bytes
 * that hash to the event's tx and recover to the worker's agent key), exactly like `Spent` against SPEND rows.
 */
import { buildFundMilestone, fundMilestoneIntentId, type DecodedHogeeLog } from '@hogee/chain';
import { keccak256, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyOrphan, orphanPauseId } from '../../src/jobs/orphans';
import type { Pg } from '../../src/store/pg';

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const ORDER = h(0xabc);
const RATIONALE = h(0x8);
const ESCROW: Address = '0x000000000000000000000000000000000000e5c0';
const FACILITIES = ['fac-a', 'fac-b'];
const agent = privateKeyToAccount(generatePrivateKey());
const SCOPE = { facilityIds: FACILITIES, agent: agent.address };

interface Candidate {
  facility_id: string;
  id: string;
  kind: string;
  rationale_hash: string | null;
  tx_hash: string | null;
  superseded_tx_hashes: string[] | null;
  raw_signed_tx: string | null;
}

/** An EIP-1559 tx `account` signed (the bytes a payments row stores) and its hash (the event's transactionHash). */
async function signed(account: PrivateKeyAccount, nonce = 3): Promise<{ raw: Hex; hash: Hex }> {
  const data = buildFundMilestone({ orderId: ORDER, idx: 1, amountMinor: 40_000n, decisionId: h(0x9), rationaleHash: RATIONALE }).data;
  const raw = await account.signTransaction({ type: 'eip1559', chainId: 31337, nonce, to: ESCROW, data, value: 0n, gas: 200_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  return { raw, hash: keccak256(raw) };
}

let OURS: { raw: Hex; hash: Hex };
let TX: Hex;
beforeAll(async () => {
  OURS = await signed(agent);
  TX = OURS.hash;
});

function fakeQuery(found: Candidate[]): Pg & { calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  const q = {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: found };
    },
  };
  return q as unknown as Pg & { calls: typeof calls };
}

function funded(over: Partial<{ amountMinor: bigint; fundedTotalMinor: bigint; rationaleHash: Hex }> = {}): DecodedHogeeLog {
  return {
    eventName: 'MilestoneFunded',
    args: { orderId: ORDER, idx: 1, amountMinor: 40_000n, fundedTotalMinor: 100_000n, decisionId: h(0x9), rationaleHash: RATIONALE, ...over },
    transactionHash: TX,
    blockNumber: 42n,
    logIndex: 3,
  } as unknown as DecodedHogeeLog;
}

const row = (over: Partial<Candidate> = {}): Candidate => ({
  facility_id: 'fac-b',
  id: 'fund:1',
  kind: 'FUND_MILESTONE',
  rationale_hash: RATIONALE,
  tx_hash: TX,
  superseded_tx_hashes: [],
  raw_signed_tx: OURS.raw,
  ...over,
});

describe('classifyOrphan: MilestoneFunded', () => {
  const intent = fundMilestoneIntentId({ orderId: ORDER, idx: 1, amountMinor: 40_000n, cumulativeAfterMinor: 100_000n });

  it('looks the funding up by its FUND_MILESTONE intent (orderId, idx, amount, cumulative) across every facility', async () => {
    const q = fakeQuery([row()]);
    expect(await classifyOrphan(q, SCOPE, funded())).toBeNull();
    expect(q.calls[0]?.values).toEqual([FACILITIES, 'FUND_MILESTONE', intent.toLowerCase()]);
  });

  it('a funding no worker row signed is an orphan, keyed by its log for the safety pause', async () => {
    const orphan = await classifyOrphan(fakeQuery([]), SCOPE, funded());
    expect(orphan).toMatchObject({ event: 'MilestoneFunded', reason: 'NO_ROW', intentId: intent, txHash: TX, blockNumber: 42n, logIndex: 3, amountMinor: 40_000n, orderId: ORDER, idx: 1 });
    expect(orphanPauseId(orphan as NonNullable<typeof orphan>)).toBe(`orphan:${TX}:3`);
  });

  it('another rationale, or a tx the row never signed, is an orphan', async () => {
    expect(await classifyOrphan(fakeQuery([row({ rationale_hash: h(0x99) })]), SCOPE, funded())).toMatchObject({ reason: 'RATIONALE_MISMATCH' });
    const other = await signed(agent, 4);
    expect(await classifyOrphan(fakeQuery([row({ tx_hash: other.hash, raw_signed_tx: other.raw })]), SCOPE, funded())).toMatchObject({ reason: 'FOREIGN_TX' });
  });

  it('a fabricated row with the right intent, rationale and tx hash but fake raw bytes does not suppress the halt (M3)', async () => {
    // A DB writer copies the public orphan's intent id, tx hash and rationale hash; it cannot copy a worker signature.
    expect(await classifyOrphan(fakeQuery([row({ raw_signed_tx: null })]), SCOPE, funded())).toMatchObject({ reason: 'FOREIGN_TX' });
    expect(await classifyOrphan(fakeQuery([row({ raw_signed_tx: '0x02deadbeef' })]), SCOPE, funded())).toMatchObject({ reason: 'FOREIGN_TX' });
    const other = await signed(agent, 9); // genuine agent bytes, but not the event's tx
    expect(await classifyOrphan(fakeQuery([row({ raw_signed_tx: other.raw })]), SCOPE, funded())).toMatchObject({ reason: 'FOREIGN_TX' });
    // Bytes that do hash to the event's tx, but signed by another key than the worker's agent.
    const stranger = await signed(privateKeyToAccount(generatePrivateKey()));
    const strangerLog = { ...funded(), transactionHash: stranger.hash } as unknown as DecodedHogeeLog;
    expect(await classifyOrphan(fakeQuery([row({ tx_hash: stranger.hash, raw_signed_tx: stranger.raw })]), SCOPE, strangerLog)).toMatchObject({ reason: 'FOREIGN_TX' });
  });

  it('a superseded hash alone no longer whitelists: the bytes behind it are not stored, so nothing proves them the worker’s', async () => {
    const current = await signed(agent, 5);
    expect(await classifyOrphan(fakeQuery([row({ tx_hash: current.hash, raw_signed_tx: current.raw, superseded_tx_hashes: [TX] })]), SCOPE, funded())).toMatchObject({
      reason: 'FOREIGN_TX',
    });
  });

  it('MilestoneReleased alone is never an orphan: the founder signs it, and the agent alone gets MilestoneLocked', async () => {
    const q = fakeQuery([]);
    const released = { ...funded(), eventName: 'MilestoneReleased' } as unknown as DecodedHogeeLog;
    expect(await classifyOrphan(q, SCOPE, released)).toBeNull();
    expect(q.calls).toHaveLength(0);
  });
});

describe('classifyOrphan: Spent', () => {
  const spent = (): DecodedHogeeLog =>
    ({ eventName: 'Spent', args: { spendId: h(0x11), amountMinor: 7_500n, rationaleHash: RATIONALE }, transactionHash: TX, blockNumber: 9n, logIndex: 0 }) as unknown as DecodedHogeeLog;
  const spendRow = (over: Partial<Candidate> = {}): Candidate => row({ id: 'spend:1', kind: 'SPEND', ...over });

  it('a Spent without a SPEND row is an orphan', async () => {
    const q = fakeQuery([]);
    expect(await classifyOrphan(q, SCOPE, spent())).toMatchObject({ event: 'Spent', reason: 'NO_ROW', intentId: h(0x11) });
    expect(q.calls[0]?.values).toEqual([FACILITIES, 'SPEND', h(0x11)]);
  });

  it('a SPEND row explains a Spent only with the agent-signed bytes of that very tx (M3)', async () => {
    expect(await classifyOrphan(fakeQuery([spendRow()]), SCOPE, spent())).toBeNull();
    expect(await classifyOrphan(fakeQuery([spendRow({ raw_signed_tx: '0x02f8' })]), SCOPE, spent())).toMatchObject({ reason: 'FOREIGN_TX' });
    expect(await classifyOrphan(fakeQuery([spendRow()]), { ...SCOPE, agent: privateKeyToAccount(generatePrivateKey()).address }, spent())).toMatchObject({ reason: 'FOREIGN_TX' });
  });
});

describe('classifyOrphan: OwnerSpent', () => {
  const ownerSpent = (): DecodedHogeeLog =>
    ({ eventName: 'OwnerSpent', args: { spendId: h(0x21), amountMinor: 12_000n }, transactionHash: TX, blockNumber: 9n, logIndex: 0 }) as unknown as DecodedHogeeLog;

  it('accepts the row settle-adopt records for a copy a third party landed first (audit run-4): not an agent effect', async () => {
    // The relayer row ended REVERTED; the adopted row holds the copy's bytes, signed by an account the worker does not hold.
    const stranger = await signed(privateKeyToAccount(generatePrivateKey()));
    const adopted = row({ id: `adopt-owner:${h(0x21)}`, kind: 'OWNER_SPEND', rationale_hash: null, tx_hash: stranger.hash, raw_signed_tx: stranger.raw });
    const q = fakeQuery([adopted]);
    expect(await classifyOrphan(q, SCOPE, ownerSpent())).toBeNull();
    expect(q.calls[0]?.values).toEqual([FACILITIES, 'OWNER_SPEND', h(0x21)]);
  });
});
