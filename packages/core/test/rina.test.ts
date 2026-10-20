/**
 * The §26.2 Rina numbers satisfy the §8.3 constitution. (The reusable TS constitution mirror is task 1.10;
 * these checks are written out here on purpose.)
 */
import { describe, expect, it } from "vitest";
import {
  JUDGING_WINDOW_END_ISO,
  PlanManifest,
  RINA_COMMIT_AT,
  RINA_FACILITY,
  RINA_LINES,
  RINA_PLAN,
  RINA_STAGES,
  RINA_SUPPLIER_A_SCHEDULE,
  RINA_SUPPLIER_A_SCHEDULE_TOTAL,
  SECONDS_PER_DAY,
  examplePlanManifest,
} from "../src/index";

const big = (s: string) => BigInt(s);
const sum = (xs: readonly string[]) => xs.reduce((a, x) => a + big(x), 0n);
const now = big(RINA_COMMIT_AT);
const ninetyDays = BigInt(90 * SECONDS_PER_DAY);
const total = sum(RINA_LINES.map((l) => l.amountMinor));

describe("Rina numbers satisfy the constitution (§8.3)", () => {
  it("lines sum to 1,000,000 and do not exceed the facility cap", () => {
    expect(total).toBe(1_000_000n);
    expect(total <= big(RINA_FACILITY.capMinor)).toBe(true);
    expect(RINA_LINES).toHaveLength(6);
  });

  it.each(RINA_LINES.map((l) => [l.lineKey, l] as const))("%s: perTxCap ≤ 25% and windowCap ≤ 50% of the line", (_k, l) => {
    expect(big(l.perTxCapMinor) * 4n <= big(l.amountMinor)).toBe(true);
    expect(big(l.windowCapMinor) * 2n <= big(l.amountMinor)).toBe(true);
  });

  it("validUntil and agent expiry are within now + 90 days; expiry is after the judging window", () => {
    expect(big(RINA_PLAN.validUntil) <= now + ninetyDays).toBe(true);
    expect(big(RINA_PLAN.agentExpiresAt) <= now + ninetyDays).toBe(true);
    expect(Number(RINA_PLAN.agentExpiresAt)).toBeGreaterThan(Date.parse(JUDGING_WINDOW_END_ISO) / 1000);
    expect(big(RINA_PLAN.agentExpiresAt) - now).toBe(BigInt(RINA_PLAN.agentExpiryDays * SECONDS_PER_DAY));
  });

  it("reserveBps ≥ the facility reserve floor", () => {
    expect(RINA_PLAN.reserveBps).toBeGreaterThanOrEqual(RINA_FACILITY.reserveFloorBps);
  });

  it("stage 1 releases ≤ 40% of the total; stages sum to the total", () => {
    const [first] = RINA_STAGES;
    expect(first?.gate).toBeNull();
    expect(big(first?.releaseMinor ?? "0") * 10n <= total * 4n).toBe(true);
    expect(sum(RINA_STAGES.map((s) => s.releaseMinor))).toBe(total);
  });

  it("the supplier line is escrow-only and the schedule (430,000) fits inside it", () => {
    const supplier = RINA_LINES.find((l) => l.lineKey === "SUPPLIER");
    expect(supplier?.escrowOnly).toBe(true);
    expect(supplier?.payeeIds).toEqual([]);
    const scheduleTotal = sum(RINA_SUPPLIER_A_SCHEDULE.map((m) => m.amountMinor));
    expect(scheduleTotal).toBe(big(RINA_SUPPLIER_A_SCHEDULE_TOTAL));
    expect(scheduleTotal).toBe(430_000n);
    expect(scheduleTotal <= big(supplier?.amountMinor ?? "0")).toBe(true);
  });

  it("only sample and deposit auto-release; the balance cannot be funded inside stage 1 (stop-loss)", () => {
    expect(RINA_SUPPLIER_A_SCHEDULE.map((m) => m.autoRelease)).toEqual([true, true, false]);
    const stage1 = big(RINA_STAGES[0]?.releaseMinor ?? "0");
    expect(sum(RINA_SUPPLIER_A_SCHEDULE.map((m) => m.amountMinor)) > stage1).toBe(true);
  });

  it("no non-supplier line is escrow-only; only ADS has pacing", () => {
    expect(RINA_LINES.filter((l) => l.escrowOnly).map((l) => l.lineKey)).toEqual(["SUPPLIER"]);
    expect(RINA_LINES.filter((l) => l.pacingPerDayMinor).map((l) => l.lineKey)).toEqual(["ADS"]);
  });

  it("the example manifest built from these numbers is schema-valid", () => {
    expect(PlanManifest.safeParse(examplePlanManifest).success).toBe(true);
    expect(examplePlanManifest.totalMinor).toBe("1000000");
  });
});
