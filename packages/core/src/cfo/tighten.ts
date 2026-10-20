/**
 * proposeTightenings (VISION §8 core-cfo, §9 "CFO actions"): tighten-only changes the agent may make alone. Nothing
 * here signs or sends; the cfo-guard job re-runs evaluateTighten on its mirrored PolicyContext (real agent and pause
 * state) and sends each proposal with a trace and a tx.
 *
 *   - LOWER_WINDOW_CAP / LOWER_PER_TX_CAP on a line whose AGENT spend burns > 1.5 × pace (./burn.ts). Window first (it
 *     bounds the rate): the pace over the line's window; else per payment: one pacing slot, or 7 days of pace. Rounded
 *     down to whole BU and floored (fixr-cfo, re-check LOW 3) at the highest of: 1 BU, the pacing slot, the line's
 *     largest agent payment of the last 30 days, and half the committed cap (both rounded up to whole BU), so the
 *     guard can never take a line below half of what the founder and the officer committed to. Only when strictly
 *     below the current cap, and only on a line whose committed caps are given. Each carries a prefilled RAISE_CAP
 *     change-request link back to the committed cap.
 *   - RAISE_RESERVE_BPS by 1 point (never above 1000 bps), only with recorded revenue and when tax payments have used
 *     more than half of what was set aside. Raised from the higher of the live and the committed rate.
 *   - At most one proposal per line per rolling max(windowSeconds, 1 day) (./cooldown.ts), and one reserve raise per
 *     UTC day, skipping what the agent already did (agentActions), so the same inputs always give the same proposals.
 *   - Every proposal passes core policy evaluateTighten on tightenContextOf(inputs); one the policy refuses is never
 *     returned (no action is the safe outcome).
 */
import { evaluateTighten } from "../policy/governance";
import type { PolicyContext, PolicyLineState, TightenProposalIn } from "../policy/types";
import type { LineKey } from "../schemas/enums";
import { maxBig, toMinor } from "../money/index";
import { TRUSTED_PUBLIC, trusted } from "../taint/labels";
import { burnsOf, type LineBurn } from "./burn";
import { recentTightening } from "./cooldown";
import { MA_DAYS, SECONDS_PER_DAY, SERIES_DAYS, epochDay, readLedger, unixSeconds, type Ledger } from "./ledger";
import { bu, dayWord, fitText, lineLabel, percentOfBps, raiseCapHref, timesOfTenths } from "./text";
import { CfoInputError, type CfoAgentAction, type CfoInputs, type CfoLineIn, type CfoTightening } from "./types";

const ONE_BU = 100n;
const RESERVE_STEP_BPS = 100;
const RESERVE_MAX_BPS = 1_000;
const REASON_MAX = 200;
const SOURCE = "cfo:records";

/** The policy proposal for a CFO tightening: trusted (built from our own records), never from model text. */
export function toTightenProposal(t: CfoTightening): TightenProposalIn {
  return {
    kind: "TIGHTEN",
    origin: TRUSTED_PUBLIC,
    action: t.action,
    ...(t.lineKey === null ? {} : { lineKey: trusted(t.lineKey, SOURCE) }),
    newValue: trusted(t.newValue.toString(), SOURCE),
  };
}

const unmirrored = (field: string): never => {
  throw new CfoInputError(`the CFO tighten context does not mirror ${field}`);
};

/**
 * The PolicyContext evaluateTighten reads, built from the CFO inputs: the lines' current caps, the higher of the live
 * and committed reserve rate, and a live agent (the inputs carry no agent state; cfo-guard re-checks on the real
 * context). Fields the inputs do not mirror throw when read, so a policy change that starts reading them fails closed.
 */
export function tightenContextOf(i: CfoInputs): PolicyContext {
  if (!(i.now instanceof Date) || Number.isNaN(i.now.getTime())) throw new CfoInputError("now is not a valid date");
  const now = BigInt(Math.floor(i.now.getTime() / 1000));
  const lines: Partial<Record<LineKey, PolicyLineState>> = {};
  for (const l of i.lines) {
    lines[l.lineKey] = {
      allocatedMinor: toMinor(l.allocatedMinor),
      spentMinor: toMinor(l.spentMinor),
      escrowedMinor: toMinor(l.escrowedMinor),
      perTxCapMinor: toMinor(l.perTxCapMinor),
      windowCapMinor: toMinor(l.windowCapMinor),
      windowSpentMinor: toMinor(l.windowSpentMinor),
      validUntil: unixSeconds(l.validUntil, `${l.lineKey}.validUntil`).toString(),
      paused: false,
      circuitOpen: false,
      nextSequence: 0,
    };
  }
  return {
    now,
    paused: false,
    agent: { revoked: false, expiresAt: now.toString() },
    reserveBps: Math.max(i.reserve.rateBps, i.reserveBps),
    lines,
    get plan() { return unmirrored("plan"); },
    get planHash() { return unmirrored("planHash"); },
    get planVersion() { return unmirrored("planVersion"); },
    get releasedMinor() { return unmirrored("releasedMinor"); },
    get totalSpentMinor() { return unmirrored("totalSpentMinor"); },
    get totalEscrowedMinor() { return unmirrored("totalEscrowedMinor"); },
    get reserveMinor() { return unmirrored("reserveMinor"); },
    get payees() { return unmirrored("payees"); },
    get usedIntents() { return unmirrored("usedIntents"); },
    get paidInvoices() { return unmirrored("paidInvoices"); },
    get escrowOrders() { return unmirrored("escrowOrders"); },
    get stages() { return unmirrored("stages"); },
    get facility() { return unmirrored("facility"); },
  };
}

