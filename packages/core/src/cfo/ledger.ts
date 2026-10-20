/**
 * The CFO's view of the records: validated inputs, UTC day buckets and which payments count (cash basis).
 *
 * Counting rules (mirror api services/dashboard.ts minedByLine): a payment counts once it has a receipt (INCLUDED,
 * FINALIZED, SETTLEMENT_REQUESTED, SETTLED); SETTLEMENT_FAILED is left out (failSettlement returned the amount to the
 * pocket). Operating spend = SPEND + OWNER_SPEND by line; agent spend = SPEND only (the burn the agent's own guard reacts
 * to: it never tightens on the founder's own spending or on escrow). Supplier cost = RELEASE_MILESTONE, plus a FUND_MILESTONE
 * that completed an autoRelease milestone (the escrow paid the supplier in that transaction; no release row follows),
 * so every milestone is counted once. Any other FUND_MILESTONE is escrowed, not cost. WITHDRAW_RESERVE moves reserve BU
 * (shown in the reserve section), not budget. Records dated after `now` are ignored.
 */
import type { LineKey, PaymentState } from "../schemas/enums";
import type { Hex32, Id } from "../schemas/primitives";
import { UINT128_MAX } from "../money/index";
import { CfoInputError, type CfoInputs } from "./types";

export const DAY_MS = 86_400_000;
export const SECONDS_PER_DAY = 86_400n;
/** Days in the moving average (MA7). */
export const MA_DAYS = 7;
/** Fewer days of data than this → no projection (VISION §8: never invent). */
export const MIN_SAMPLE_DAYS = 3;
export const SERIES_DAYS = 30;

const COUNTED_STATES: ReadonlySet<PaymentState> = new Set(["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED"]);

/** Whole UTC days since 1970-01-01. */
export const epochDay = (ms: number): number => Math.floor(ms / DAY_MS);
/** YYYY-MM-DD of a UTC epoch day. */
export const isoDay = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

export interface LedgerOutflow {
  readonly lineKey: LineKey;
  readonly amount: bigint;
  readonly day: number;
}

export interface LedgerSale {
  readonly saleId: Id;
  readonly amount: bigint;
  readonly atMs: number;
  readonly day: number;
  readonly txHash: Hex32 | null;
}

export interface Ledger {
  readonly nowMs: number;
  readonly nowSec: bigint;
  readonly today: number;
  readonly operating: readonly LedgerOutflow[];
  /** The agent's own payments (SPEND), a subset of `operating`. */
  readonly agentSpend: readonly LedgerOutflow[];
  readonly supplierCost: readonly LedgerOutflow[];
  /** Sorted by time, then saleId. */
  readonly sales: readonly LedgerSale[];
  /** The first day with a counted record, or null when there is none. */
  readonly firstDay: number | null;
  /** Days from firstDay to today, inclusive (0 when there is no record). */
  readonly sampleDays: number;
}

function money(v: bigint, label: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > UINT128_MAX) throw new CfoInputError(`${label} must be a bigint in 0..uint128`);
  return v;
}

function timeOf(d: Date, label: string): number {
  const ms = d instanceof Date ? d.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new CfoInputError(`${label} is not a valid date`);
  return ms;
}

function bps(v: number, label: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 10_000) throw new CfoInputError(`${label} must be integer bps 0..10000`);
  return v;
}

/** Unix seconds as bigint (a digit string or a bigint). */
export function unixSeconds(v: bigint | string, label: string): bigint {
  if (typeof v === "bigint" && v >= 0n) return v;
  if (typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v)) return BigInt(v);
  throw new CfoInputError(`${label} must be unix seconds`);
}

