/**
 * proposeTightenings (VISION-DECISIONS §8 core-cfo, §9 "CFO actions"): the agent may only tighten, every proposal
 * passes core policy evaluateTighten, values are whole BU (≥ 1 BU, never under a paced line's slot), RAISE_RESERVE_BPS
 * never above 1000 bps, at most one proposal per line per UTC day (idempotent against recorded agent actions).
 *
 * fixr-cfo (re-check LOW 3, the guard must not ratchet on spending it does not control): burn counts the agent's own
 * SPEND only; a lowered cap never goes below half the committed cap, the line's largest bill or a pacing slot; at most
 * one tightening per line per rolling window (windowSeconds, at least a day); every line tightening carries a
 * prefilled RAISE_CAP change-request link.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateTighten } from "../src/policy/governance";
import { proposeTightenings, tightenContextOf, toTightenProposal } from "../src/cfo/tighten";
import type { CfoAgentAction, CfoInputs, CfoTightening } from "../src/cfo/types";
import { buildCfoReport } from "../src/cfo/report";
import { LINE_KEYS, type LineKey } from "../src/schemas/enums";
import { adsSpike, at, fourteenDays, fresh, pay, patchLine, range } from "./cfo-scenarios";

const passes = (t: CfoTightening, i: CfoInputs): string => evaluateTighten(toTightenProposal(t), tightenContextOf(i)).verdict;
const action = (lineKey: LineKey | null, when: Date, act: CfoAgentAction["action"] = "LOWER_WINDOW_CAP"): CfoAgentAction => ({
  at: when.toISOString(),
  action: act,
  lineKey,
  newValue: "52500",
  reason: "Ads spent faster than planned.",
  txHash: null,
});
const ADS_WINDOW_RAISE = "/dashboard?raise=ADS&cap=window&to=60000#change-requests";
const ADS_PER_TX_RAISE = "/dashboard?raise=ADS&cap=perTx&to=30000#change-requests";

/** Two weeks of Mei plus LOGISTICS agent spending on the last days (non-paced line, committed window cap 40,000). */
const logistics = (spend: readonly bigint[], available: bigint, patch: Partial<CfoInputs["lines"][number]> = {}): CfoInputs => {
  const i = fourteenDays();
  const total = spend.reduce((a, b) => a + b, 0n);
  const lines = patchLine(i.lines, "LOGISTICS", { spentMinor: total, availableMinor: available, allocatedMinor: total + available, ...patch });
  return { ...i, lines, payments: [...i.payments, ...spend.map((a, k) => pay("SPEND", "LOGISTICS", a, at(14 - spend.length + 1 + k)))] };
};

