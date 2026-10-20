/**
 * In-flight projection input for core.planPacingSlot (§12.4; G0-DECISIONS §1 #1, §7). Treasury's counters
 * (rollingSpent, spent, lineSequence) move only when a spend is mined, so the worker counts every signed spend the
 * snapshot block does not show yet: open rows (SIGNED / BROADCAST / DROPPED) without a receipt at or below the
 * block, and INCLUDED+ rows mined after it. Mined rows at or below the block feed the context's usedIntents and
 * paidInvoices (Treasury.isIntentUsed / isInvoicePaid mirror). In-flight ownerSpends (OWNER_SPEND rows the relayer
 * submitted) count on their line as core's `PacingInFlight.owner`: they take the line's next slot and its balance,
 * never its window.
 */
import type { LineKey, PacingInFlight } from '@hogee/core';
import type { Hex } from 'viem';

/** The payments columns the tick reads (one facility). */
export interface PaymentRow {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly lineKey: LineKey | null;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly intentId: Hex;
  readonly invoiceHash: Hex;
  readonly planVersion: number;
  readonly decisionId: string | null;
  readonly rationaleHash: Hex | null;
  /** raw_signed_tx is set. */
  readonly signed: boolean;
  readonly txHash: Hex | null;
  readonly supersededTxHashes: readonly Hex[];
  readonly block: bigint | null;
}

/** Signed, not yet seen in a block (packages/chain OPEN_STATES for payments). */
export const OPEN_SIGNED_STATES: readonly string[] = ['SIGNED', 'BROADCAST', 'DROPPED'];
/** A receipt was recorded (the row holds its intent; a non-final revert stays INCLUDED). */
export const MINED_STATES: readonly string[] = ['INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED'];
/** Kinds whose amount is Treasury outflow (spent + escrowed ≤ releasedMinor, fundedMinor). */
const OUTFLOW_KINDS: ReadonlySet<string> = new Set(['SPEND', 'OWNER_SPEND', 'FUND_MILESTONE']);

export interface LineInFlight {
  /** Agent spends of the line in flight; on a pacing line each is one slot. */
  readonly slots: number;
  readonly lineMinor: bigint;
  /** In-flight rows (agent or owner) that recovery marked DROPPED (their bytes may still land, or be CANCELLED). */
  readonly dropped: number;
  /** The founder's ownerSpends of the line in flight: each pays the line's next slot, outside the window. */
  readonly owner: { readonly slots: number; readonly lineMinor: bigint };
}

export const NO_LINE_IN_FLIGHT: LineInFlight = Object.freeze({ slots: 0, lineMinor: 0n, dropped: 0, owner: Object.freeze({ slots: 0, lineMinor: 0n }) });

/** core.planPacingSlot's in-flight input for one line: its agent and owner spends, and every outflow in flight. */
export function pacingInFlightOf(line: LineInFlight | undefined, totalMinor: bigint): PacingInFlight {
  const l = line ?? NO_LINE_IN_FLIGHT;
  return {
    slots: l.slots,
    lineMinor: l.lineMinor.toString(),
    owner: { slots: l.owner.slots, lineMinor: l.owner.lineMinor.toString() },
    totalMinor: totalMinor.toString(),
  };
}

export interface InFlightView {
  readonly perLine: ReadonlyMap<LineKey, LineInFlight>;
  /** Every in-flight outflow, any line: counts against releasedMinor / fundedMinor. */
  readonly totalMinor: bigint;
  readonly usedIntents: ReadonlySet<string>;
  readonly paidInvoices: ReadonlySet<string>;
}

/** Block number of the receipt of `hash`, or null when the node has none. Other RPC errors propagate. */
export type ReceiptBlock = (hash: Hex) => Promise<bigint | null>;

