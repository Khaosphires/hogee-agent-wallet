/**
 * autonomous-tick on a pacing line (project.md §12.4; G0 decision §1 #1): propose the line's next slot, or skip it.
 *
 * One evaluator, not two: planPacingSlot builds the exact pacing spend (amount = the line's pacing, invoiceHash =
 * bytes32(slot), the real intentId) and runs evaluateSpend on the context PROJECTED past the in-flight spends
 * (projectInFlight: signed but not mined yet, so Treasury's window, balance, payee and sequence counters have not
 * moved). The slot is lineSequence + in-flight slots. Any verdict other than AUTO is a SKIP that carries the decision
 * (a paused treasury or line, an open circuit, a revoked or expired agent, an expired line, an unbound or cooling
 * payee, any cap). A skip consumes nothing: Treasury.lineSequence does not advance, so a later tick proposes the same
 * slot once the state allows it. The caller decides that a slot is due (at most one per line per day).
 *
 * WORKER RULE (G0 decision §1 #1, skills re-check): send only a PROPOSE, exactly as returned, and evaluate it on the
 * same projection. A SKIP is never sent and never recordDenied. Never recordDenied a pacing proposal at all, even one
 * the state refused after this check, and never recordDenied any proposal denied Paused, CircuitOpen, LineExpired or
 * PACING_SLOT_AHEAD: those describe the treasury's state, not the agent, and recordDenied counts them anyway (3 per
 * window trip the line's circuit, permanently on loop-1, which cannot unpause).
 */
import { effectiveLifetimeCap } from "../constitution/check";
import { spendIntentId } from "../hash/index";
import { parseMinor } from "../money/index";
import type { LineKey } from "../schemas/enums";
import { stringToBytes32, type Minor, type PayeeId } from "../schemas/primitives";
import { TRUSTED_PUBLIC, trusted } from "../taint/labels";
import { sequenceInvoiceHash } from "./sequence";
import { MAX_LIVE_SPENDS_PER_WINDOW, evaluateSpend } from "./spend";
import { lineState, listedPayeeIds, nowOf, payeeState, planLine, spendablePayeeState } from "./state";
import type { PolicyContext, PolicyDecision, PolicyLineState, SpendProposalIn } from "./types";

/** Spends signed but not mined yet. Treasury's counters (rollingSpent, spent, lineSequence) only move when mined. */
export interface PacingInFlight {
  /** This line's agent pacing slots in flight (Treasury.spend): the next free slot is lineSequence + slots (+ owner.slots). */
  readonly slots: number;
  /** Their total: counts against the window, the line balance and the payee's lifetime cap. */
  readonly lineMinor: Minor;
  /**
   * The founder's ownerSpends in flight on this line (OWNER_SPEND rows). On a pacing line each pays the next slot, and
   * they count against the line balance and (like lineMinor) the payee's lifetime cap, but they add NO window entry
   * (TreasuryGovernance.ownerSpend: not agent outflow), so they never count toward the window or its live-spend bound.
   * Absent = none.
   */
  readonly owner?: { readonly slots: number; readonly lineMinor: Minor };
  /** Every spend, ownerSpend and milestone funding in flight, on any line, this line's included: counts against releasedMinor. */
  readonly totalMinor: Minor;
}

/** Which cap a CapExceeded skip ran into, in Treasury._requireCaps order. */
export type PacingCapSkip =
  | "PER_TX_CAP_BELOW_PACING"
  | "NO_LIVE_SPEND_ROOM"
  | "NO_WINDOW_HEADROOM"
  | "NO_LINE_BALANCE"
  | "PAYEE_CAP_REACHED"
  | "NO_RELEASED_HEADROOM"
  | "NO_FUNDED_HEADROOM";

/** Skips decided before evaluation: not a pacing line, or no single payable payee to pay. */
export type PacingPreSkip = "NOT_PACING_LINE" | "NO_PAYABLE_PAYEE" | "PACING_PAYEE_AMBIGUOUS";