describe("ads burn spike", () => {
  it("lowers the ads rolling limit to the planned pace (7,500 × 7 days)", () => {
    const out = proposeTightenings(adsSpike());
    expect(out).toEqual([{ action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: 52_500n, reason: expect.any(String), raiseHref: ADS_WINDOW_RAISE }]);
    expect(out[0]?.reason).toContain("1.6×");
    expect(out[0]?.reason).toContain("ask for a higher cap");
    expect(passes(out[0] as CfoTightening, adsSpike())).toBe("AUTO");
  });

  // fixr-cfo: was one pacing slot (7,500); now floored at half the committed per-payment cap (30,000 → 15,000), which is
  // above the slot and the line's largest bill (12,500).
  it("without the window length, lowers the per-payment limit instead, to half its committed value", () => {
    const i = adsSpike();
    const out = proposeTightenings({ ...i, lines: patchLine(i.lines, "ADS", { windowSeconds: undefined }) });
    expect(out).toEqual([{ action: "LOWER_PER_TX_CAP", lineKey: "ADS", newValue: 15_000n, reason: expect.any(String), raiseHref: ADS_PER_TX_RAISE }]);
  });

  it("falls back to the per-payment limit when the rolling limit is already at or below the target", () => {
    const i = adsSpike();
    const out = proposeTightenings({ ...i, lines: patchLine(i.lines, "ADS", { windowCapMinor: 52_500n }) });
    expect(out.map((t) => [t.action, t.newValue])).toEqual([["LOWER_PER_TX_CAP", 15_000n]]); // fixr-cfo: was 7,500
  });

  it("proposes nothing when both limits are already at or below the targets (never loosens)", () => {
    const i = adsSpike();
    expect(proposeTightenings({ ...i, lines: patchLine(i.lines, "ADS", { windowCapMinor: 40_000n, perTxCapMinor: 7_500n }) })).toEqual([]);
  });

  it("never sizes a paced line below its next pacing slot", () => {
    const i = adsSpike();
    // A one-hour window sizes 312 minor; the floors lift it: the slot (7,500) and, above that, half the committed
    // rolling limit (60,000 → 30,000). fixr-cfo: was 7,500 (the slot alone).
    const out = proposeTightenings({ ...i, lines: patchLine(i.lines, "ADS", { windowSeconds: 3_600n }) });
    expect(out.map((t) => [t.action, t.newValue])).toEqual([["LOWER_WINDOW_CAP", 30_000n]]);
    const halfBelowSlot = proposeTightenings({ ...i, lines: patchLine(i.lines, "ADS", { windowSeconds: 3_600n, committedWindowCapMinor: 10_000n }) });
    expect(halfBelowSlot.map((t) => [t.action, t.newValue])).toEqual([["LOWER_WINDOW_CAP", 12_500n]]); // the largest bill
  });

  it("nothing at the planned pace, on fewer than 3 days of data, or on an expired line", () => {
    expect(proposeTightenings(fourteenDays())).toEqual([]);
    expect(proposeTightenings({ ...fresh(), payments: [pay("SPEND", "ADS", 30_000n, at(13)), pay("SPEND", "ADS", 30_000n, at(14))] })).toEqual([]);
    const i = adsSpike();
    expect(proposeTightenings({ ...i, lines: patchLine(i.lines, "ADS", { validUntil: BigInt(at(14).getTime() / 1000) }) })).toEqual([]);
  });
});

describe("non-paced lines: whole BU, never below the floors", () => {
  it("rounds the target down to whole BU when it is above every floor", () => {
    // remaining 80,000 over 45 days left + 7 → 80,000 × 7 / 52 = 10,769.23 → 10,700 (committed 20,000: floor 10,000)
    const out = proposeTightenings(logistics([9_000n, 9_000n], 62_000n, { committedWindowCapMinor: 20_000n }));
    expect(out).toEqual([{ action: "LOWER_WINDOW_CAP", lineKey: "LOGISTICS", newValue: 10_700n, reason: expect.any(String), raiseHref: "/dashboard?raise=LOGISTICS&cap=window&to=20000#change-requests" }]);
  });

  // fixr-cfo: these two were 10,700 and 100 (1 BU) before the half-committed floor.
  it("stops at half the committed rolling limit (40,000 → 20,000), not at the pace", () => {
    const out = proposeTightenings(logistics([20_000n, 20_000n], 40_000n));
    expect(out.map((t) => [t.action, t.lineKey, t.newValue])).toEqual([["LOWER_WINDOW_CAP", "LOGISTICS", 20_000n]]);
    expect(proposeTightenings(logistics([75n, 75n], 50n)).map((t) => [t.action, t.lineKey, t.newValue])).toEqual([["LOWER_WINDOW_CAP", "LOGISTICS", 20_000n]]);
  });

  it("never below the line's largest bill of the last 30 days", () => {
    const out = proposeTightenings(logistics([15_000n, 3_000n], 62_000n, { committedWindowCapMinor: 20_000n }));
    expect(out.map((t) => [t.action, t.newValue])).toEqual([["LOWER_WINDOW_CAP", 15_000n]]);
  });

  it("no ratchet: a line already at half its committed caps is never lowered again", () => {
    const i = logistics([20_000n, 20_000n], 40_000n, { windowCapMinor: 20_000n, perTxCapMinor: 10_000n });
    expect(proposeTightenings({ ...i, agentActions: [action("LOGISTICS", at(6))] })).toEqual([]);
  });

  it("proposes nothing on a line whose committed caps are not given (it cannot know how far it may go)", () => {
    const i = logistics([20_000n, 20_000n], 40_000n, { committedWindowCapMinor: undefined, committedPerTxCapMinor: undefined });
    expect(proposeTightenings(i)).toEqual([]);
  });
});

