/**
 * CFO insights (VISION §8): at most 8, warnings first, then CFO_INSIGHT_KINDS order, then line order. Ids are
 * deterministic per kind, line and UTC day. Thresholds:
 * Wording (ux-money, UX-PLAN A11.29–A11.35): plain words, days as "25 Oct", paces and averages in whole BU (wholeBu),
 * recorded amounts exact (bu).
 *   - BURN_ALERT: the agent's spend on a line > 1.5 × its pace over the last 7 days (./burn.ts); once the agent lowered
 *     that line within its window, it links the prefilled request to raise the cap back (./cooldown.ts);
 *   - RUNWAY_SHORT: runwayDays < 21;
 *   - STAGE2_ON_TRACK / STAGE2_AT_RISK: the gated stage's target met, or its MA7 date by the deadline / not;
 *     nothing on fewer than 3 days of data unless the target is already met;
 *   - RESERVE_STATUS: once anything is set aside; warn when tax payments used more than half of it;
 *   - MOVE_BUDGET: a line (not contingency) has ≤ 10 % of its allocation left while contingency has ≥ 1 BU.
 */
import { LINE_KEYS, type LineKey } from "../schemas/enums";
import { MIN_SAMPLE_DAYS, isoDay, type Ledger } from "./ledger";
import type { LineBurn } from "./burn";
import { raiseBackHref } from "./cooldown";
import { CHANGE_REQUESTS_HREF, bu, dayMonthOf, dayWord, fitText, insightIdOf, lineLabel, percentOfBps, timesWordOfTenths, wholeBu } from "./text";
import { CFO_INSIGHT_KINDS, type CfoInputs, type CfoInsight, type CfoInsightKind, type CfoReport } from "./types";

export const MAX_INSIGHTS = 8;
const RUNWAY_SHORT_DAYS = 21;
const ONE_BU = 100n;

export interface InsightFacts {
  readonly inputs: CfoInputs;
  readonly ledger: Ledger;
  readonly burns: readonly LineBurn[];
  readonly cashAvailable: bigint;
  readonly forecast: CfoReport["forecast"];
  readonly stageGate: CfoReport["sales"]["stageGate"];
  readonly reserve: CfoReport["reserve"];
}

type Draft = Omit<CfoInsight, "insightId">;

const TITLE_MAX = 80;
const DETAIL_MAX = 280;

const make = (f: InsightFacts, d: Draft): CfoInsight => ({
  insightId: insightIdOf(d.kind, d.lineKey, isoDay(f.ledger.today)),
  ...d,
  title: fitText(d.title, TITLE_MAX),
  detail: fitText(d.detail, DETAIL_MAX),
});

function burnAlerts(f: InsightFacts): Draft[] {
  return f.burns.map((b) => {
    const line = f.inputs.lines.find((l) => l.lineKey === b.lineKey);
    const raise = line ? raiseBackHref(f.inputs, line, f.ledger.nowMs) : null;
    const next = raise ? "Hogee's AI lowered its limit by itself. If you meant to spend this, ask for a higher limit." : "Hogee's AI may make its limits stricter by itself.";
    return {
      kind: "BURN_ALERT",
      severity: "warn",
      title: `${lineLabel(b.lineKey)} spending is faster than planned`,
      detail:
        `${lineLabel(b.lineKey)} spent ${bu(b.spentMinor)} in the last ${dayWord(b.days)}, about ${timesWordOfTenths(b.ratioTenths)} faster than ` +
        `planned (${wholeBu(b.paceMinor)}). ${next} This is an estimate from your records.`,
      lineKey: b.lineKey,
      suggestion: { kind: "TIGHTEN", href: raise },
    };
  });
}

function runwayShort(f: InsightFacts): Draft[] {
  const days = f.forecast.runwayDays;
  if (days === null || days >= RUNWAY_SHORT_DAYS) return [];
  return [
    {
      kind: "RUNWAY_SHORT",
      severity: "warn",
      title: `Your spending money lasts about ${dayWord(days)}`,
      detail: `You spend about ${wholeBu(f.forecast.dailyBurnMinor)} a day (last 7 days). At that pace, the ${bu(f.cashAvailable)} you can spend now lasts about ${dayWord(days)}. This is an estimate.`,
      lineKey: null,
      suggestion: null,
    },
  ];
}