/** The "line" an action uses up: the reserve, a line, or the agent as a whole. */
const slotOf = (action: CfoAgentAction["action"], lineKey: LineKey | null): string =>
  action === "RAISE_RESERVE_BPS" ? "RESERVE" : (lineKey ?? "AGENT");

/** The reserve was raised today (one reserve raise per UTC day). */
const reserveRaisedToday = (i: CfoInputs, l: Ledger): boolean =>
  i.agentActions.some((a) => slotOf(a.action, a.lineKey) === "RESERVE" && epochDay(Date.parse(a.at)) === l.today);

const floorBu = (v: bigint): bigint => (v / ONE_BU) * ONE_BU;
const ceilBu = (v: bigint): bigint => ((v + ONE_BU - 1n) / ONE_BU) * ONE_BU;

/** The line's largest agent payment (SPEND) of the last 30 days: its regular bill, which a lowered cap must still fit. */
function largestBill(l: Ledger, lineKey: LineKey): bigint {
  const from = l.today - SERIES_DAYS + 1;
  return l.agentSpend.reduce((m, r) => (r.lineKey === lineKey && r.day >= from && r.amount > m ? r.amount : m), 0n);
}

function lineProposal(b: LineBurn, line: CfoLineIn, largest: bigint): CfoTightening | null {
  /** Whole BU, never below the floors (module doc). */
  const sized = (raw: bigint, committed: bigint): bigint => maxBig(floorBu(raw), ONE_BU, b.pacingMinor, ceilBu(largest), ceilBu((committed + 1n) / 2n));
  const why = `${lineLabel(b.lineKey)} spent ${bu(b.spentMinor)} in the last ${dayWord(b.days)}, about ${timesOfTenths(b.ratioTenths)} its planned pace.`;
  const make = (action: CfoTightening["action"], cap: "perTx" | "window", current: bigint, committed: bigint, newValue: bigint): CfoTightening => ({
    action,
    lineKey: b.lineKey,
    newValue,
    reason: fitText(`${why} Lowering its ${cap === "window" ? "rolling limit" : "per-payment limit"} from ${bu(current)} to ${bu(newValue)}. If this spending is planned, ask for a higher cap.`, REASON_MAX),
    raiseHref: raiseCapHref(b.lineKey, cap, committed),
  });
  const ws = line.windowSeconds;
  const committedWindow = line.committedWindowCapMinor;
  if (ws !== undefined && ws > 0n && committedWindow !== undefined) {
    const target = sized((b.paceNum * ws) / (b.paceDen * SECONDS_PER_DAY), committedWindow);
    if (target < line.windowCapMinor) return make("LOWER_WINDOW_CAP", "window", line.windowCapMinor, committedWindow, target);
  }
  const committedPerTx = line.committedPerTxCapMinor;
  if (committedPerTx === undefined) return null;
  const perTx = sized(b.pacingMinor > 0n ? b.pacingMinor : (b.paceNum * BigInt(MA_DAYS)) / b.paceDen, committedPerTx);
  return perTx < line.perTxCapMinor ? make("LOWER_PER_TX_CAP", "perTx", line.perTxCapMinor, committedPerTx, perTx) : null;
}

function reserveProposal(i: CfoInputs, l: Ledger): CfoTightening[] {
  const r = i.reserve;
  if (reserveRaisedToday(i, l)) return [];
  const revenue = l.sales.reduce((s, x) => s + x.amount, 0n);
  if (revenue === 0n || r.withdrawnMinor * 2n <= r.skimmedMinor) return [];
  const current = Math.max(r.rateBps, i.reserveBps);
  if (current >= RESERVE_MAX_BPS) return [];
  const next = Math.min(RESERVE_MAX_BPS, current + RESERVE_STEP_BPS);
  const reason =
    `Tax payments used ${bu(r.withdrawnMinor)} of the ${bu(r.skimmedMinor)} set aside, more than half. ` +
    `Raising the set-aside from ${percentOfBps(current)} to ${percentOfBps(next)} of each sale.`;
  return [{ action: "RAISE_RESERVE_BPS", lineKey: null, newValue: BigInt(next), reason: fitText(reason, REASON_MAX) }];
}

export function proposeTightenings(i: CfoInputs): CfoTightening[] {
  const l = readLedger(i);
  const ctx = tightenContextOf(i);
  const lineByKey = new Map(i.lines.map((x) => [x.lineKey, x]));
  const candidates = [
    ...burnsOf(i, l).flatMap((b) => {
      const line = lineByKey.get(b.lineKey);
      if (!line || recentTightening(i, line, l.nowMs) !== null) return [];
      return lineProposal(b, line, largestBill(l, b.lineKey)) ?? [];
    }),
    ...reserveProposal(i, l),
  ];
  return candidates.filter((t) => evaluateTighten(toTightenProposal(t), ctx).verdict === "AUTO");
}