describe("burn counts the agent's own spending only", () => {
  /** Ads at its pace (7,500 a day) from the agent, plus the founder's own 5,000 a day on days 8-14. */
  const ownerSpike = (): CfoInputs => {
    const i = adsSpike();
    const payments = [
      ...i.payments.filter((p) => p.lineKey !== "ADS"),
      ...range(1, 14).map((d) => pay("SPEND", "ADS", 7_500n, at(d, 9))),
      ...range(8, 14).map((d) => pay("OWNER_SPEND", "ADS", 5_000n, at(d, 10))),
    ];
    return { ...i, payments };
  };

  it("the founder's own spending never makes the agent tighten, nor raises a burn alert", () => {
    expect(proposeTightenings(ownerSpike())).toEqual([]);
    expect(buildCfoReport(ownerSpike()).insights.map((x) => x.kind)).not.toContain("BURN_ALERT");
  });

  it("the same amounts spent by the agent do", () => {
    const i = ownerSpike();
    const asAgent = { ...i, payments: i.payments.map((p) => (p.kind === "OWNER_SPEND" ? { ...p, kind: "SPEND" as const } : p)) };
    expect(proposeTightenings(asAgent).map((t) => [t.action, t.lineKey])).toEqual([["LOWER_WINDOW_CAP", "ADS"]]);
  });
});

describe("reserve rate", () => {
  const withdrawn = (i: CfoInputs, w: bigint, rateBps = i.reserve.rateBps): CfoInputs => ({ ...i, reserve: { ...i.reserve, withdrawnMinor: w, rateBps } });

  it("raises by 1 point when tax payments used more than half of the set-aside", () => {
    const out = proposeTightenings(withdrawn(fourteenDays(), 4_000n));
    expect(out).toEqual([{ action: "RAISE_RESERVE_BPS", lineKey: null, newValue: 600n, reason: expect.any(String) }]);
    expect(passes(out[0] as CfoTightening, withdrawn(fourteenDays(), 4_000n))).toBe("AUTO");
  });

  it("never above 1000 bps", () => {
    expect(proposeTightenings(withdrawn(fourteenDays(), 4_000n, 950)).map((t) => t.newValue)).toEqual([1_000n]);
    expect(proposeTightenings(withdrawn(fourteenDays(), 4_000n, 1_000))).toEqual([]);
    expect(proposeTightenings(withdrawn(fourteenDays(), 4_000n, 1_200))).toEqual([]);
  });

  it("raises from the higher of the live and the committed rate", () => {
    const i = { ...withdrawn(fourteenDays(), 4_000n), reserveBps: 700 };
    expect(proposeTightenings(i).map((t) => t.newValue)).toEqual([800n]);
  });

  it("only when revenue is recorded, and not when half or less was used", () => {
    expect(proposeTightenings({ ...fresh(), reserve: { ...fresh().reserve, skimmedMinor: 0n, withdrawnMinor: 0n } })).toEqual([]);
    expect(proposeTightenings(withdrawn(fourteenDays(), 3_150n))).toEqual([]);
  });
});

