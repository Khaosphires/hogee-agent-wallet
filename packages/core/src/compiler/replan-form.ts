/**
 * The tighten-only form of a replan (G0-AUDIT v-1 code 14; red-team 1.15 finding T20).
 *
 * A fresh compile runs at the current chain time with today's registry: it re-dates every expiry and the stage gate,
 * resets caps the agent or owner tightened since, undoes executed MOVE_POCKETS and lists every eligible payee. The
 * founder asked for none of that, and commitPlan refuses all of it (REPLAN_LOOSENS). So a replan compiles the new
 * intent AND the intent the committed plan was compiled from (the prior) with the same clock, facility and registry;
 * their difference is exactly what the new intent changes, and that difference is applied to the on-chain state:
 *
 *   value = current + (fresh − prior), clamped to what codes 1-13 allow
 *
 * for every pocket amount, cap, pacing, validUntil, the agent expiry and the reserve. The same intent gives the
 * current state exactly, which the founder signs alone. A change the intent asks for (more budget on a line, a
 * longer horizon, a new channel's payee) is kept: if it loosens, the draft fails only REPLAN_LOOSENS and
 * routeReplan turns it into lender-co-signed LOOSEN_* requests. With no prior, the new intent counts as unchanged.
 * Fixed by the first commit, with no LOOSEN_* kind to change them: the stages (gate included; a new budget compiles
 * fresh ones and is unsupported anyway). Payees: a payee is listed only if it is one of the line's current payees
 * as the chain sees them (listed, or bound to the line by a signed approval since), unless the new intent is what
 * adds it.
 */
import type { LineKey } from "../schemas/enums";
import type { PlanLine, PlanManifest, PlanStage } from "../schemas/plan";
import type { PayeeId } from "../schemas/primitives";
import { bpsFloor, minBig, toMinor, tryParseMinor } from "../money/index";
import { MAX_HORIZON_SECONDS } from "../constitution/check";
import type { CommittedLine, CommittedPlan } from "../constitution/types";
import { AGENT_EXPIRY_MARGIN_SECONDS, PER_TX_CAP_BPS, WINDOW_CAP_BPS } from "./constants";
import { CompileError } from "./errors";

export type ManifestBase = Omit<PlanManifest, "rules">;

export interface ReplanBounds {
  readonly now: bigint;
  readonly judgingWindowEnd: bigint;
}

interface Money {
  readonly amount: bigint;
  readonly perTx: bigint;
  readonly window: bigint;
  /** 0 = an invoice line. */
  readonly pacing: bigint;
}

/** A committed value; unreadable fails closed (the draft would be checked against garbage). */
function num(v: unknown, field: string): bigint {
  const n = tryParseMinor(v);
  if (n === null) throw new CompileError("INVALID_INPUT", `current plan: ${field} is unreadable`);
  return n;
}

/** current + (fresh − prior), never below 0: the intent's change applied to the on-chain value. */
function shift(current: bigint, fresh: bigint, prior: bigint): bigint {
  const v = current + fresh - prior;
  return v < 0n ? 0n : v;
}

const lineMoney = (l: PlanLine): Money => ({
  amount: num(l.amountMinor, "amountMinor"),
  perTx: num(l.perTxCapMinor, "perTxCapMinor"),
  window: num(l.windowCapMinor, "windowCapMinor"),
  pacing: l.pacing ? num(l.pacing.amountMinor, "pacing") : 0n,
});

const committedMoney = (c: CommittedLine): Money => ({
  amount: num(c.amountMinor, `${c.lineKey} amountMinor`),
  perTx: num(c.perTxCapMinor, `${c.lineKey} perTxCapMinor`),
  window: num(c.windowCapMinor, `${c.lineKey} windowCapMinor`),
  pacing: num(c.pacingMinor, `${c.lineKey} pacingMinor`),
});

/** A pacing that never turns into an invoice line (0) and, when the shift would, stays at most the current one. */
function shiftedPacing(c: bigint, f: bigint, p: bigint): bigint {
  const v = c + f - p;
  if (v > 0n) return v;
  return c > 0n ? minBig(c, f) : f;
}

/**
 * Per-line money shifted by the intent's change, or null when that cannot keep the plan's totals (a new budget, a
 * different line set, a pocket the change would overdraw): then every line takes the fresh money.
 */
function shiftedMoney(fresh: ManifestBase, prior: Map<LineKey, PlanLine>, current: Map<LineKey, CommittedLine>, total: bigint): Map<LineKey, Money> | null {
  if (fresh.lines.length !== current.size || fresh.lines.length !== prior.size) return null;
  const out = new Map<LineKey, Money>();
  let sum = 0n;
  for (const l of fresh.lines) {
    const pl = prior.get(l.lineKey);
    const cl = current.get(l.lineKey);
    if (!pl || !cl) return null;
    const [f, p, c] = [lineMoney(l), lineMoney(pl), committedMoney(cl)];
    const amount = c.amount + f.amount - p.amount;
    if (amount < 0n) return null;
    out.set(l.lineKey, {
      amount,
      perTx: minBig(shift(c.perTx, f.perTx, p.perTx), bpsFloor(amount, PER_TX_CAP_BPS)),
      window: minBig(shift(c.window, f.window, p.window), bpsFloor(amount, WINDOW_CAP_BPS)),
      pacing: l.pacing ? shiftedPacing(c.pacing, f.pacing, p.pacing) : 0n,
    });
    sum += amount;
  }
  return sum === total ? out : null;
}

