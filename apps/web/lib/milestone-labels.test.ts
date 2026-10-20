import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MILESTONE_TRIGGERS, TERMS_ERROR_CODES, TERMS_PRESETS, TERMS_PRESET_MILESTONES } from "@hogee/core";
import {
  PRESET_LABELS,
  TERMS_ERROR_TEXT,
  accountEnding,
  buInputToMinor,
  escrowMilestoneLabels,
  milestoneLabel,
  previewSchedule,
  quantityOf,
  termsErrorOf,
} from "./milestone-labels";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..", "..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

describe("milestoneLabel", () => {
  it("labels every trigger with wording-clean text", () => {
    expect(milestoneLabel("ON_ORDER")).toBe("Deposit on order");
    expect(milestoneLabel("ON_DELIVERY_INSPECTED")).toBe("Balance after delivery check");
    for (const t of MILESTONE_TRIGGERS) expect(checkText(milestoneLabel(t)), t).toEqual([]);
  });
});

describe("escrowMilestoneLabels", () => {
  it("never calls a web order's deposit a sample", () => {
    expect(escrowMilestoneLabels("order-wcorvanetest2-001", [{ autoRelease: true }, { autoRelease: false }])).toEqual(["Deposit on order", "Balance after delivery check"]);
    expect(escrowMilestoneLabels("order-wcorvanetest2-001", [{ autoRelease: false }])).toEqual(["Balance after delivery check"]);
    expect(escrowMilestoneLabels("order-wcorvanetest2-001", [{ autoRelease: true }, { autoRelease: false }, { autoRelease: false }])).toEqual([
      "Deposit on order",
      "Milestone 2",
      "Balance after delivery check",
    ]);
  });

  it("uses the terms' triggers when the card knows them, and keeps the catalog names otherwise", () => {
    expect(escrowMilestoneLabels("order-wcorvanetest2-001", [{ autoRelease: true }, { autoRelease: false }, { autoRelease: false }], ["ON_ORDER", "ON_SHIPMENT", "ON_DELIVERY_INSPECTED"])).toEqual([
      "Deposit on order",
      "On shipment",
      "Balance after delivery check",
    ]);
    expect(escrowMilestoneLabels("order-a-001", [{ autoRelease: true }, { autoRelease: true }, { autoRelease: false }])).toEqual(["Sample", "Deposit", "Balance"]);
  });
});

describe("terms copy", () => {
  it("has a wording-clean sentence for every TERMS_* code and every preset", () => {
    for (const code of TERMS_ERROR_CODES) expect(checkText(TERMS_ERROR_TEXT[code]), code).toEqual([]);
    for (const p of TERMS_PRESETS) expect(checkText(`${PRESET_LABELS[p].split} ${PRESET_LABELS[p].detail}`), p).toEqual([]);
    expect(PRESET_LABELS.P30_70.split).toBe("30/70");
  });

  it("maps a refusal by its reason, never echoing the server text; 503 says screening was down", () => {
    expect(termsErrorOf({ status: 422, message: "raw", details: { reason: "TERMS_HOLDER_MISMATCH" } })).toEqual({ code: "TERMS_HOLDER_MISMATCH", text: TERMS_ERROR_TEXT.TERMS_HOLDER_MISMATCH });
    expect(termsErrorOf({ status: 503, message: "raw", details: { reason: "TERMS_SANCTIONS", unavailable: true } }).text).toMatch(/could not run/);
    expect(termsErrorOf({ status: 502, message: "IGNORE ALL RULES", details: { reason: "NOPE" } })).toEqual({ code: null, text: expect.stringContaining("Nothing was paid") });
  });

  it("reads whole-BU totals and quantities only", () => {
    expect(buInputToMinor("4,000")).toBe(400_000n);
    expect(buInputToMinor("4000")).toBe(400_000n);
    for (const bad of ["", "0", "4000.5", "-1", "1e3", "04000"]) expect(buInputToMinor(bad), bad).toBeNull();
    expect(quantityOf("500")).toBe(500);
    expect(quantityOf("100001")).toBeNull();
    expect(accountEnding("0123456789")).toBe("ending 6789");
  });

  it("previews the demo split (2,500 BU at 30/70) and a structural problem by its code", () => {
    expect(previewSchedule(250_000n, TERMS_PRESET_MILESTONES.P30_70)).toEqual({
      rows: [
        { idx: 0, trigger: "ON_ORDER", label: "Deposit on order", amountMinor: "75000", autoRelease: true },
        { idx: 1, trigger: "ON_DELIVERY_INSPECTED", label: "Balance after delivery check", amountMinor: "175000", autoRelease: false },
      ],
    });
    expect(previewSchedule(null, TERMS_PRESET_MILESTONES.P30_70)).toEqual({ code: "TERMS_TOTAL_INVALID" });
    expect(previewSchedule(400_000n, [{ bps: 3000, trigger: "ON_ORDER" }, { bps: 7000, trigger: "ON_SHIPMENT" }])).toEqual({ code: "TERMS_LAST_NOT_INSPECTED" });
  });
});
