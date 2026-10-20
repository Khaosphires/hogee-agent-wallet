/**
 * cfo-guard reads a bounded window (audit run-9 lead 3). Before, every pass dated the facility's ALL-time payments and
 * sales with one uncached getBlock per distinct block. Now only the last 30 chain days are read and dated, plus the
 * earliest record of each kind before them (so core sees the same first-record day and "any revenue"), through a
 * block-time LRU, so a second pass makes no block read but the genesis check. Parity: proposeTightenings gives exactly
 * what the full history gives. Needs TEST_DATABASE_URL; the chain is a stub (no Anvil).
 */
import { RINA_IDS, proposeTightenings, type CfoInputs, type CfoPaymentIn, type CfoSaleIn } from '@hogee/core';
import { toBytes32Tag } from '@hogee/chain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlockTimeCache } from '../../src/chain/block-times';
import type { ChainSnapshot } from '../../src/chain/snapshot';
import { guardActions, readGuardInputs, taxPayeeOf } from '../../src/jobs/cfo-guard-inputs';
import { committed, NOW, rinaSnapshot } from '../support/fixtures';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';

const HOUR = 3_600n;
/** Head block: 100 days of one block an hour. */
const B = 2_400n;
const timeOf = (block: bigint): bigint => NOW - (B - block) * HOUR;
const DAY_BLOCKS = 24n;

interface StubChain {
  getBlockCalls: number;
  client: never;
}

/** getBlock answers `timeOf`; revenueLedger answers `ledger`. Counts getBlock calls. */
function stubChain(ledger: readonly [bigint, bigint, bigint]): StubChain {
  const s: StubChain = { getBlockCalls: 0, client: undefined as never };
  s.client = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      s.getBlockCalls += 1;
      return { number: blockNumber, hash: blockNumber === 0n ? `0x${'11'.repeat(32)}` : `0x${blockNumber.toString(16).padStart(64, '0')}`, timestamp: timeOf(blockNumber) };
    },
    readContract: async () => ledger,
  } as never;
  return s;
}

const snapshotAt = (block: bigint): ChainSnapshot => ({ ...rinaSnapshot({ now: timeOf(block) }), blockNumber: block });
const deployment = { contracts: { Treasury: { address: `0x${'cd'.repeat(20)}` } } } as never;