export type PacingSlotPlan =
  | {
      readonly action: "PROPOSE";
      readonly pacingSlot: number;
      readonly amountMinor: Minor;
      readonly payeeId: PayeeId;
      /** The exact spend that was evaluated AUTO on the projected context: send this one. */
      readonly proposal: SpendProposalIn;
    }
  | { readonly action: "SKIP"; readonly reason: PacingPreSkip }
  | {
      readonly action: "SKIP";
      /** A PacingCapSkip for CapExceeded, else the decision's reasonCode (Paused, CircuitOpen, PayeeCooling, ...). */
      readonly reason: string;
      /** Room left under the cap that refused the slot (cap skips with a money limit only). */
      readonly headroomMinor?: Minor;
      readonly decision: PolicyDecision;
    };

const headroom = (limit: bigint, used: bigint): bigint => (limit > used ? limit - used : 0n);

function slotCount(n: number, label: string): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${label} must be a non-negative integer, got ${String(n)}`);
  return n;
}

function parseInFlight(f: PacingInFlight): { slots: number; line: bigint; ownerSlots: number; ownerLine: bigint; total: bigint } {
  const slots = slotCount(f.slots, "inFlight.slots");
  const line = parseMinor(f.lineMinor, "inFlight.lineMinor");
  const ownerSlots = slotCount(f.owner?.slots ?? 0, "inFlight.owner.slots");
  const ownerLine = parseMinor(f.owner?.lineMinor ?? "0", "inFlight.owner.lineMinor");
  const total = parseMinor(f.totalMinor, "inFlight.totalMinor");
  if (total < line + ownerLine) throw new RangeError("inFlight.totalMinor must include this line's in-flight spends and ownerSpends");
  return { slots, line, ownerSlots, ownerLine, total };
}

/**
 * The context once the in-flight spends are mined: this line's window, spent, live-spend count and sequence, the
 * paying payee's paidMinor, and the treasury's total outflow. In-flight ownerSpends move spent, the sequence, the payee
 * and the total, never the window or the live-spend count. The worker evaluates a pacing proposal on this, never on
 * the raw mirror (where a slot after in-flight ones is PACING_SLOT_AHEAD). Pure; throws on malformed input.
 */
export function projectInFlight(ctx: PolicyContext, lineKey: LineKey, inFlight: PacingInFlight, payeeId?: string): PolicyContext {
  const f = parseInFlight(inFlight);
  const add = (v: Minor, d: bigint, label: string): Minor => (parseMinor(v, label) + d).toString();
  const totals = { totalSpentMinor: add(ctx.totalSpentMinor, f.total, "totalSpentMinor") };
  const state = lineState(ctx, lineKey);
  if (!state) return { ...ctx, ...totals };
  const paid = f.line + f.ownerLine;
  const line: PolicyLineState = {
    ...state,
    windowSpentMinor: add(state.windowSpentMinor, f.line, "windowSpentMinor"),
    spentMinor: add(state.spentMinor, paid, "spentMinor"),
    nextSequence: state.nextSequence + f.slots + f.ownerSlots,
    ...(state.windowLiveSpends === undefined ? {} : { windowLiveSpends: state.windowLiveSpends + f.slots }),
  };
  const entry = payeeId === undefined ? undefined : payeeState(ctx, payeeId, lineKey);
  const payees = entry ? ctx.payees.map((p) => (p === entry ? { ...p, paidMinor: add(p.paidMinor, paid, "paidMinor") } : p)) : ctx.payees;
  return { ...ctx, ...totals, lines: { ...ctx.lines, [lineKey]: line }, payees };
}

/** The line's single payable payee (listed, bound, not cooling); several → ambiguous; none → nothing to pay. */
function pickPayee(ctx: PolicyContext, lineKey: LineKey): string | "NONE" | "AMBIGUOUS" {
  const payable = listedPayeeIds(ctx, lineKey).filter((id) => {
    const p = spendablePayeeState(ctx, id, lineKey);
    return p !== undefined && (p.coolingUntil === undefined || nowOf(ctx) >= parseMinor(p.coolingUntil, "coolingUntil"));
  });
  if (payable.length > 1) return "AMBIGUOUS";
  return payable[0] ?? "NONE";
}

/** The pacing spend for `slot`: a trusted plan tick, amount = pacing, invoiceHash = bytes32(slot), the chain's intentId. */
function pacingProposal(ctx: PolicyContext, lineKey: LineKey, payeeId: string, slot: number, amountMinor: Minor): SpendProposalIn {
  const invoiceHash = sequenceInvoiceHash(slot);
  const intentId = spendIntentId({ planId: ctx.plan.planId, lineId: stringToBytes32(lineKey), payeeId: stringToBytes32(payeeId), invoiceHash, amountMinor: parseMinor(amountMinor) });
  return {
    kind: "SPEND",
    origin: TRUSTED_PUBLIC,
    lineKey: trusted(lineKey, "plan:pacing"),
    payeeId: trusted(payeeId, "plan:payees"),
    amountMinor: trusted(amountMinor, "plan:pacing"),
    invoiceHash,
    intentId,
    planVersion: ctx.planVersion,
    basis: { pacingSlot: slot },
  };
}

/** For a CapExceeded on the projected context: the first cap (Treasury._requireCaps order) that is short. */
function capSkip(ctx: PolicyContext, state: PolicyLineState, payeeId: string, lineKey: LineKey, amount: bigint): { reason: PacingCapSkip; headroomMinor?: Minor } | null {
  const big = (v: string, label: string) => parseMinor(v, label);
  if (amount > big(state.perTxCapMinor, "perTxCapMinor")) return { reason: "PER_TX_CAP_BELOW_PACING", headroomMinor: state.perTxCapMinor };
  if (state.windowLiveSpends !== undefined && state.windowLiveSpends >= MAX_LIVE_SPENDS_PER_WINDOW) return { reason: "NO_LIVE_SPEND_ROOM" };
  const payee = spendablePayeeState(ctx, payeeId, lineKey);
  const lifetime = payee ? effectiveLifetimeCap(payee) : null;
  const outflow = big(ctx.totalSpentMinor, "totalSpentMinor") + big(ctx.totalEscrowedMinor, "totalEscrowedMinor");
  const rooms: [PacingCapSkip, bigint | null][] = [
    ["NO_WINDOW_HEADROOM", headroom(big(state.windowCapMinor, "windowCapMinor"), big(state.windowSpentMinor, "windowSpentMinor"))],
    ["NO_LINE_BALANCE", headroom(big(state.allocatedMinor, "allocatedMinor"), big(state.spentMinor, "spentMinor") + big(state.escrowedMinor, "escrowedMinor"))],
    ["PAYEE_CAP_REACHED", payee && lifetime !== null ? headroom(lifetime, big(payee.paidMinor, "paidMinor")) : null],
    ["NO_RELEASED_HEADROOM", headroom(big(ctx.releasedMinor, "releasedMinor"), outflow)],
    ["NO_FUNDED_HEADROOM", ctx.fundedMinor === undefined ? null : headroom(big(ctx.fundedMinor, "fundedMinor"), outflow)],
  ];
  const short = rooms.find(([, room]) => room !== null && amount > room);
  return short ? { reason: short[0], headroomMinor: (short[1] ?? 0n).toString() } : null;
}

/**
 * Propose the line's next free slot, or skip it (see the module doc and its WORKER RULE). `payeeId` = the payee to
 * pay; absent = the line's single payable payee. Throws on malformed input.
 */
export function planPacingSlot(ctx: PolicyContext, lineKey: LineKey, inFlight: PacingInFlight, payeeId?: PayeeId): PacingSlotPlan {
  const line = planLine(ctx, lineKey);
  if (!line?.pacing || !lineState(ctx, lineKey)) return { action: "SKIP", reason: "NOT_PACING_LINE" };
  parseInFlight(inFlight);
  const payee = payeeId ?? pickPayee(ctx, lineKey);
  if (payee === "NONE") return { action: "SKIP", reason: "NO_PAYABLE_PAYEE" };
  if (payee === "AMBIGUOUS") return { action: "SKIP", reason: "PACING_PAYEE_AMBIGUOUS" };
  const projected = projectInFlight(ctx, lineKey, inFlight, payee);
  const state = lineState(projected, lineKey)!;
  const amountMinor = line.pacing.amountMinor;
  const proposal = pacingProposal(projected, lineKey, payee, state.nextSequence, amountMinor);
  const decision = evaluateSpend(proposal, projected);
  if (decision.verdict === "AUTO") return { action: "PROPOSE", pacingSlot: state.nextSequence, amountMinor, payeeId: payee, proposal };
  const cap = decision.reasonCode === "CapExceeded" ? capSkip(projected, state, payee, lineKey, parseMinor(amountMinor)) : null;
  return cap ? { action: "SKIP", ...cap, decision } : { action: "SKIP", reason: decision.reasonCode, decision };
}
