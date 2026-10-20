/**
 * Singapore (SG-DESIGN §3 packages/agent): Mei's questions, S$ / SGD budget grounding and the Reader's SGD and PayNow
 * handling. Synthetic data only: no real person, business, UEN, NRIC, phone or account.
 */
import { describe, expect, it } from "vitest";
import {
  SECONDS_PER_DAY,
  MEI_COMMIT_AT,
  MEI_COMPILE_FACILITY,
  MEI_IDS,
  MEI_PLAN_INTENT,
  MEI_PLATFORM_REGISTRY,
  PlanDraft,
  PlanIntent,
  compilePlan,
  evaluateProposal,
  examplePlanIntent,
  fakeHex32,
  initialPolicyContext,
  meiCompileInput,
  planHash,
  trusted,
} from "@hogee/core";
import { runPlannerTurn, type PlannerTurn } from "../src/planner/planner";
import { readDocument } from "../src/reader/reader";
import { bindInvoiceSpend } from "../src/reader/invoice-binding";
import { currenciesNamed, namesCurrency, normalizeCurrency, payoutTargetKey, prefilterInvoice } from "../src/reader/prefilter";
import { groundIntent, statedAmounts } from "../src/planner/grounding";
import { PLANNER_INSTRUCTIONS } from "../src/planner/instructions";
import { questionsFor, templatedAssumptions } from "../src/planner/questions";
import { FX_PAIRS } from "../src/planner/tools";
import { guarded, mockHandle, mockModel, textResult, toolCallResult } from "./helpers/mock-model";
import { MEI_PLANNER_CONTEXT, TEST_PACK_SG } from "./helpers/mei";

const SG = { countryCode: "SG" as const, currency: "SGD" as const };
const user = (text: string): PlannerTurn => ({ role: "user", text });
const MEI_DEMO = user("Hi, I'm Mei from Tampines. I want to sell custom insulated tumblers on Shopee and I have S$10,000 saved.");

describe("SG planner templates", () => {
  it("offers Singapore first, then Malaysia; Indonesia leaves the choice but stays a valid intent", () => {
    const [q] = questionsFor(["countryCode"], "SG", "d1");
    expect(q?.options).toEqual([
      { value: "SG", label: "Singapore" },
      { value: "MY", label: "Malaysia" },
    ]);
    const id: PlanIntent = PlanIntent.parse({ ...examplePlanIntent, countryCode: "ID", entityType: "pt", assumptions: [{ slot: "countryCode", text: "x" }] });
    expect(templatedAssumptions(id)).toEqual([{ slot: "countryCode", text: "I assumed: Indonesia" }]);
    expect(questionsFor(["entityType"], "ID", "d1")[0]?.options.map((o) => o.value)).toEqual(["perorangan", "pt_perorangan", "cv", "pt"]);
  });

  it("labels the three SG entity types and offers Singapore as a buy-from country", () => {
    const [entity, buyFrom] = questionsFor(["entityType", "buyFrom"], "SG", "d1");
    expect(entity?.options).toEqual([
      { value: "sg_sole_prop", label: "Sole proprietorship" },
      { value: "sg_partnership", label: "Partnership" },
      { value: "pte_ltd", label: "Private limited company (Pte Ltd)" },
    ]);
    expect(buyFrom?.options.map((o) => o.value)).toEqual(["CN", "SG", "MY", "ID"]);
    expect(templatedAssumptions(MEI_PLAN_INTENT)).toEqual([{ slot: "entityType", text: "I assumed: Sole proprietorship" }]);
  });

  it("names Singapore and Malaysia, keeps the E1 leak target, and serves the SGD FX pairs", () => {
    expect(PLANNER_INSTRUCTIONS).toContain("Hogee's planning assistant");
    expect(PLANNER_INSTRUCTIONS).toContain("in Singapore and Malaysia");
    expect(FX_PAIRS).toEqual(expect.arrayContaining(["CNY/SGD", "USD/SGD"]));
  });
});