describe.skipIf(!DB_URL)('readGuardInputs: a bounded window (Postgres)', { timeout: 120_000 }, () => {
  let t: TestDb;
  const stamp = Date.now();
  const facA = `fac-cfo-win-a-${stamp}`;
  const facB = `fac-cfo-win-b-${stamp}`;
  const q = (sql: string, values: unknown[]) => t.db.$client.query(sql, values);

  async function facility(id: string): Promise<void> {
    await q(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, '1000000', 'MYR', 300, $2, 'loop-1', 31337)`,
      [id, `0x${'ab'.repeat(20)}`],
    );
    await q(`insert into payees (id, facility_id, kind, display_name, payout_account_hash, status) values ($1, $2, 'platform', 'Ads', $3, 'BOUND')`, [
      RINA_IDS.adsPayeeId,
      id,
      `0x${'0a'.repeat(32)}`,
    ]);
  }

  /** FINALIZED ADS spends of `amount` at each block (signed columns within every CHECK; never broadcast). */
  async function spends(fac: string, blocks: readonly bigint[], amount: string): Promise<void> {
    await q(
      `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state,
         signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, decision_id, rationale_hash, trace_id)
       select 'pay-' || $1 || '-' || b, $1, 'SPEND', '0x' || md5('i' || $1 || b) || md5('j' || b), 'ADS', $2, $3, $4,
              '0x' || md5('v' || $1 || b) || md5('w' || b), 1, 'FINALIZED', '0x' || substr(md5('s' || $1 || b), 1, 20) || substr(md5('t' || b), 1, 20), 31337,
              '0x02' || md5('r' || b), b, '0x' || md5('h' || $1 || b) || md5('k' || b), b, gen_random_uuid(), '0x' || md5('q' || $1 || b) || md5('z' || b), 'trace:t:' || b
         from unnest($5::bigint[]) as b`,
      [fac, toBytes32Tag('ADS').toLowerCase(), RINA_IDS.adsPayeeId, amount, blocks.map(String)],
    );
  }

  /** Recorded sales (tx set) with a FINALIZED SalesOracle.recordSale action at each block. */
  async function sales(fac: string, blocks: readonly bigint[], amount: string): Promise<void> {
    await q(
      `insert into sales (id, facility_id, stripe_event_id, sale_id_hash, amount_bucket, tx_hash)
       select 'sale-' || b, $1, 'evt_' || b, '0x' || md5('sale' || $1 || b) || md5('x' || b), $2, '0x' || md5('stx' || $1 || b) || md5('y' || b)
         from unnest($3::bigint[]) as b`,
      [fac, amount, blocks.map(String)],
    );
    await q(
      `insert into chain_actions (id, facility_id, kind, ref_id, state, signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, request_json)
       select 'act-sale-' || b, $1, 'SalesOracle.recordSale', 'sale-' || b, 'FINALIZED', '0x' || substr(md5('o' || $1), 1, 20) || substr(md5('p' || $1), 1, 20), 31337,
              '0x02' || md5('raw' || b), b, '0x' || md5('stx' || $1 || b) || md5('y' || b), b, '{}'::jsonb
         from unnest($2::bigint[]) as b`,
      [fac, blocks.map(String)],
    );
  }

  /** The same inputs with every record of the facility dated (the old all-history read), for the parity check. */
  function fullHistory(windowed: CfoInputs, spendBlocks: readonly bigint[], spendAmount: bigint, saleBlocks: readonly bigint[], saleAmount: bigint): CfoInputs {
    const at = (b: bigint) => new Date(Number(timeOf(b)) * 1000);
    const payments: CfoPaymentIn[] = spendBlocks.map((b) => ({ kind: 'SPEND', lineKey: 'ADS', amountMinor: spendAmount, state: 'FINALIZED', at: at(b), txHash: null }));
    const salesIn: CfoSaleIn[] = saleBlocks.map((b) => ({ saleId: `sale-${b}` as never, amountMinor: saleAmount, at: at(b), txHash: null }));
    return { ...windowed, payments, sales: salesIn };
  }

  const ctxOf = (fac: string) => ({ facilityId: fac, currency: 'MYR' as const, taxPayeeId: taxPayeeOf('MYR'), snapshot: snapshotAt(B), committed });
  const strip = (i: CfoInputs) => proposeTightenings(i).map((p) => ({ ...p, newValue: p.newValue.toString() }));

  // A: 2,000 recorded sales over 100 days (one block an hour), an old ADS spend 83 days ago and three this week.
  const saleBlocksA = Array.from({ length: 2_000 }, (_, k) => BigInt(k + 1));
  const spendBlocksA = [400n, B - 2n * DAY_BLOCKS, B - DAY_BLOCKS, B];
  // B: one sale 50 days ago, one ADS spend 40 days ago, three ADS spends this week: only the anchors tell core that
  // the first record is 40 days old (a 7-day average, no burn) and that there is revenue (the reserve raise).
  const saleBlocksB = [B - 50n * DAY_BLOCKS];
  const spendBlocksB = [B - 40n * DAY_BLOCKS, B - 2n * DAY_BLOCKS, B - DAY_BLOCKS, B];

  beforeAll(async () => {
    t = await openTestDb();
    await facility(facA);
    await facility(facB);
    await spends(facA, spendBlocksA, '20000');
    await sales(facA, saleBlocksA, '10000');
    await spends(facB, spendBlocksB, '20000');
    await sales(facB, saleBlocksB, '10000');
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('dates only the 30-day window (plus anchors and a logarithmic search), and a second pass reads only the genesis', async () => {
    const chain = stubChain([1_000n, 0n, 2_000n]);
    const cache = new BlockTimeCache();
    const inputs = await readGuardInputs({ client: chain.client, deployment }, t.db.$client, ctxOf(facA), { cache });
    const inWindow = new Set([...saleBlocksA, ...spendBlocksA].filter((b) => timeOf(b) >= NOW - 30n * 86_400n - 86_400n));
    // genesis + the window's blocks + two anchors + at most ~2 probes per halving of 2,400 blocks
    expect(chain.getBlockCalls).toBeLessThanOrEqual(1 + inWindow.size + 2 + 2 * 12 + 2);
    expect(chain.getBlockCalls).toBeLessThan(saleBlocksA.length / 2);
    expect(inputs.sales.length).toBeLessThan(saleBlocksA.length / 2);

    const before = chain.getBlockCalls;
    await readGuardInputs({ client: chain.client, deployment }, t.db.$client, ctxOf(facA), { cache });
    expect(chain.getBlockCalls - before).toBe(1); // the genesis check only: every other block is cached
  });

  it('parity: proposeTightenings over the window equals the full history (big history)', async () => {
    const chain = stubChain([1_000n, 600n, 2_000n]);
    const windowed = await readGuardInputs({ client: chain.client, deployment }, t.db.$client, ctxOf(facA), { cache: new BlockTimeCache() });
    const full = fullHistory(windowed, spendBlocksA, 20_000n, saleBlocksA, 10_000n);
    expect(strip(windowed)).toEqual(strip(full));
    expect(strip(full).map((p) => p.action)).toEqual(['RAISE_RESERVE_BPS']);
  });

  it('parity: the first-record day and "any revenue" come from records older than the window (anchors)', async () => {
    const chain = stubChain([1_000n, 600n, 1_000n]);
    const windowed = await readGuardInputs({ client: chain.client, deployment }, t.db.$client, ctxOf(facB), { cache: new BlockTimeCache() });
    const full = fullHistory(windowed, spendBlocksB, 20_000n, saleBlocksB, 10_000n);
    expect(strip(windowed)).toEqual(strip(full));
    // 60,000 in 3 days is no burn over a 7-day average (the first record is 40 days old), and the old sale is revenue.
    expect(strip(full).map((p) => p.action)).toEqual(['RAISE_RESERVE_BPS']);
  });

  it('a facility with no record reads no block but the genesis', async () => {
    const fac = `fac-cfo-win-empty-${stamp}`;
    await facility(fac);
    const chain = stubChain([0n, 0n, 0n]);
    const inputs = await readGuardInputs({ client: chain.client, deployment }, t.db.$client, ctxOf(fac), { cache: new BlockTimeCache() });
    expect(inputs.payments).toEqual([]);
    expect(inputs.sales).toEqual([]);
    expect(chain.getBlockCalls).toBeLessThanOrEqual(1);
  });

  // fixr-cfo (re-check LOW 3): core skips a line tightened within its window, so only a tightening that may have
  // landed starts one: a REVERTED row and a row refused before signing do not (their slot stays used for that day).
  it('agent actions are the tightenings that may have landed: not REVERTED, not refused before signing', async () => {
    const fac = `fac-cfo-acts-${stamp}`;
    await facility(fac);
    const request = (day: number) => ({ source: 'cfo-guard', action: 'LOWER_WINDOW_CAP', lineKey: 'ADS', newValue: '52500', reason: 'Ads spent fast.', decisionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', chainTime: String(NOW - BigInt(day) * 86_400n), traceId: `trace:cfo-guard:${day}:ADS` });
    const signed = (id: string, state: string, day: number) =>
      q(
        `insert into chain_actions (id, facility_id, kind, state, signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, request_json)
         values ($1, $2, 'Treasury.tighten', $3, $4, 31337, '0x02aa', $5, $6, 10, $7)`,
        [id, fac, state, `0x${stamp.toString(16).padStart(40, '0')}`, day, `0x${stamp.toString(16).padStart(32, '0')}${day.toString(16).padStart(32, '0')}`, JSON.stringify(request(day))],
      );
    await signed('cfo-guard:1:ADS', 'INCLUDED', 1);
    await signed('cfo-guard:2:ADS', 'REVERTED', 2);
    await q(`insert into chain_actions (id, facility_id, kind, state, revert_reason, request_json) values ('cfo-guard:3:ADS', $1, 'Treasury.tighten', 'PENDING', 'REFUSED: fee cap', $2)`, [fac, JSON.stringify(request(3))]);
    await q(`insert into chain_actions (id, facility_id, kind, state, request_json) values ('cfo-guard:4:ADS', $1, 'Treasury.tighten', 'PENDING', $2)`, [fac, JSON.stringify(request(4))]);
    expect((await guardActions(t.db.$client, fac)).map((a) => a.id).sort()).toEqual(['cfo-guard:1:ADS', 'cfo-guard:4:ADS']);
  });
});