function checkLinesAndReserve(i: CfoInputs): void {
  const seen = new Set<string>();
  for (const l of i.lines) {
    if (seen.has(l.lineKey)) throw new CfoInputError(`duplicate line ${l.lineKey}`);
    seen.add(l.lineKey);
    for (const k of ["allocatedMinor", "spentMinor", "escrowedMinor", "availableMinor", "perTxCapMinor", "windowCapMinor", "windowSpentMinor"] as const) {
      money(l[k], `${l.lineKey}.${k}`);
    }
    unixSeconds(l.validUntil, `${l.lineKey}.validUntil`);
    if (l.pacingMinor !== undefined) money(l.pacingMinor, `${l.lineKey}.pacingMinor`);
    if (l.windowSeconds !== undefined) money(l.windowSeconds, `${l.lineKey}.windowSeconds`);
    if (l.committedPerTxCapMinor !== undefined) money(l.committedPerTxCapMinor, `${l.lineKey}.committedPerTxCapMinor`);
    if (l.committedWindowCapMinor !== undefined) money(l.committedWindowCapMinor, `${l.lineKey}.committedWindowCapMinor`);
  }
  const r = i.reserve;
  bps(r.rateBps, "reserve.rateBps");
  bps(i.reserveBps, "reserveBps");
  if (money(r.withdrawnMinor, "reserve.withdrawnMinor") > money(r.skimmedMinor, "reserve.skimmedMinor")) {
    throw new CfoInputError("reserve withdrawn exceeds what was set aside");
  }
  if (i.releasedMinor !== undefined) money(i.releasedMinor, "releasedMinor");
  if (i.fundedMinor !== undefined) money(i.fundedMinor, "fundedMinor");
  if (i.stage) {
    money(i.stage.targetMinor, "stage.targetMinor");
    timeOf(i.stage.deadline, "stage.deadline");
  }
  for (const a of i.agentActions) timeOf(new Date(a.at), "agentAction.at");
}

interface CountedPayments {
  readonly operating: LedgerOutflow[];
  readonly agentSpend: LedgerOutflow[];
  readonly supplierCost: LedgerOutflow[];
  readonly days: number[];
}

function readPayments(i: CfoInputs, nowMs: number): CountedPayments {
  const operating: LedgerOutflow[] = [];
  const agentSpend: LedgerOutflow[] = [];
  const supplierCost: LedgerOutflow[] = [];
  const days: number[] = [];
  for (const p of i.payments) {
    const amount = money(p.amountMinor, `payment ${p.kind} amount`);
    const ms = timeOf(p.at, `payment ${p.kind} at`);
    if ((p.kind === "WITHDRAW_RESERVE") !== (p.lineKey === null)) throw new CfoInputError(`payment ${p.kind}: lineKey is null exactly for WITHDRAW_RESERVE`);
    if (ms > nowMs || !COUNTED_STATES.has(p.state) || p.lineKey === null) continue;
    const row = { lineKey: p.lineKey, amount, day: epochDay(ms) };
    if (p.kind === "SPEND" || p.kind === "OWNER_SPEND") operating.push(row);
    if (p.kind === "SPEND") agentSpend.push(row);
    else if (p.kind === "RELEASE_MILESTONE" || (p.kind === "FUND_MILESTONE" && p.autoReleased === true)) supplierCost.push(row);
    else continue;
    days.push(row.day);
  }
  return { operating, agentSpend, supplierCost, days };
}

function readSales(i: CfoInputs, nowMs: number): LedgerSale[] {
  const sales: LedgerSale[] = [];
  for (const s of i.sales) {
    const amount = money(s.amountMinor, `sale ${s.saleId} amount`);
    const ms = timeOf(s.at, `sale ${s.saleId} at`);
    if (ms <= nowMs) sales.push({ saleId: s.saleId, amount, atMs: ms, day: epochDay(ms), txHash: s.txHash });
  }
  return sales.sort((a, b) => a.atMs - b.atMs || (a.saleId < b.saleId ? -1 : a.saleId > b.saleId ? 1 : 0));
}

/** Validates the inputs (throws CfoInputError: fail closed) and reads the counted records up to `now`. */
export function readLedger(i: CfoInputs): Ledger {
  const nowMs = timeOf(i.now, "now");
  checkLinesAndReserve(i);
  const today = epochDay(nowMs);
  const { operating, agentSpend, supplierCost, days } = readPayments(i, nowMs);
  const sales = readSales(i, nowMs);
  const all = [...days, ...sales.map((s) => s.day)];
  const firstDay = all.reduce<number | null>((m, d) => (m === null || d < m ? d : m), null);
  return {
    nowMs,
    nowSec: BigInt(Math.floor(nowMs / 1000)),
    today,
    operating,
    agentSpend,
    supplierCost,
    sales,
    firstDay,
    sampleDays: firstDay === null ? 0 : today - firstDay + 1,
  };
}

/** Sum of the rows whose day is in [from, to]. */
export function sumDays(rows: readonly { readonly amount: bigint; readonly day: number }[], from: number, to: number): bigint {
  let s = 0n;
  for (const r of rows) if (r.day >= from && r.day <= to) s += r.amount;
  return s;
}

/** Days in the moving average: min(7, sampleDays); 0 when there is no data. */
export const maDays = (l: Ledger): number => Math.min(MA_DAYS, l.sampleDays);
