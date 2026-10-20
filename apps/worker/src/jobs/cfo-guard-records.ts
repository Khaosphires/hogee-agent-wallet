/**
 * The mirrored records cfo-guard dates (cfo-guard-inputs.ts), in a bounded window (audit run-9 lead 3): mined payments
 * and recorded sales with from ≤ block ≤ B, plus the earliest record of each class below `from` (the anchors core needs
 * for the first-record day and "any revenue"), and the search for `from` itself. SQL only: block timestamps come from
 * the caller (chain/block-times.ts). Same row filters as before the window, so a record is read exactly as before.
 */
import type { Hex32, Id, LineKey, PaymentKind, PaymentState } from '@hogee/core';
import { rows, type Pg } from '../store/pg';

const MINED_STATES = ['INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED'] as const;
const LANDED = ['INCLUDED', 'FINALIZED'] as const;

export interface PaymentRow {
  readonly kind: PaymentKind;
  readonly lineKey: LineKey | null;
  readonly amountMinor: bigint;
  readonly state: PaymentState;
  readonly block: bigint;
  readonly txHash: Hex32 | null;
  readonly autoReleased: boolean;
}

export interface SaleRow {
  readonly saleId: Id;
  readonly amountMinor: bigint;
  readonly txHash: Hex32 | null;
  readonly block: bigint;
}

/** Mined payments of the facility at or below $3 (`block` stays numeric so the anchors order by it). */
const MINED = `select p.id, p.kind, p.line_key, p.amount_minor::text as amount_minor, p.state, p.block, p.tx_hash,
         (p.kind = 'FUND_MILESTONE' and exists (
            select 1 from escrow_milestones m
             where m.facility_id = p.facility_id and m.order_id = p.order_id and m.idx = p.milestone_idx and m.auto_release
               and (m.released_minor > 0 or m.funded_minor >= m.amount_minor))) as auto_released
    from payments p
   where p.facility_id = $1 and p.state::text = any($2::text[]) and p.block is not null and p.block <= $3`;

type PaymentDbRow = { kind: PaymentKind; line_key: LineKey | null; amount_minor: string; state: PaymentState; block: string; tx_hash: string | null; auto_released: boolean };

const toPayment = (p: PaymentDbRow): PaymentRow => ({
  kind: p.kind,
  lineKey: p.line_key,
  amountMinor: BigInt(p.amount_minor),
  state: p.state,
  block: BigInt(p.block),
  txHash: p.tx_hash as Hex32 | null,
  autoReleased: p.auto_released,
});

/** Mined payments with from ≤ block ≤ to. */
export async function minedPayments(q: Pg, facilityId: string, from: bigint, to: bigint): Promise<PaymentRow[]> {
  const out = await rows<PaymentDbRow>(q, `${MINED} and p.block >= $4`, [facilityId, MINED_STATES, to.toString(), from.toString()]);
  return out.map(toPayment);
}

/**
 * The earliest mined payment below `before` of each class core tells apart (kind, state, a line or none, auto-released
 * or not). Core's own rules then decide which of them count, so the earliest COUNTED record before the window is among
 * them without restating those rules here.
 */
export async function paymentAnchors(q: Pg, facilityId: string, before: bigint): Promise<PaymentRow[]> {
  const out = await rows<PaymentDbRow>(
    q,
    `select distinct on (r.kind, r.state, r.line_key is null, r.auto_released) r.*
       from (${MINED} and p.block < $4) r
      order by r.kind, r.state, r.line_key is null, r.auto_released, r.block, r.id`,
    [facilityId, MINED_STATES, before.toString(), before.toString()],
  );
  return out.map(toPayment);
}

/** Recorded sales (tx set, bucket > 0) dated by their first landed recordSale action at or below $3. */
const RECORDED = `select s.id, s.amount_bucket::text as amount_bucket, s.tx_hash, a.block
    from sales s
    cross join lateral (
      select block from chain_actions a
       where a.facility_id = s.facility_id and a.kind = 'SalesOracle.recordSale' and a.ref_id = s.id
         and a.state::text = any($2::text[]) and a.block is not null
       order by a.block limit 1) a
   where s.facility_id = $1 and s.tx_hash is not null and s.amount_bucket > 0 and a.block <= $3`;

type SaleDbRow = { id: string; amount_bucket: string; tx_hash: string | null; block: string };

const toSale = (s: SaleDbRow): SaleRow => ({ saleId: s.id as Id, amountMinor: BigInt(s.amount_bucket), txHash: s.tx_hash as Hex32 | null, block: BigInt(s.block) });

/** Recorded sales with from ≤ block ≤ to. */
export async function recordedSales(q: Pg, facilityId: string, from: bigint, to: bigint): Promise<SaleRow[]> {
  const out = await rows<SaleDbRow>(q, `${RECORDED} and a.block >= $4`, [facilityId, LANDED, to.toString(), from.toString()]);
  return out.map(toSale);
}

/** The earliest recorded sale below `before` (an anchor: it makes "any revenue" true), or none. */
export async function saleAnchor(q: Pg, facilityId: string, before: bigint): Promise<SaleRow[]> {
  const out = await rows<SaleDbRow>(q, `${RECORDED} and a.block < $4 order by a.block, s.id limit 1`, [facilityId, LANDED, before.toString(), before.toString()]);
  return out.map(toSale);
}

/** The lowest record block (a mined payment, or a recorded sale's landed recordSale) in [from, to]; null when none. */
export async function firstRecordBlock(q: Pg, facilityId: string, from: bigint, to: bigint): Promise<bigint | null> {
  const [r] = await rows<{ block: string | null }>(
    q,
    `select least(
       (select min(p.block) from payments p
         where p.facility_id = $1 and p.state::text = any($2::text[]) and p.block >= $4 and p.block <= $5),
       (select min(a.block) from chain_actions a join sales s on s.facility_id = a.facility_id and s.id = a.ref_id
         where a.facility_id = $1 and a.kind = 'SalesOracle.recordSale' and a.state::text = any($3::text[]) and a.block >= $4 and a.block <= $5
           and s.tx_hash is not null and s.amount_bucket > 0))::text as block`,
    [facilityId, MINED_STATES, LANDED, from.toString(), to.toString()],
  );
  return r?.block ? BigInt(r.block) : null;
}

/**
 * The window's first block: every record at or above it is dated at or after `fromTime`, every record below it
 * before. Chain time never decreases with the block number, so this is a binary search over [first record, head]
 * whose probes snap to the facility's own record blocks (their timestamps are cached across passes): at most about
 * log2(head − first record) rounds, each one SQL read and at most one block timestamp. null when there is no record.
 */
export async function windowStart(q: Pg, facilityId: string, head: bigint, fromTime: bigint, timeOf: (block: bigint) => Promise<bigint>): Promise<bigint | null> {
  let lo = await firstRecordBlock(q, facilityId, 0n, head);
  if (lo === null) return null;
  if ((await timeOf(lo)) >= fromTime) return lo;
  // Invariant: lo is a record dated before fromTime; every record at or above hi is dated at or after it.
  let hi = head + 1n;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    const r = await firstRecordBlock(q, facilityId, mid, hi - 1n);
    if (r !== null && (await timeOf(r)) < fromTime) lo = r;
    else hi = mid;
  }
  return hi;
}