describe("SG budget grounding: S$ and SGD, never a bare $", () => {
  it.each([
    ["S$10,000", "S$10,000"],
    ["SGD 10k", "SGD 10k"],
    ["10,000 SGD", "10,000 SGD"],
    ["$10,000 SGD", "$10,000 SGD"],
    ["SG$10,000", "SG$10,000"],
    ["S$ 10 thousand", "S$ 10 thousand"],
    ["10,000 Singapore dollars", "10,000 Singapore dollars"],
  ])("%s is SGD 10,000 (1000000 minor)", (_name, text) => {
    expect(statedAmounts(`My budget is ${text}.`, "SGD")).toContain("1000000");
    expect(groundIntent(MEI_PLAN_INTENT, [user(`My budget is ${text}.`)], SG)).toMatchObject({ ok: true, budgetSource: "user-turn:0" });
  });

  it("a bare $10,000 is never SGD: the budget is asked again", () => {
    expect(statedAmounts("My budget is $10,000.", "SGD")).toEqual([]);
    expect(groundIntent(MEI_PLAN_INTENT, [user("My budget is $10,000.")], SG)).toEqual({ ok: false, slots: ["budgetCeilingMinor"], reason: "BUDGET_UNCLEAR" });
    // A later bare-$ turn also replaces an earlier S$ figure (the latest money statement wins).
    expect(groundIntent(MEI_PLAN_INTENT, [user("I have S$10,000."), user("Sorry, it is $10,000 now.")], SG)).toMatchObject({ ok: false, reason: "BUDGET_UNCLEAR" });
  });

  it("US$ is not S$, and two currencies on one amount are no usable figure", () => {
    for (const text of ["US$10,000", "US$10,000 SGD", "RM 10,000 SGD", "S$10,000 USD"]) {
      expect(statedAmounts(text, "SGD"), text).toEqual([]);
      expect(groundIntent(MEI_PLAN_INTENT, [user(text)], SG), text).toMatchObject({ ok: false, reason: "BUDGET_UNCLEAR" });
    }
    expect(statedAmounts("S$10,000 dollars", "SGD")).toEqual(["1000000"]);
  });

  it("negations and minus signs still hold around a $ sign", () => {
    for (const text of ["not $10,000 SGD", "-$10,000 SGD", "not S$10,000", "Budget: -S$10,000"]) {
      expect(statedAmounts(text, "SGD"), text).toEqual([]);
    }
    expect(statedAmounts("Use S$8,000, not S$10,000.", "SGD")).toEqual(["800000"]);
  });

  it("an S$ figure is another currency for a Malaysian facility", () => {
    const MY = { countryCode: "MY" as const, currency: "MYR" as const };
    expect(groundIntent({ ...examplePlanIntent }, [user("I have a RM10,000 micro-loan."), user("It is S$10,000 now.")], MY)).toMatchObject({ ok: false, reason: "BUDGET_UNCLEAR" });
  });
});

describe("SG end to end: Mei's S$ budget compiles instead of looping on BUDGET_UNCLEAR", () => {
  const plannerWith = (results: Parameters<typeof mockModel>[0]) => {
    const t = guarded(mockHandle("planner", mockModel(results)));
    return { model: t.guarded, randomBytes: (n: number) => new Uint8Array(n).fill(9) };
  };

  it("S$10,000 grounds Mei's intent and code compiles an SGD plan", async () => {
    const deps = plannerWith([toolCallResult("getCountryPack", { country: "SG" }), toolCallResult("proposePlanIntent", MEI_PLAN_INTENT)]);
    const out = await runPlannerTurn({ turns: [MEI_DEMO], context: MEI_PLANNER_CONTEXT }, deps);
    if (out.kind !== "plan") throw new Error(`expected a plan, got ${out.kind}`);
    expect(PlanDraft.parse(out.draft)).toEqual(out.draft);
    expect(out.draft.manifest.totalMinor).toBe("1000000");
    expect(out.draft.manifest.displayCurrency).toBe("SGD");
    expect(out.decision.rationale).toMatchObject({ kind: "PLAN_INTENT", grounding: { budgetCeilingMinor: "user-turn:0" } });
  });

  it("a bare $10,000 asks for the budget again", async () => {
    const deps = plannerWith([toolCallResult("proposePlanIntent", MEI_PLAN_INTENT)]);
    const out = await runPlannerTurn({ turns: [user("I'm Mei, I sell tumblers on Shopee and have $10,000.")], context: MEI_PLANNER_CONTEXT }, deps);
    expect(out.kind).toBe("questions");
    expect(out.decision.rationale).toMatchObject({ kind: "QUESTIONS", slots: ["budgetCeilingMinor"], reasonCode: "BUDGET_UNCLEAR" });
  });
});

