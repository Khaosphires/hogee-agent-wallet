/**
 * Security audit run-8 hardening: PayNow capture evasion (h-agent-pay) and the payout window cost (critic gap 1).
 * Synthetic data only: no real person, business, UEN, NRIC, phone or account.
 */
import { describe, expect, it } from "vitest";
import {
  SECONDS_PER_DAY,
  MEI_COMMIT_AT,
  MEI_COMPILE_FACILITY,
  MEI_IDS,
  MEI_PLATFORM_REGISTRY,
  compilePlan,
  evaluateProposal,
  fakeHex32,
  initialPolicyContext,
  meiCompileInput,
  planHash,
  trusted,
} from "@hogee/core";
import { bindInvoiceSpend } from "../src/reader/invoice-binding";
import { MAX_PAYOUT_WINDOWS, payoutTargetKey, prefilterInvoice } from "../src/reader/prefilter";
import { readDocument } from "../src/reader/reader";
import { READER_MAX_CHARS } from "../src/reader/schemas";
import { guarded, mockHandle, mockModel, textResult } from "./helpers/mock-model";
import { TEST_PACK_SG } from "./helpers/mei";

const targets = (text: string) => prefilterInvoice(text).accountNumbers;

describe("PayNow capture: look-alike, full-width, invisible and separated writing still states a target (run-8 h-agent-pay)", () => {
  it.each([
    ["a zero-width space inside PayNow and the UEN", "Pay by Pay\u200bNow to UEN 2019\u200b98765X"],
    ["a soft hyphen and a word joiner", "PayNow to UEN 20199\u00ad8765\u2060X"],
    ["full-width letters and digits", "Pay by \uff30\uff41\uff59\uff2e\uff4f\uff57 to UEN \uff12\uff10\uff11\uff19\uff19\uff18\uff17\uff16\uff15\uff38"],
    ["dashes inside the UEN", "PayNow UEN: 2019-98765-X"],
    ["spaces and a dot inside the UEN", "PayNow UEN: 2019 9876 5 . X"],
    ["an en dash and a no-break space", "PayNow UEN: 2019\u201398765\u00a0X"],
    ["a Cyrillic check letter", "PayNow UEN: 201998765\u0425"],
    ["Cyrillic letters in PayNow", "\u0420ayN\u043ew UEN: 201998765X"],
    ["two spaces in Pay Now", "Pay  Now: 201998765X"],
    ["the UEN two lines under the PayNow heading", "PayNow\nPayee: Example Logistics SG (synthetic)\nUEN: 201998765X"],
  ])("UEN: %s", (_name, text) => {
    expect(targets(text)).toEqual(["201998765X"]);
  });

  it.each([
    ["dots between the digits", "PayNow: 9.8.7.6.5.4.3.2"],
    ["spaced digits", "PayNow to 9 8 7 6 5 4 3 2 please"],
    ["dashes and a full-width plus", "PayNow \uff0b65-9876-5432"],
    ["Arabic-Indic digits", "PayNow \u0669\u0668\u0667\u0666\u0665\u0664\u0663\u0662"],
  ])("SG mobile: %s", (_name, text) => {
    expect(targets(text)).toEqual(["+6598765432"]);
  });

  it("NRIC/FIN with separators", () => {
    expect(targets("PayNow to S 1234567-D")).toEqual(["S1234567D"]);
  });

  it("does not read a date or a payee's initial as a UEN", () => {
    expect(targets("Please PayNow by 2026-10-18 at 5pm")).toEqual([]);
    expect(targets("PayNow: 9123 4567 - J. Lim")).toEqual(["+6591234567"]);
  });

  it("compares a bound target written with the same tricks as equal", () => {
    expect(payoutTargetKey("\uff12\uff10\uff11\uff19-12345\u200b-\uff2b")).toBe("201912345K");
    expect(payoutTargetKey("(65) 9123 4567")).toBe("+6591234567");
    expect(payoutTargetKey("6591234567")).toBe("6591234567");
  });
});

