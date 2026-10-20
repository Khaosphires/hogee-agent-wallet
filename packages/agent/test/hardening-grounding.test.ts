/**
 * Security audit run-8 hardening: SGD budget grounding (critic gap 5). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { MEI_PLAN_INTENT, examplePlanIntent } from "@hogee/core";
import { groundIntent, statedAmounts, type PlannerTurn } from "../src/planner/grounding";

describe("SGD budget grounding cannot be steered to another amount or currency (run-8 critic gap 5)", () => {
  const SG = { countryCode: "SG" as const, currency: "SGD" as const };
  const MY = { countryCode: "MY" as const, currency: "MYR" as const };
  const user = (text: string): PlannerTurn => ({ role: "user", text });
  const afterBudget = (text: string) => groundIntent(MEI_PLAN_INTENT, [user("I have S$10,000."), user(text)], SG);
  const budget = (minor: string) => ({ ...MEI_PLAN_INTENT, budgetCeilingMinor: minor });

  it("the founder's figure wins over a bare-$ one next to it", () => {
    expect(statedAmounts("S$10,000 not $1,000,000", "SGD")).toEqual(["1000000"]);
    expect(groundIntent(budget("100000000"), [user("S$10,000 not $1,000,000")], SG)).toMatchObject({ ok: false, reason: "BUDGET_NOT_STATED" });
    expect(groundIntent(MEI_PLAN_INTENT, [user("S$10,000 not $1,000,000")], SG)).toMatchObject({ ok: true });
  });

  it.each([
    ["a currency code glued to the figure", "S$10,000USD"],
    ["a currency code before the S$ figure", "USD S$10,000"],
    ["two markers several spaces apart", "US$     10,000 SGD"],
    ["two markers a colon apart", "US$: 10,000 SGD"],
    ["a zero-width space inside US$", "U\u200bS$10,000"],
    ["a space as the thousands separator", "S$10 000"],
    ["an apostrophe as the thousands separator", "S$10'000"],
    ["a space after the thousands comma", "S$10, 000"],
    ["a superscript after the figure", "S$10\u2074"],
    ["an en-dash minus", "Budget: \u2013S$10,000"],
    ["a curly-apostrophe negation", "I don\u2019t have S$10,000 any more."],
    ["digits NFKC leaves as they are", "S$\u0661\u0660,\u0660\u0660\u0660"],
    ["a marker then a colon", "Budget SGD: 12,000"],
    ["a currency name before the figure", "Singapore dollars 12,000"],
    ["a bracketed figure", "S$(12,000)"],
    ["SGD$", "SGD$12,000"],
  ])("%s is no usable figure: the budget is asked again", (_name, text) => {
    expect(statedAmounts(text, "SGD")).toEqual([]);
    expect(afterBudget(text)).toEqual({ ok: false, slots: ["budgetCeilingMinor"], reason: "BUDGET_UNCLEAR" });
  });

  it("a figure glued to its own code is read whole, never as its first digits", () => {
    expect(statedAmounts("S$10,000SGD", "SGD")).toEqual(["1000000"]);
    expect(groundIntent(budget("1000"), [user("S$10,000SGD")], SG)).toMatchObject({ ok: false, reason: "BUDGET_NOT_STATED" });
  });

  it("full-width digits and markers are read as the founder wrote them", () => {
    const turns = [user("I have S$5,000."), user("Now it is \uff33\uff04\uff11\uff10\uff0c\uff10\uff10\uff10.")];
    expect(statedAmounts(turns[1]?.text ?? "", "SGD")).toEqual(["1000000"]);
    expect(groundIntent(budget("500000"), turns, SG)).toMatchObject({ ok: false, reason: "BUDGET_NOT_STATED" });
    expect(groundIntent(MEI_PLAN_INTENT, turns, SG)).toMatchObject({ ok: true, budgetSource: "user-turn:1" });
  });

  it("a dollar sign is no ringgit", () => {
    expect(statedAmounts("$10,000 MYR", "MYR")).toEqual([]);
    expect(groundIntent({ ...examplePlanIntent }, [user("$10,000 MYR")], MY)).toMatchObject({ ok: false, reason: "BUDGET_UNCLEAR" });
    expect(statedAmounts("$10,000 SGD", "SGD")).toEqual(["1000000"]);
  });
});