describe("SG Reader prefilter: SGD totals (S$ or SGD, never a bare $)", () => {
  it("parses S$ and SGD totals into SGD minor units; a bare $ total is not a stated total", () => {
    const p = prefilterInvoice("TOTAL DUE: S$ 1,234.50\nAmount due: SGD 99\nGrand total: $5,000.00");
    expect(p.totals.map((t) => [t.currency, t.amountMinor])).toEqual([
      ["SGD", "123450"],
      ["SGD", "9900"],
    ]);
  });

  it("names SGD only by SGD or S$, as whole words; US$ and a bare $ never name it", () => {
    expect(normalizeCurrency("S$")).toBe("SGD");
    expect(normalizeCurrency("sgd")).toBe("SGD");
    expect(normalizeCurrency("$")).toBeNull();
    expect(namesCurrency("Total S$128.50", "SGD")).toBe(true);
    expect(namesCurrency("128.50 SGD", "SGD")).toBe(true);
    expect(currenciesNamed("Price US$ 40")).toEqual(["USD"]);
    expect(currenciesNamed("Price $ 40")).toEqual([]);
  });
});

describe("SG Reader prefilter: PayNow targets are payout details (SG-DESIGN §4 fail-open 5)", () => {
  const targets = (text: string) => prefilterInvoice(text).accountNumbers;

  it("captures a UEN, an SG mobile and an NRIC/FIN next to a PayNow mention, in canonical form", () => {
    expect(targets("Pay by PayNow UEN: 201912345K")).toEqual(["201912345K"]);
    expect(targets("paynow to uen t09ll0001b please")).toEqual(["T09LL0001B"]);
    expect(targets("Please PayNow to +65 9123 4567 by Friday")).toEqual(["+6591234567"]);
    expect(targets("Pay Now (mobile): (65) 8123-4567")).toEqual(["+6581234567"]);
    expect(targets("PayNow to S1234567D")).toEqual(["S1234567D"]);
    expect(targets("UEN 53312345A (PayNow accepted)")).toEqual(["53312345A"]);
  });

  it("reads the next non-blank line after a PayNow heading", () => {
    expect(targets("Payment via PayNow:\n\n  UEN 201912345K\nThank you")).toEqual(["201912345K"]);
  });

  it("captures a PayNow target after an account label, without a truncated duplicate", () => {
    expect(targets("PayNow account: 201912345K")).toEqual(["201912345K"]);
    expect(targets("Account no. 9123 4567 (PayNow)")).toEqual(["+6591234567"]);
    expect(targets("Account: 201998765X")).toEqual(["201998765X"]);
  });

  it("ignores the issuer's registration UEN and contact phone away from any PayNow mention or account label", () => {
    const text = ["Example Trading Pte Ltd (synthetic), UEN 201912345K", "Tel: +65 9123 4567", "TOTAL DUE: S$ 150.00", "Bank account 0123-456789-0"].join("\n");
    expect(targets(text)).toEqual(["01234567890"]);
  });

  it("compares payout targets however they are written", () => {
    expect(payoutTargetKey("+65 9123 4567")).toBe("+6591234567");
    expect(payoutTargetKey("91234567")).toBe("+6591234567");
    expect(payoutTargetKey("0065-9123-4567")).toBe("+6591234567");
    expect(payoutTargetKey("201912345k")).toBe("201912345K");
    expect(payoutTargetKey("1234-500001")).toBe("1234500001");
    expect(payoutTargetKey("6591234567")).toBe("6591234567");
  });
});