describe("at most one tightening per line per window", () => {
  // fixr-cfo: was per UTC day (a tightening "yesterday" at 23:00 allowed another today); now the line's rolling window.
  it("skips a line the agent tightened within its rolling window (7 days), not one tightened before it", () => {
    const i = adsSpike();
    expect(proposeTightenings({ ...i, agentActions: [action("ADS", at(14, 1))] })).toEqual([]);
    expect(proposeTightenings({ ...i, agentActions: [action("ADS", at(13, 23))] })).toEqual([]);
    expect(proposeTightenings({ ...i, agentActions: [action("ADS", at(7, 13))] })).toEqual([]); // 6 days 23 h ago
    expect(proposeTightenings({ ...i, agentActions: [action("ADS", at(7, 11))] })).toHaveLength(1); // 7 days 1 h ago
    expect(proposeTightenings({ ...i, agentActions: [action("LOGISTICS", at(14, 1))] })).toHaveLength(1);
  });

  it("a line without a window length: at most one a day (a rolling 24 h)", () => {
    const i = adsSpike();
    const noWindow = { ...i, lines: patchLine(i.lines, "ADS", { windowSeconds: undefined }) };
    expect(proposeTightenings({ ...noWindow, agentActions: [action("ADS", at(13, 13), "LOWER_PER_TX_CAP")] })).toEqual([]);
    expect(proposeTightenings({ ...noWindow, agentActions: [action("ADS", at(13, 11), "LOWER_PER_TX_CAP")] })).toHaveLength(1);
  });

  it("the reserve counts as one line, once per UTC day", () => {
    const i = { ...fourteenDays(), reserve: { ...fourteenDays().reserve, withdrawnMinor: 4_000n } };
    expect(proposeTightenings({ ...i, agentActions: [action(null, at(14, 0), "RAISE_RESERVE_BPS")] })).toEqual([]);
    expect(proposeTightenings({ ...i, agentActions: [action(null, at(13, 23), "RAISE_RESERVE_BPS")] })).toHaveLength(1);
    expect(proposeTightenings({ ...i, agentActions: [action(null, at(14, 0), "PAUSE")] })).toHaveLength(1);
  });

  it("a reserve proposal carries no raise link (it is not a cap)", () => {
    const out = proposeTightenings({ ...fourteenDays(), reserve: { ...fourteenDays().reserve, withdrawnMinor: 4_000n } });
    expect(out).toHaveLength(1);
    expect(out[0]?.raiseHref).toBeUndefined();
  });

  it("is idempotent: the same inputs give the same proposals", () => {
    expect(proposeTightenings(adsSpike())).toEqual(proposeTightenings(adsSpike()));
  });
});