function stageInsight(f: InsightFacts): Draft[] {
  const g = f.stageGate;
  if (!g) return [];
  const status = `Sales so far: ${bu(g.soFarMinor)} of ${bu(g.targetMinor)}.`;
  if (g.soFarMinor >= g.targetMinor) {
    return [
      {
        kind: "STAGE2_ON_TRACK",
        severity: "info",
        title: "You reached the sales goal for your next budget release",
        detail: `${status} Your loan officer can now release the next part of your budget.`,
        lineKey: null,
        suggestion: { kind: "REQUEST_STAGE_RELEASE", href: CHANGE_REQUESTS_HREF },
      },
    ];
  }
  const stage = f.inputs.stage;
  if (stage && f.ledger.nowMs > stage.deadline.getTime()) {
    return [atRisk(`${status} The ${dayMonthOf(g.deadline)} deadline has passed, so the next budget release stays locked.`)];
  }
  if (f.ledger.sampleDays < MIN_SAMPLE_DAYS) return [];
  const pace = `At about ${wholeBu(f.forecast.dailyRevenueMinor)} a day`;
  const deadline = dayMonthOf(g.deadline);
  if (g.projectedDate === null) return [atRisk(`${status} ${pace}, this estimate doesn't reach the goal within 30 days of the ${deadline} deadline.`)];
  if (g.projectedDate > g.deadline) return [atRisk(`${status} ${pace}, you would reach it on ${dayMonthOf(g.projectedDate)}, after the ${deadline} deadline.`)];
  return [
    {
      kind: "STAGE2_ON_TRACK",
      severity: "info",
      title: "On track for your sales goal",
      detail: `${status} ${pace}, you should reach it on ${dayMonthOf(g.projectedDate)}, before the ${deadline} deadline.`,
      lineKey: null,
      suggestion: null,
    },
  ];
}

const atRisk = (detail: string): Draft => ({ kind: "STAGE2_AT_RISK", severity: "warn", title: "You may miss your sales goal", detail, lineKey: null, suggestion: null });

function reserveStatus(f: InsightFacts): Draft[] {
  const r = f.reserve;
  if (r.skimmedMinor === 0n) return [];
  const heavy = r.withdrawnMinor * 2n > r.skimmedMinor;
  const base = `${percentOfBps(r.rateBps)} of each sale is kept for tax: ${bu(r.skimmedMinor)} from ${r.salesCount} sales, ${bu(r.withdrawnMinor)} paid as tax, ${bu(r.balanceMinor)} kept now.`;
  return [
    {
      kind: "RESERVE_STATUS",
      severity: heavy ? "warn" : "info",
      title: `${bu(r.balanceMinor)} is kept for tax`,
      detail: heavy ? `${base} Tax payments used more than half of it.` : base,
      lineKey: null,
      suggestion: null,
    },
  ];
}

function moveBudget(f: InsightFacts): Draft[] {
  const contingency = f.inputs.lines.find((l) => l.lineKey === "CONTINGENCY");
  if (!contingency || contingency.availableMinor < ONE_BU) return [];
  return f.inputs.lines
    .filter((l) => l.lineKey !== "CONTINGENCY" && l.allocatedMinor > 0n && l.availableMinor * 10n <= l.allocatedMinor)
    .map((l) => ({
      kind: "MOVE_BUDGET",
      severity: "warn",
      title: `${lineLabel(l.lineKey)} pocket is nearly empty`,
      detail: `${lineLabel(l.lineKey)} has ${bu(l.availableMinor)} left out of ${bu(l.allocatedMinor)}. Your safety buffer has ${bu(contingency.availableMinor)}. You can ask to move some over.`,
      lineKey: l.lineKey,
      suggestion: { kind: "REQUEST_MOVE", href: CHANGE_REQUESTS_HREF },
    }));
}

const kindRank = (k: CfoInsightKind): number => CFO_INSIGHT_KINDS.indexOf(k);
const lineRank = (k: LineKey | null): number => (k === null ? -1 : LINE_KEYS.indexOf(k));

export function buildInsights(f: InsightFacts): CfoInsight[] {
  const drafts = [...burnAlerts(f), ...runwayShort(f), ...stageInsight(f), ...reserveStatus(f), ...moveBudget(f)];
  return drafts
    .sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1) || kindRank(a.kind) - kindRank(b.kind) || lineRank(a.lineKey) - lineRank(b.lineKey),
    )
    .slice(0, MAX_INSIGHTS)
    .map((d) => make(f, d));
}
