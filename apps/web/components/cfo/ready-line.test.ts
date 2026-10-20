import { describe, expect, it } from "vitest";
import { readyLine } from "./ready-line";

const stages = [
  { stageId: "stage-1", releaseMinor: "400000", gate: null },
  { stageId: "stage-2", releaseMinor: "600000", gate: { metric: "salesMinor", target: "200000", deadline: "1794700800" } },
];
const plan = (status: string) => ({ status, manifest: { stages } }) as never;

describe("the line under Ready to spend", () => {
  it("before a plan: how the wallet opens", () => {
    expect(readyLine(undefined, null, true)).toBe("Opens when your plan is signed and funded.");
    expect(readyLine(plan("DRAFT"), { fundedMinor: "0", releasedMinor: "0" }, false)).toBe("Opens when your plan is signed and funded.");
  });
  it("signed, not funded yet: the loan officer is adding the first release", () => {
    expect(readyLine(plan("COMMITTED"), { fundedMinor: "0", releasedMinor: "400000" }, false)).toBe("Your loan officer is adding 4,000 BU next.");
  });
  it("funded: how much more opens, and after how much in sales (from the plan, not hard-coded)", () => {
    expect(readyLine(plan("COMMITTED"), { fundedMinor: "1000000", releasedMinor: "400000" }, false)).toBe("6,000 BU more after 2,000 BU in sales.");
  });
  it("every release out: nothing more to wait for", () => {
    expect(readyLine(plan("COMMITTED"), { fundedMinor: "1000000", releasedMinor: "1000000" }, false)).toBe("Yours to use now, inside your plan's limits.");
  });
});
