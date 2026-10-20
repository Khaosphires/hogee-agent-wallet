/** What the stepper tells assistive tech: one aria-current="step", and a spoken state for the others. */
import { describe, expect, it } from "vitest";
import { stepperItems, type StepperStep } from "./stepper-steps";

const JOURNEY: StepperStep[] = [
  { label: "Plan", state: "done" },
  { label: "Suppliers", state: "done" },
  { label: "Terms", state: "current" },
  { label: "Order", state: "upcoming" },
  { label: "Operating", state: "upcoming" },
];

describe("stepperItems", () => {
  it("marks only the current step with aria-current=step", () => {
    const items = stepperItems(JOURNEY);
    expect(items.map((i) => i.ariaCurrent)).toEqual([undefined, undefined, "step", undefined, undefined]);
  });

  it("gives done and upcoming steps a spoken state, and the current one none (aria-current says it)", () => {
    expect(stepperItems(JOURNEY).map((i) => i.srState)).toEqual(["completed", "completed", "", "not started", "not started"]);
  });

  it("numbers steps from 1 and keeps label and state", () => {
    expect(stepperItems(JOURNEY)[2]).toEqual({ label: "Terms", state: "current", number: 3, ariaCurrent: "step", srState: "", key: "2-Terms" });
  });

  it("keeps aria-current on the first current step when given more than one", () => {
    const items = stepperItems([
      { label: "A", state: "current" },
      { label: "B", state: "current" },
    ]);
    expect(items.map((i) => i.ariaCurrent)).toEqual(["step", undefined]);
    expect(items[1]?.srState).toBe("");
  });

  it("has no aria-current when nothing is current (all done, or not started)", () => {
    expect(stepperItems([{ label: "A", state: "done" }]).map((i) => i.ariaCurrent)).toEqual([undefined]);
    expect(stepperItems([{ label: "A", state: "upcoming" }]).map((i) => i.ariaCurrent)).toEqual([undefined]);
  });

  it("returns nothing for no steps", () => {
    expect(stepperItems([])).toEqual([]);
  });

  it("carries a step's tone (the payment card's Signed → Cooling → Paid) only when one is given", () => {
    const items = stepperItems([
      { label: "Signed", state: "done", tone: "paid" },
      { label: "Cooling", state: "current", tone: "agent" },
      { label: "Paid", state: "upcoming" },
    ]);
    expect(items.map((i) => i.tone)).toEqual(["paid", "agent", undefined]);
    expect("tone" in (items[2] ?? {})).toBe(false);
  });
});
