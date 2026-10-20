/**
 * CFO insights (VISION-DECISIONS §8 core-cfo): at most 8, deterministic ids, warn before info, every string passes the
 * wording lint's checkText and says "estimate", never "confidence".
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCfoReport } from "../src/cfo/report";
import { proposeTightenings } from "../src/cfo/tighten";
import type { CfoInputs, CfoInsight } from "../src/cfo/types";
import { adsSpike, at, fourteenDays, fresh, patchLine } from "./cfo-scenarios";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const LINT = join(ROOT, "scripts/lint-wording/index.mjs");
const { checkText } = (await import(LINT)) as { checkText: (text: string) => readonly { term: string }[] };

const kinds = (i: CfoInputs): string[] => buildCfoReport(i).insights.map((x) => x.kind);
const insight = (i: CfoInputs, kind: CfoInsight["kind"]): CfoInsight | undefined => buildCfoReport(i).insights.find((x) => x.kind === kind);

describe("14-day Mei", () => {
  it("runway short (stage 1 only), stage 2 on track, reserve status; warn first", () => {
    const r = buildCfoReport(fourteenDays());
    expect(r.insights.map((x) => [x.kind, x.severity])).toEqual([
      ["RUNWAY_SHORT", "warn"],
      ["STAGE2_ON_TRACK", "info"],
      ["RESERVE_STATUS", "info"],
    ]);
    expect(r.insights.map((x) => x.insightId)).toEqual([
      "cfo-runway-short-all-2026-10-30",
      "cfo-stage2-on-track-all-2026-10-30",
      "cfo-reserve-status-all-2026-10-30",
    ]);
    expect(r.insights[0]?.detail).toContain("17 days");
    expect(r.insights[1]?.detail).toContain("8 Nov"); // ux-money: days read "8 Nov", never "2026-11-08"
    expect(r.insights[1]?.detail).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("no runway warning when the budget lasts 21 days or more", () => {
    expect(kinds({ ...fourteenDays(), releasedMinor: 1_000_000n })).not.toContain("RUNWAY_SHORT");
  });
});

describe("stage 2", () => {
  it("at risk when the MA7 trend misses deadline + 30 days (no projected date)", () => {
    const r = buildCfoReport(fourteenDays(1_500n));
    expect(r.sales.stageGate?.projectedDate).toBeNull();
    const x = r.insights.find((i) => i.kind === "STAGE2_AT_RISK");
    expect(x).toMatchObject({ severity: "warn", lineKey: null });
    expect(kinds(fourteenDays(1_500n))).not.toContain("STAGE2_ON_TRACK");
  });

  it("at risk when the projected date falls after the deadline", () => {
    const r = buildCfoReport(fourteenDays(2_500n)); // 70,000 so far, 5,000 a day → 26 days
    expect(r.sales.stageGate?.projectedDate).toBe("2026-11-25");
    expect(r.insights.find((i) => i.kind === "STAGE2_AT_RISK")?.detail).toContain("25 Nov");
  });

  it("reached: on track with a stage-release suggestion, dated by the sale that crossed the target", () => {
    const r = buildCfoReport(fourteenDays(7_500n)); // 15,000 a day: 195,000 after day 13, crossed on day 14
    expect(r.sales.stageGate?.projectedDate).toBe("2026-10-30");
    expect(r.insights.find((i) => i.kind === "STAGE2_ON_TRACK")?.suggestion).toEqual({ kind: "REQUEST_STAGE_RELEASE", href: "/dashboard#change-requests" });
  });

  it("deadline passed without the target: at risk", () => {
    const i = { ...fourteenDays(1_500n), now: at(31) };
    expect(insight(i, "STAGE2_AT_RISK")?.detail).toMatch(/deadline has passed/);
  });

  it("no stage insight on fewer than 3 days of data, and none without a stage", () => {
    expect(kinds(fresh())).toEqual([]);
    expect(kinds({ ...fourteenDays(), stage: null }).filter((k) => k.startsWith("STAGE2"))).toEqual([]);
  });
});

describe("burn, budget moves, reserve", () => {
  it("BURN_ALERT on an ads spike, with a tighten suggestion", () => {
    const x = insight(adsSpike(), "BURN_ALERT");
    expect(x).toMatchObject({ lineKey: "ADS", severity: "warn", suggestion: { kind: "TIGHTEN", href: null }, insightId: "cfo-burn-alert-ads-2026-10-30" });
    expect(x?.detail).toContain("1.6 times faster than planned");
  });

  // fixr-cfo (re-check LOW 3): once the agent lowered the line within its window, the alert links a prefilled request
  // to raise that cap back to its committed value; a tightening before the window does not count.
  it("after the agent lowered a burning line, BURN_ALERT links a prefilled request to raise the cap back", () => {
    const tightened = (when: Date): CfoInputs => ({
      ...adsSpike(),
      agentActions: [{ at: when.toISOString(), action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: "52500", reason: "Ads spent fast.", txHash: null }],
    });
    const x = insight(tightened(at(14, 1)), "BURN_ALERT");
    expect(x?.suggestion).toEqual({ kind: "TIGHTEN", href: "/dashboard?raise=ADS&cap=window&to=60000#change-requests" });
    expect(x?.detail).toContain("ask for a higher limit");
    expect(checkText(x?.detail ?? "")).toEqual([]);
    expect(insight(tightened(at(6)), "BURN_ALERT")?.suggestion).toEqual({ kind: "TIGHTEN", href: null });
  });

  it("no BURN_ALERT at the planned pace", () => {
    expect(kinds(fourteenDays())).not.toContain("BURN_ALERT");
  });

  it("MOVE_BUDGET when a line is nearly used up and contingency has room", () => {
    const i = fourteenDays();
    const nearlyOut = { ...i, lines: patchLine(i.lines, "PACKAGING", { spentMinor: 140_000n, availableMinor: 10_000n }) };
    expect(insight(nearlyOut, "MOVE_BUDGET")).toMatchObject({
      lineKey: "PACKAGING",
      severity: "warn",
      suggestion: { kind: "REQUEST_MOVE", href: "/dashboard#change-requests" },
    });
    const noRoom = { ...nearlyOut, lines: patchLine(nearlyOut.lines, "CONTINGENCY", { spentMinor: 100_000n, availableMinor: 0n }) };
    expect(kinds(noRoom)).not.toContain("MOVE_BUDGET");
  });

  it("RESERVE_STATUS warns when tax payments used more than half of the set-aside", () => {
    const i = fourteenDays();
    expect(insight({ ...i, reserve: { ...i.reserve, withdrawnMinor: 4_000n } }, "RESERVE_STATUS")?.severity).toBe("warn");
    expect(insight({ ...i, reserve: { ...i.reserve, withdrawnMinor: 3_150n } }, "RESERVE_STATUS")?.severity).toBe("info");
  });
});

describe("limits and determinism", () => {
  const crowded = (): CfoInputs => {
    const i = adsSpike();
    let lines = i.lines;
    for (const key of ["SUPPLIER", "PACKAGING", "LOGISTICS", "PLATFORM_FEES"] as const) {
      const l = lines.find((x) => x.lineKey === key);
      if (l) lines = patchLine(lines, key, { availableMinor: l.allocatedMinor / 20n });
    }
    return { ...i, lines, reserve: { ...i.reserve, withdrawnMinor: 4_000n } };
  };

  it("never more than 8, warnings first, unique ids", () => {
    const r = buildCfoReport(crowded());
    expect(r.insights).toHaveLength(8);
    const sev = r.insights.map((x) => x.severity);
    expect(sev.indexOf("info") === -1 || sev.lastIndexOf("warn") < sev.indexOf("info")).toBe(true);
    expect(new Set(r.insights.map((x) => x.insightId)).size).toBe(8);
    expect(buildCfoReport(crowded()).insights).toEqual(r.insights);
  });

  it("ids match §3 Id and fit their length limits", () => {
    for (const x of buildCfoReport(crowded()).insights) {
      expect(x.insightId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
      expect(x.title.length).toBeLessThanOrEqual(80);
      expect(x.detail.length).toBeLessThanOrEqual(280);
    }
  });
});

describe("wording", () => {
  const scenarios: CfoInputs[] = [
    fresh(),
    fourteenDays(),
    fourteenDays(1_500n),
    fourteenDays(2_500n),
    fourteenDays(7_500n),
    { ...fourteenDays(1_500n), now: at(31) },
    adsSpike(),
    { ...adsSpike(), reserve: { ...adsSpike().reserve, withdrawnMinor: 4_000n } },
    { ...fourteenDays(), lines: patchLine(fourteenDays().lines, "PACKAGING", { availableMinor: 1_000n }) },
  ];
  const texts = scenarios.flatMap((i) => [
    ...buildCfoReport(i).insights.flatMap((x) => [x.title, x.detail]),
    ...proposeTightenings(i).map((t) => t.reason),
    buildCfoReport(i).disclaimer,
  ]);

  it("covers every insight kind", () => {
    const seen = new Set(scenarios.flatMap((i) => buildCfoReport(i).insights.map((x) => x.kind)));
    expect([...seen].sort()).toEqual(["BURN_ALERT", "MOVE_BUDGET", "RESERVE_STATUS", "RUNWAY_SHORT", "STAGE2_AT_RISK", "STAGE2_ON_TRACK"]);
  });

  it("every founder-facing string passes checkText and never says 'confidence'", () => {
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) {
      expect(checkText(t).map((f) => f.term), t).toEqual([]);
      expect(t.toLowerCase()).not.toContain("confidence");
    }
  });

  it("proposal reasons fit 200 characters", () => {
    for (const i of scenarios) for (const t of proposeTightenings(i)) expect(t.reason.length).toBeLessThanOrEqual(200);
  });
});