describe("only tighten: every proposal passes evaluateTighten", () => {
  it("the guard context denies a loosening (a higher cap, a lower reserve rate)", () => {
    const i = adsSpike();
    const ctx = tightenContextOf(i);
    expect(evaluateTighten(toTightenProposal({ action: "LOWER_WINDOW_CAP", lineKey: "ADS", newValue: 100_001n, reason: "x" }), ctx)).toMatchObject({ verdict: "DENY", reasonCode: "NotOwner" });
    expect(evaluateTighten(toTightenProposal({ action: "LOWER_PER_TX_CAP", lineKey: "ADS", newValue: 30_001n, reason: "x" }), ctx)).toMatchObject({ verdict: "DENY", reasonCode: "NotOwner" });
    expect(evaluateTighten(toTightenProposal({ action: "RAISE_RESERVE_BPS", lineKey: null, newValue: 400n, reason: "x" }), ctx)).toMatchObject({ verdict: "DENY", reasonCode: "NotOwner" });
    expect(evaluateTighten(toTightenProposal({ action: "LOWER_WINDOW_CAP", lineKey: "LICENSING", newValue: 1n, reason: "x" }), ctx)).toMatchObject({ verdict: "DENY", reasonCode: "LineExpired" });
  });

  it("property: random spending never yields a loosening, a sub-BU value, a value under a floor or two proposals on one line", () => {
    const lineArb = fc.record({
      perTx: fc.bigInt({ min: 100n, max: 200_000n }),
      window: fc.bigInt({ min: 100n, max: 400_000n }),
      committedPerTx: fc.bigInt({ min: 100n, max: 200_000n }),
      committedWindow: fc.bigInt({ min: 100n, max: 400_000n }),
      available: fc.bigInt({ min: 0n, max: 500_000n }),
      pacing: fc.option(fc.bigInt({ min: 1n, max: 20_000n }), { nil: undefined }),
      windowSeconds: fc.option(fc.bigInt({ min: 1n, max: 2_592_000n }), { nil: undefined }),
      spends: fc.array(fc.record({ day: fc.integer({ min: 0, max: 14 }), amount: fc.bigInt({ min: 1n, max: 60_000n }) }), { maxLength: 10 }),
    });
    const seen = new Set<string>();
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 7, maxLength: 7 }), fc.integer({ min: 0, max: 2_000 }), fc.bigInt({ min: 0n, max: 10_000n }), (cfg, rate, withdrawnMinor) => {
        const base = fourteenDays();
        const lines = LINE_KEYS.map((lineKey, k) => {
          const c = cfg[k] as (typeof cfg)[number];
          const spent = c.spends.reduce((a, s) => a + s.amount, 0n);
          return {
            lineKey,
            allocatedMinor: spent + c.available,
            spentMinor: spent,
            escrowedMinor: 0n,
            availableMinor: c.available,
            perTxCapMinor: c.perTx,
            windowCapMinor: c.window,
            committedPerTxCapMinor: c.committedPerTx,
            committedWindowCapMinor: c.committedWindow,
            windowSpentMinor: 0n,
            validUntil: BigInt(at(60, 0).getTime() / 1000),
            ...(c.pacing === undefined ? {} : { pacingMinor: c.pacing }),
            ...(c.windowSeconds === undefined ? {} : { windowSeconds: c.windowSeconds }),
          };
        });
        const payments = LINE_KEYS.flatMap((lineKey, k) => (cfg[k]?.spends ?? []).map((s) => pay("SPEND", lineKey, s.amount, at(s.day, 6))));
        const i: CfoInputs = { ...base, lines, payments, reserve: { ...base.reserve, rateBps: rate, withdrawnMinor: withdrawnMinor > 6_300n ? 6_300n : withdrawnMinor } };
        const out = proposeTightenings(i);
        const keys = out.map((t) => t.lineKey ?? "RESERVE");
        expect(new Set(keys).size).toBe(keys.length);
        for (const t of out) {
          seen.add(t.action);
          expect(passes(t, i)).toBe("AUTO");
          if (t.action === "RAISE_RESERVE_BPS") {
            expect(t.newValue > BigInt(Math.max(rate, i.reserveBps))).toBe(true);
            expect(t.newValue <= 1_000n).toBe(true);
            continue;
          }
          const line = lines.find((l) => l.lineKey === t.lineKey);
          const current = t.action === "LOWER_PER_TX_CAP" ? line?.perTxCapMinor : line?.windowCapMinor;
          expect(t.newValue < (current ?? 0n)).toBe(true);
          expect(t.newValue >= 100n).toBe(true);
          const committed = t.action === "LOWER_PER_TX_CAP" ? line?.committedPerTxCapMinor : line?.committedWindowCapMinor;
          expect(t.newValue * 2n >= (committed ?? 0n)).toBe(true);
          const bills = i.payments.filter((p) => p.kind === "SPEND" && p.lineKey === t.lineKey).map((p) => p.amountMinor);
          for (const b of bills) expect(t.newValue >= b).toBe(true);
          if (line?.pacingMinor !== undefined) expect(t.newValue >= line.pacingMinor).toBe(true);
          else expect(t.newValue % 100n).toBe(0n);
        }
      }),
      { numRuns: 300, seed: 20_261_019 },
    );
    expect([...seen].sort()).toEqual(["LOWER_PER_TX_CAP", "LOWER_WINDOW_CAP", "RAISE_RESERVE_BPS"]); // not vacuous
  });
});

