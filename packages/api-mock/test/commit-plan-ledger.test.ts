// The fresh scenario's first plan commit builds the ledger the way Treasury.commitPlan does: one pocket per line and
// the first stage released (a demo found the wallet rail empty after "your plan is live on the chain").
import { describe, expect, it } from "vitest";
import { examplePlanManifest, parseMinor } from "@hogee/core";
import { commitPlanLedger, freshState, getState } from "../src/store";
import { readEnv } from "../src/env";

describe("commitPlanLedger", () => {
  it("builds one pocket per manifest line and releases the first stage on an empty ledger", () => {
    const st = freshState(getState(readEnv()));
    expect(st.balances.pockets).toEqual([]);
    commitPlanLedger(st, examplePlanManifest);
    expect(st.balances.pockets.map((p) => p.lineKey)).toEqual(examplePlanManifest.lines.map((l) => l.lineKey));
    for (const [i, p] of st.balances.pockets.entries()) {
      const line = examplePlanManifest.lines[i];
      expect(p).toMatchObject({ allocated: line?.amountMinor, available: line?.amountMinor, spent: "0", windowSpent: "0", paused: false, circuitOpen: false });
    }
    const first = examplePlanManifest.stages.find((s) => s.gate === null);
    expect(parseMinor(st.balances.releasedMinor)).toBe(parseMinor(first?.releaseMinor ?? "0"));
  });

  it("leaves a ledger that already has pockets alone (the default seed, or a replan)", () => {
    const st = getState(readEnv());
    const before = structuredClone(st.balances);
    commitPlanLedger(st, examplePlanManifest);
    expect(st.balances).toEqual(before);
  });
});