/** Listed iff a current payee of the line (listed or signed-bound on-chain), or one the new intent adds. */
function replanPayees(f: PlanLine, p: PlanLine | undefined, c: CommittedLine): PayeeId[] {
  const now = new Set<string>(c.payeeIds);
  const before = new Set<string>(p?.payeeIds ?? f.payeeIds);
  return f.payeeIds.filter((id) => now.has(id) || !before.has(id));
}

function replanLine(f: PlanLine, p: PlanLine | undefined, c: CommittedLine | undefined, money: Money | undefined, latest: bigint): PlanLine {
  if (!c) return f; // not a line of the current plan: LINE_SET_CHANGED, nothing to keep
  const prior = p ?? f;
  const m = money ?? lineMoney(f);
  const windowSeconds = shift(num(c.windowSeconds, `${c.lineKey} windowSeconds`), num(f.windowSeconds, "windowSeconds"), num(prior.windowSeconds, "windowSeconds"));
  const validUntil = minBig(shift(num(c.validUntil, `${c.lineKey} validUntil`), num(f.validUntil, "validUntil"), num(prior.validUntil, "validUntil")), latest);
  const line: PlanLine = {
    ...f,
    amountMinor: toMinor(m.amount),
    perTxCapMinor: toMinor(m.perTx),
    windowCapMinor: toMinor(m.window),
    windowSeconds: (windowSeconds > 0n ? windowSeconds : num(f.windowSeconds, "windowSeconds")).toString(),
    validUntil: validUntil.toString(),
    payeeIds: replanPayees(f, p, c),
    escrowOnly: f.escrowOnly || c.escrowOnly,
  };
  return f.pacing ? { ...line, pacing: { period: f.pacing.period, amountMinor: toMinor(m.pacing) } } : line;
}

/** The agent expiry shifted like a line's, kept past the judging window (code 3) and within now + 90 days (code 2). */
function replanAgentExpiry(c: bigint, f: bigint, p: bigint, b: ReplanBounds): bigint {
  const v = minBig(shift(c, f, p), b.now + MAX_HORIZON_SECONDS);
  return v > b.judgingWindowEnd ? v : minBig(c, b.judgingWindowEnd + AGENT_EXPIRY_MARGIN_SECONDS);
}

const copyStages = (stages: readonly PlanStage[]): PlanStage[] => stages.map((s) => ({ stageId: s.stageId, releaseMinor: s.releaseMinor, gate: s.gate ? { ...s.gate } : null }));

/** The replan of `fresh` (the new intent compiled now) against `current`, given `prior` (see module doc). */
export function replanForm(fresh: ManifestBase, prior: ManifestBase, current: CommittedPlan, b: ReplanBounds): ManifestBase {
  const latest = b.now + MAX_HORIZON_SECONDS;
  if (!Number.isInteger(current.reserveBps)) throw new CompileError("INVALID_INPUT", "current plan: reserveBps is unreadable");
  const currentTotal = num(current.totalMinor, "totalMinor");
  const priorLines = new Map(prior.lines.map((l) => [l.lineKey, l]));
  const currentLines = new Map(current.lines.map((l) => [l.lineKey, l]));
  // A new budget is unsupported anyway (TOTAL_CHANGED): every line then takes the fresh money, and fresh stages.
  const money = fresh.totalMinor === prior.totalMinor ? shiftedMoney(fresh, priorLines, currentLines, currentTotal) : null;
  const total = money ? currentTotal : num(fresh.totalMinor, "totalMinor");
  const reserve = Math.min(10_000, Math.max(fresh.reserveBps, current.reserveBps + fresh.reserveBps - prior.reserveBps));
  const expiresAt = replanAgentExpiry(num(current.agent.expiresAt, "agent expiresAt"), num(fresh.agent.expiresAt, "agent expiresAt"), num(prior.agent.expiresAt, "agent expiresAt"), b);
  return {
    ...fresh,
    totalMinor: toMinor(total),
    reserveBps: reserve,
    agent: { address: fresh.agent.address, expiresAt: expiresAt.toString() },
    stages: total === currentTotal ? copyStages(current.stages) : fresh.stages,
    lines: fresh.lines.map((l) => replanLine(l, priorLines.get(l.lineKey), currentLines.get(l.lineKey), money?.get(l.lineKey), latest)),
  };
}