/** The block at or below `block` the row was mined in, or null (not mined there). */
export async function minedAt(row: PaymentRow, block: bigint, receiptBlock: ReceiptBlock): Promise<bigint | null> {
  if (MINED_STATES.includes(row.state)) return row.block !== null && row.block <= block ? row.block : null;
  for (const hash of [row.txHash, ...row.supersededTxHashes]) {
    if (hash === null) continue;
    const at = await receiptBlock(hash);
    if (at !== null && at <= block) return at;
  }
  return null;
}

async function minedBy(row: PaymentRow, block: bigint, receiptBlock: ReceiptBlock): Promise<boolean> {
  return (await minedAt(row, block, receiptBlock)) !== null;
}

/** States that released the intent: the row never executes. */
const RELEASED_STATES: readonly string[] = ['POLICY_DENIED', 'REVERTED', 'CANCELLED'];

export interface SlotDayCheck {
  readonly lineKey: LineKey;
  /** The row being decided (not counted). */
  readonly except: string;
  /** The block B the decision reads. */
  readonly block: bigint;
  readonly receiptBlock: ReceiptBlock;
  /** B's chain day. */
  readonly day: number;
  /** The chain day of a block. */
  readonly dayOfBlock: (blockNumber: bigint) => Promise<number>;
}

/**
 * At most one pacing slot per line per chain day, across the tick and API proposals (audit run-4): whether another
 * SPEND row on the line, signed or mined and not released, is still pending at B (it lands that day or later) or was
 * mined in a block of B's day. An unsigned row never counts: it may never be signed, and must not hold the day.
 */
export async function otherSlotOnDay(rows: readonly PaymentRow[], o: SlotDayCheck): Promise<boolean> {
  let latest: bigint | null = null;
  for (const row of rows) {
    if (row.id === o.except || row.kind !== 'SPEND' || row.lineKey !== o.lineKey || RELEASED_STATES.includes(row.state)) continue;
    if (!row.signed && !MINED_STATES.includes(row.state)) continue;
    const at = await minedAt(row, o.block, o.receiptBlock);
    if (at === null) return true;
    if (latest === null || at > latest) latest = at;
  }
  return latest !== null && (await o.dayOfBlock(latest)) === o.day;
}

export async function inFlightAt(
  payments: readonly PaymentRow[],
  block: bigint,
  receiptBlock: ReceiptBlock,
  pacingLines: ReadonlySet<LineKey>,
): Promise<InFlightView> {
  const perLine = new Map<LineKey, LineInFlight>();
  const usedIntents = new Set<string>();
  const paidInvoices = new Set<string>();
  let totalMinor = 0n;
  for (const row of payments) {
    const open = OPEN_SIGNED_STATES.includes(row.state);
    if (!open && !MINED_STATES.includes(row.state)) continue; // unsigned or released: no chain effect
    if (await minedBy(row, block, receiptBlock)) {
      usedIntents.add(row.intentId.toLowerCase());
      if (row.kind === 'SPEND' && row.lineKey !== null && !pacingLines.has(row.lineKey)) paidInvoices.add(row.invoiceHash.toLowerCase());
      continue;
    }
    if (!OUTFLOW_KINDS.has(row.kind)) continue;
    const amount = BigInt(row.amountMinor);
    totalMinor += amount;
    if ((row.kind !== 'SPEND' && row.kind !== 'OWNER_SPEND') || row.lineKey === null) continue;
    const prev = perLine.get(row.lineKey) ?? NO_LINE_IN_FLIGHT;
    const owner = row.kind === 'OWNER_SPEND';
    perLine.set(row.lineKey, {
      slots: prev.slots + (owner ? 0 : 1),
      lineMinor: prev.lineMinor + (owner ? 0n : amount),
      dropped: prev.dropped + (row.state === 'DROPPED' ? 1 : 0),
      owner: owner ? { slots: prev.owner.slots + 1, lineMinor: prev.owner.lineMinor + amount } : prev.owner,
    });
  }
  return { perLine, totalMinor, usedIntents, paidInvoices };
}