describe("SG invoice binding with disguised PayNow targets", () => {
  const BOUND_UEN = "201912345K";
  const manifest = compilePlan(meiCompileInput(TEST_PACK_SG)).manifest;
  const ctx = {
    ...initialPolicyContext(manifest, planHash(manifest), MEI_COMPILE_FACILITY, BigInt(MEI_COMMIT_AT) + 4n * BigInt(SECONDS_PER_DAY)),
    payees: MEI_PLATFORM_REGISTRY.map((p) => ({ ...p, paidMinor: "0" })),
  };
  const modelOut = {
    invoiceNumber: "SPX-SG-0042",
    issuerName: "Example Logistics SG",
    currency: "SGD",
    total: { value: "150.00", unit: "SGD", snippet: "TOTAL DUE: S$ 150.00" },
    lineItems: [],
    addressesAiAgents: false,
    mentionsPaymentChange: false,
  };
  async function bind(payNowLines: string) {
    const text = ["TAX INVOICE  No. SPX-SG-0042   Date: 2026-10-20", "From: Example Logistics SG (synthetic test merchant)", "TOTAL DUE: S$ 150.00", payNowLines].join("\n");
    const { guarded: g } = guarded(mockHandle("reader", mockModel([textResult(JSON.stringify(modelOut))], "claude-haiku-5-5")));
    const reading = await readDocument({ kind: "invoice", docId: "inv-sg-0042", text }, { model: g });
    const bound = bindInvoiceSpend({
      reading,
      invoiceId: "inv-sg-0042",
      invoiceHash: fakeHex32("invoice:sg-0042"),
      lineKey: trusted("LOGISTICS", "db:invoices"),
      payeeId: trusted(MEI_IDS.logisticsPayeeId, "db:payee_bindings"),
      boundAccountNumber: trusted(BOUND_UEN, "db:payee_bindings", "private"),
      plan: { planId: manifest.planId, version: manifest.version },
      displayCurrency: "SGD",
    });
    if (!bound.proposal) throw new Error("expected a proposal");
    return { ...bound, proposal: bound.proposal, stated: reading.fields.accountNumbers?.value ?? [], verdict: evaluateProposal(bound.proposal, ctx).verdict };
  }

  it.each([
    ["zero-width characters", "Pay by Pay\u200bNow to UEN 2019\u200b98765X"],
    ["full-width characters", "Pay by \uff30\uff41\uff59\uff2e\uff4f\uff57 to UEN \uff12\uff10\uff11\uff19\uff19\uff18\uff17\uff16\uff15\uff38"],
    ["separators", "Pay by PayNow to UEN 2019-987-65 X"],
    ["a block under the heading", "PayNow\nName: Example Logistics SG\nUEN: 201998765X"],
  ])("a changed UEN written with %s is PAYEE_DETAILS_CHANGED and goes to the officer", async (_name, lines) => {
    const { flags, stated, verdict } = await bind(lines);
    expect(stated).toEqual(["201998765X"]);
    expect(flags).toContain("PAYEE_DETAILS_CHANGED");
    expect(verdict).toBe("NEEDS_OFFICER");
  });

  it.each([
    ["zero-width characters", "Pay by Pay\u200bNow to UEN 2019\u200b12345K"],
    ["full-width characters", "Pay by \uff30\uff41\uff59\uff2e\uff4f\uff57 to UEN \uff12\uff10\uff11\uff19\uff11\uff12\uff13\uff14\uff15\uff2b"],
    ["separators", "Pay by PayNow to UEN 2019-123-45 K"],
  ])("the bound UEN written with %s is recognised and raises no flag (AUTO)", async (_name, lines) => {
    const { flags, stated, verdict } = await bind(lines);
    expect(stated).toEqual([BOUND_UEN]);
    expect(flags).toEqual([]);
    expect(verdict).toBe("AUTO");
  });

  it("more PayNow mentions and account labels than the cap flag the invoice, even when every target read is the bound one", async () => {
    const over = Array.from({ length: MAX_PAYOUT_WINDOWS + 1 }, () => `Account: ${BOUND_UEN}`).join("\n");
    expect(prefilterInvoice(over).payoutScanCapped).toBe(true);
    const { flags, verdict } = await bind(over);
    expect(flags).toContain("PAYEE_DETAILS_CHANGED");
    expect(verdict).toBe("NEEDS_OFFICER");
    const atCap = Array.from({ length: MAX_PAYOUT_WINDOWS }, () => `Account: ${BOUND_UEN}`).join("\n");
    expect(prefilterInvoice(atCap).payoutScanCapped).toBe(false);
    expect((await bind(atCap)).flags).toEqual([]);
  });
});

describe("prefilter cost stays linear on a long hostile invoice (run-8 critic gap 1)", () => {
  // The old code took about 0.5-1.5 s on each of these (window rescans, whitespace backtracking); now a few ms.
  const BUDGET_MS = 200;
  const timed = (text: string) => {
    const t0 = performance.now();
    prefilterInvoice(text);
    return { ms: performance.now() - t0 };
  };

  it.each([
    ["account labels and digits on one line", "a/c 1234567 ".repeat(Math.floor(READER_MAX_CHARS / 12))],
    ["PayNow mentions and digits on one line", "PayNow 1234567 ".repeat(Math.floor(READER_MAX_CHARS / 15))],
    ["PayNow mentions on their own lines", "PayNow\n".repeat(READER_MAX_CHARS / 7)],
    ["an account label before a long blank run", `a/c${" ".repeat(READER_MAX_CHARS - 3)}`],
    ["a total label before a long blank run", `total${" ".repeat(READER_MAX_CHARS - 5)}`],
    ["an invoice number label before a long blank run", `invoice no${" ".repeat(READER_MAX_CHARS - 10)}`],
  ])("%s", (_name, text) => {
    expect(text.length).toBeLessThanOrEqual(READER_MAX_CHARS);
    expect(timed(text).ms).toBeLessThan(BUDGET_MS);
  });

  it("many mentions on one line are one window, merged windows read each target once", () => {
    const line = `${"PayNow ".repeat(MAX_PAYOUT_WINDOWS)}UEN 201998765X`;
    expect(prefilterInvoice(line)).toMatchObject({ accountNumbers: ["201998765X"], payoutScanCapped: false });
    expect(targets("PayNow account: 201998765X\nAccount 201998765X (PayNow)")).toEqual(["201998765X"]);
  });

  it("past the cap, the first windows are still read", () => {
    const text = ["PayNow UEN 201998765X", ..."a/c ".repeat(MAX_PAYOUT_WINDOWS).split(" ")].join("\n");
    expect(prefilterInvoice(text)).toMatchObject({ accountNumbers: ["201998765X"], payoutScanCapped: true });
  });
});