describe("SG invoice with a changed PayNow UEN: flagged and escalated, never paid silently", () => {
  const BOUND_UEN = "201912345K";
  const manifest = compilePlan(meiCompileInput(TEST_PACK_SG)).manifest;
  const ctx = {
    ...initialPolicyContext(manifest, planHash(manifest), MEI_COMPILE_FACILITY, BigInt(MEI_COMMIT_AT) + 4n * BigInt(SECONDS_PER_DAY)),
    payees: MEI_PLATFORM_REGISTRY.map((p) => ({ ...p, paidMinor: "0" })),
  };
  const invoice = (payNowLine: string) =>
    ["TAX INVOICE  No. SPX-SG-0042   Date: 2026-10-20", "From: Example Logistics SG (synthetic test merchant)", "Delivery of 120 parcels", "TOTAL DUE: S$ 150.00", payNowLine].join("\n");
  const modelOut = {
    invoiceNumber: "SPX-SG-0042",
    issuerName: "Example Logistics SG",
    currency: "SGD",
    total: { value: "150.00", unit: "SGD", snippet: "TOTAL DUE: S$ 150.00" },
    lineItems: [],
    addressesAiAgents: false,
    mentionsPaymentChange: false,
  };
  async function bind(payNowLine: string) {
    const text = invoice(payNowLine);
    const { guarded: g } = guarded(mockHandle("reader", mockModel([textResult(JSON.stringify(modelOut))], "claude-haiku-5-5")));
    const reading = await readDocument({ kind: "invoice", docId: "inv-sg-0042", text }, { model: g });
    return bindInvoiceSpend({
      reading,
      invoiceId: "inv-sg-0042",
      invoiceHash: fakeHex32("invoice:sg-0042"),
      lineKey: trusted("LOGISTICS", "db:invoices"),
      payeeId: trusted(MEI_IDS.logisticsPayeeId, "db:payee_bindings"),
      boundAccountNumber: trusted(BOUND_UEN, "db:payee_bindings", "private"),
      plan: { planId: manifest.planId, version: manifest.version },
      displayCurrency: "SGD",
    });
  }

  it("the bound PayNow UEN raises no flag and the SGD total is the bounded, untrusted amount", async () => {
    const { proposal, flags } = await bind("Pay by PayNow to UEN 201912345K");
    if (!proposal) throw new Error("expected a proposal");
    expect(flags).toEqual([]);
    expect(proposal.amountMinor).toMatchObject({ value: "15000", taint: { trust: "untrusted" } });
    expect(evaluateProposal(proposal, ctx).verdict).toBe("AUTO");
  });

  it("a different PayNow UEN, stated without any 'details changed' wording, is PAYEE_DETAILS_CHANGED and goes to the officer", async () => {
    const { proposal, flags } = await bind("Pay by PayNow to UEN 201998765X");
    if (!proposal) throw new Error("expected a proposal");
    expect(flags).toContain("PAYEE_DETAILS_CHANGED");
    expect(proposal.payeeId).toMatchObject({ value: MEI_IDS.logisticsPayeeId, taint: { trust: "trusted" } });
    expect(evaluateProposal(proposal, ctx)).toMatchObject({ verdict: "NEEDS_OFFICER", reasonCode: "FLAGGED_INVOICE" });
  });

  it("a PayNow mobile instead of the bound UEN is a change too", async () => {
    const { flags } = await bind("PayNow: +65 9876 5432");
    expect(flags).toContain("PAYEE_DETAILS_CHANGED");
  });
});
