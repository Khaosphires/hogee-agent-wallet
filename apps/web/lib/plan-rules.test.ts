import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADS_PURPOSE_OWN_SITE,
  CONSTITUTION_CODES,
  LINE_KEYS,
  LINE_PURPOSES,
  MEI_LINES,
  MEI_STAGES,
  RINA_LINES,
  ZERO_HEX32,
  planHash,
  type PlanManifest,
  type PlanRule,
} from "@hogee/core";
import {
  DETAIL_ONLY_RULES,
  PLAIN_SAFETY_RULE,
  approvalStepOf,
  foundOf,
  isSignedDraft,
  packDepth,
  planShown,
  pocketFigures,
  pocketLimit,
  pocketPurpose,
  releaseLine,
  releaseSteps,
  ruleOrigin,
  ruleRow,
  safetyRuleText,
  salesSoFar,
  settledAnswer,
  signStateOf,
  verifiedDepthText,
} from "./plan-rules";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

const source = (verifiedOn?: string): NonNullable<PlanRule["source"]> => ({
  sourceUrl: "https://www.sfa.gov.sg/food-import-export",
  retrievedAt: "2026-10-18T00:00:00Z",
  snippetHash: `0x${"ab".repeat(32)}`,
  evidence: "tier2",
  sourceType: "live",
  ...(verifiedOn ? { verifiedOn } : {}),
});

const sfa: PlanRule = {
  ruleId: "approval.sfa.fee.0",
  text: "Product approval: SFA, fee SGD 0.00 for 1 product.",
  sourceRef: "/productApprovals/drinkware_food_contact/cost",
  source: source(),
};
const acra: PlanRule = {
  ruleId: "registration.acra_business.fee.11500",
  text: "Register: ACRA business name, government fee SGD 115.00; paid by the founder before funding.",
  sourceRef: "/registrations/0/cost",
  source: source("2026-10-18"),
};
const floor: PlanRule = { ruleId: "constitution.reserve-floor", text: "Sales reserve is 5%.", sourceRef: "constitution:RESERVE_BELOW_FLOOR" };

describe("approvalStepOf", () => {
  it("reads agency, fee and category from Mei's SFA rule", () => {
    const step = approvalStepOf([acra, sfa, floor]);
    expect(step).toEqual({ agency: "SFA", feeMinor: 0n, category: "drinkware_food_contact", rule: sfa });
  });

  it("reads a non-zero fee in minor units", () => {
    const hsa: PlanRule = { ...sfa, ruleId: "approval.hsa.fee.1300", sourceRef: "/productApprovals/cosmetics/cost" };
    expect(approvalStepOf([hsa])).toMatchObject({ agency: "HSA", feeMinor: 1300n, category: "cosmetics" });
  });

  it("has no step when the plan needs no approval", () => {
    expect(approvalStepOf([{ ...sfa, ruleId: "approval.none", sourceRef: "/productApprovals/drinkware_food_contact/agency" }])).toBeUndefined();
  });

  it("has no step without an approval rule (the Indonesia preview, the example plan)", () => {
    expect(approvalStepOf([acra, floor])).toBeUndefined();
  });

  it("shows nothing rather than guess when the rules are malformed", () => {
    expect(approvalStepOf([sfa, { ...sfa, ruleId: "approval.hsa.fee.1300" }]), "two approval rules").toBeUndefined();
    expect(approvalStepOf([{ ...sfa, ruleId: "approval.fda.fee.0" }]), "unknown agency").toBeUndefined();
    expect(approvalStepOf([{ ...sfa, sourceRef: "/productApprovals/toys/cost" }]), "unknown category").toBeUndefined();
    expect(approvalStepOf([{ ...sfa, sourceRef: "compiler:approval" }]), "not from the pack").toBeUndefined();
  });
});

describe("packDepth", () => {
  it("counts the country-pack rules and those a person verified", () => {
    expect(packDepth([acra, sfa, floor])).toEqual({ packRules: 2, verified: 1 });
  });

  it("counts a pack rule without a source as unverified", () => {
    const bare: PlanRule = { ruleId: sfa.ruleId, text: sfa.text, sourceRef: sfa.sourceRef };
    expect(packDepth([bare])).toEqual({ packRules: 1, verified: 0 });
  });

  it("is empty for constitution-only rules", () => {
    expect(packDepth([floor])).toEqual({ packRules: 0, verified: 0 });
  });
});

describe("plain words for signed plan text go through a display map, never the source (D19)", () => {
  it("shows a pocket's plain purpose only for the exact compiled text it was written for", () => {
    for (const key of LINE_KEYS) {
      const plain = pocketPurpose({ lineKey: key, purpose: LINE_PURPOSES[key] });
      expect(plain, key).not.toBe(LINE_PURPOSES[key]);
      expect(checkText(plain), plain).toEqual([]);
    }
    expect(pocketPurpose({ lineKey: "ADS", purpose: ADS_PURPOSE_OWN_SITE })).toBe("Online ads for your shop's website, a little each day");
    // The demo plans name the product in the supplier pocket; that exact text has its plain version too.
    for (const line of [...MEI_LINES, ...RINA_LINES]) {
      expect(pocketPurpose(line), line.purpose).not.toBe(line.purpose);
      expect(pocketPurpose(line), line.purpose).not.toMatch(/escrow/);
    }
    // A compiled text the map doesn't know (a changed compiler, another country) shows as compiled: never a stale plain line.
    expect(pocketPurpose({ lineKey: "SUPPLIER", purpose: "Goods from a new compiler text" })).toBe("Goods from a new compiler text");
    expect(pocketPurpose({ lineKey: "PACKAGING", purpose: LINE_PURPOSES.SUPPLIER })).toBe(LINE_PURPOSES.SUPPLIER);
  });

  it("leaves the signed source texts exactly as the compiler writes them", () => {
    expect(LINE_PURPOSES.SUPPLIER).toBe("Goods from the chosen supplier (escrow milestones only)");
    expect(LINE_PURPOSES.CONTINGENCY).toBe("Unplanned costs (owner-approved payees only)");
  });

  it("names every safety rule in plain words, and folds only the passing review-period check", () => {
    for (const code of CONSTITUTION_CODES) {
      expect(safetyRuleText(code), code).toBe(PLAIN_SAFETY_RULE[code]);
      expect(checkText(PLAIN_SAFETY_RULE[code]), code).toEqual([]);
      expect(PLAIN_SAFETY_RULE[code].toLowerCase(), code).not.toMatch(/judging|constitution|escrow|agent key/);
    }
    expect([...DETAIL_ONLY_RULES]).toEqual(["AGENT_EXPIRY_TOO_EARLY"]);
  });
});

const WEEK = "604800";

describe("pocketLimit: one short chip per pocket, and the same limit as a sentence", () => {
  it("reads per-payment and per-week caps", () => {
    expect(pocketLimit({ escrowOnly: false, perTxCapMinor: "37500", windowCapMinor: "75000", windowSeconds: WEEK })).toEqual({
      chip: "≤ 375 BU each · 750 BU a week",
      parts: ["≤ 375 BU each", "750 BU a week"],
      full: "At most 375 BU per payment, 750 BU per week",
    });
  });

  it("says paid in steps for the supplier and a daily pace for ads", () => {
    expect(pocketLimit({ escrowOnly: true, perTxCapMinor: "125000", windowCapMinor: "250000", windowSeconds: WEEK }).chip).toBe("Paid in steps");
    const ads = pocketLimit({ escrowOnly: false, pacing: { period: "day", amountMinor: "7500" }, perTxCapMinor: "30000", windowCapMinor: "60000", windowSeconds: WEEK });
    expect(ads).toEqual({ chip: "≤ 75 BU a day", parts: ["≤ 75 BU a day"], full: "At most 75 BU a day" });
  });

  it("names a window that is not a week by its days instead of assuming one", () => {
    expect(pocketLimit({ escrowOnly: false, perTxCapMinor: "100", windowCapMinor: "200", windowSeconds: "259200" }).chip).toBe("≤ 1 BU each · 2 BU per 3 days");
    expect(pocketLimit({ escrowOnly: false, perTxCapMinor: "100", windowCapMinor: "200", windowSeconds: "90" }).full).toBe("At most 1 BU per payment, 2 BU per 90 seconds");
  });

  it("stays clear of the banned words", () => {
    for (const line of MEI_LINES) {
      const { chip, full } = pocketLimit({ ...line, windowSeconds: WEEK });
      expect(checkText(`${chip} ${full}`)).toEqual([]);
    }
  });
});

describe("releaseLine and releaseSteps: the budget's releases at a glance", () => {
  it("says what comes now and what comes later", () => {
    expect(releaseLine(MEI_STAGES, "1000000", false)).toBe("4,000 BU when you sign · 6,000 BU in 1 later release");
    expect(releaseLine(MEI_STAGES, "1000000", true)).toBe("4,000 BU at signing · 6,000 BU in 1 later release");
    expect(releaseLine([{ releaseMinor: "1000000" }], "1000000", false)).toBe("10,000 BU when you sign");
    expect(releaseLine([{ releaseMinor: "1" }, { releaseMinor: "1" }, { releaseMinor: "1" }], "3", false)).toMatch(/in 2 later releases$/);
    expect(releaseLine([], "0", false)).toBe("");
  });

  it("marks a release released only once the wallet's released total covers it AND the money is in, in order", () => {
    expect(releaseSteps(MEI_STAGES, undefined).map((s) => s.status)).toEqual(["at-signing", "waiting"]);
    expect(releaseSteps(MEI_STAGES, { releasedMinor: "0", fundedMinor: "0" }).map((s) => s.status)).toEqual(["at-signing", "waiting"]);
    expect(releaseSteps(MEI_STAGES, { releasedMinor: "400000", fundedMinor: "1000000" }).map((s) => s.status)).toEqual(["released", "waiting"]);
    expect(releaseSteps(MEI_STAGES, { releasedMinor: "1000000", fundedMinor: "1000000" }).map((s) => s.status)).toEqual(["released", "released"]);
  });

  it("says a signed release waits for the loan officer while the wallet is still empty (never \"Released\" with no money)", () => {
    expect(releaseSteps(MEI_STAGES, { releasedMinor: "400000", fundedMinor: "0" }).map((s) => s.status)).toEqual(["awaiting-funds", "waiting"]);
    expect(releaseSteps(MEI_STAGES, { releasedMinor: "400000", fundedMinor: "200000" }).map((s) => s.status)).toEqual(["awaiting-funds", "waiting"]);
    expect(releaseSteps(MEI_STAGES, { releasedMinor: "1000000", fundedMinor: "400000" }).map((s) => s.status)).toEqual(["released", "awaiting-funds"]);
  });

  it("shows the CFO report's sales toward a sales gate (the Wallet's figure), capped at 100%, and none without it", () => {
    const wallet = { releasedMinor: "400000", fundedMinor: "1000000" };
    const [, second] = releaseSteps(MEI_STAGES, wallet, "124000");
    expect(second?.gate).toMatchObject({ metric: "salesMinor", target: "200000", progressPct: 62, soFarMinor: "124000" });
    expect(releaseSteps(MEI_STAGES, wallet, "900000")[1]?.gate?.progressPct).toBe(100);
    expect(releaseSteps(MEI_STAGES, wallet)[1]?.gate?.progressPct).toBeUndefined();
    expect(releaseSteps(MEI_STAGES, undefined, "124000")[1]?.gate?.progressPct).toBe(62);
    const orders = releaseSteps([{ stageId: "stage-1", releaseMinor: "1", gate: { metric: "orders", target: "5", deadline: "1" } }], { releasedMinor: "0", fundedMinor: "0" }, "5");
    expect(orders[0]?.gate?.progressPct).toBeUndefined();
  });

  it("reads sales from the report's own total (the figure the Wallet shows), undefined until it loads", () => {
    expect(salesSoFar({ sales: { count: 62, revenueMinor: "187200", averageMinor: "3019", daily: [], recent: [], stageGate: null } })).toBe("187200");
    expect(salesSoFar(undefined)).toBeUndefined();
  });
});

describe("pocketFigures: a pocket reads as the Wallet reads it (paid · set aside · left)", () => {
  const supplier = { lineKey: "SUPPLIER" as const, allocated: "500000", spent: "0", available: "280000" };
  const ads = { lineKey: "ADS" as const, allocated: "120000", spent: "60000", available: "60000" };
  it("counts what escrow paid the supplier as paid, and what it still holds as set aside", () => {
    expect(pocketFigures(supplier, { escrowOnly: true, escrowMinor: "220000", supplierPaidMinor: "150000" })).toEqual({
      allocatedMinor: "500000",
      leftMinor: "280000",
      paidMinor: "150000",
      setAsideMinor: "70000",
      usedPct: 44,
    });
  });
  it("says nothing it can't know: paid and set aside are null until the report loads, or when the sources disagree", () => {
    expect(pocketFigures(supplier, { escrowOnly: true, escrowMinor: "220000", supplierPaidMinor: null })).toMatchObject({ leftMinor: "280000", paidMinor: null, setAsideMinor: null });
    expect(pocketFigures(supplier, { escrowOnly: true, escrowMinor: "100000", supplierPaidMinor: "150000" })).toMatchObject({ paidMinor: null, setAsideMinor: null });
  });
  it("reads any other pocket from its own spent, with nothing set aside", () => {
    expect(pocketFigures(ads, { escrowOnly: false, escrowMinor: "220000", supplierPaidMinor: "150000" })).toEqual({
      allocatedMinor: "120000",
      leftMinor: "60000",
      paidMinor: "60000",
      setAsideMinor: "0",
      usedPct: 50,
    });
  });
  it("fills the ring as money goes out (an untouched pocket is an empty ring)", () => {
    expect(pocketFigures({ ...ads, spent: "0", available: "120000" }, { escrowOnly: false, escrowMinor: "0", supplierPaidMinor: "0" }).usedPct).toBe(0);
  });
});

describe("verifiedDepthText: a person's review of the rules, said plainly", () => {
  it("states the fact without reading as a failure", () => {
    expect(verifiedDepthText({ packRules: 9, verified: 0 }, "Singapore")).toBe("From public sources. A person hasn't reviewed these yet (0 of 9 Singapore rules used here).");
    expect(verifiedDepthText({ packRules: 9, verified: 4 }, "Singapore")).toBe("From public sources. A person has reviewed 4 of the 9 Singapore rules used here.");
    expect(verifiedDepthText({ packRules: 9, verified: 9 }, "Singapore")).toBe("From public sources. A person has reviewed all 9 Singapore rules used here.");
    expect(verifiedDepthText({ packRules: 0, verified: 0 }, "Malaysia")).toBe("This plan uses no Malaysia rules from our list.");
  });
  it("passes the wording lint", () => {
    for (const d of [{ packRules: 9, verified: 0 }, { packRules: 9, verified: 4 }, { packRules: 9, verified: 9 }]) expect(checkText(verifiedDepthText(d, "Singapore"))).toEqual([]);
  });
});

const manifest: Pick<PlanManifest, "countryCode" | "displayCurrency" | "reserveBps" | "lines" | "stages"> = {
  countryCode: "SG",
  displayCurrency: "SGD",
  reserveBps: 500,
  lines: [{ lineKey: "ADS", lineId: ZERO_HEX32, purpose: "Ads", amountMinor: "120000", perTxCapMinor: "30000", windowCapMinor: "60000", windowSeconds: WEEK, validUntil: "1", payeeIds: [], escrowOnly: false, pacing: { period: "day", amountMinor: "7500" } }],
  stages: [...MEI_STAGES],
};
const rule = (ruleId: string, sourceRef = "/x", text = "Compiled text."): PlanRule => ({ ruleId, sourceRef, text });

describe("ruleRow: each rule as one short row, from its id and the plan's numbers", () => {
  it("writes Mei's rules as titles and values", () => {
    const rows = [
      rule("registration.acra_business.fee.11500"),
      rule("entity.sg_sole_prop"),
      rule("indirect-tax.not-registered"),
      rule("einvoicing.not-required"),
      rule("duty.mfn"),
      rule("import-tax.rate"),
      rule("approval.sfa.fee.0"),
      rule("reserve.policy"),
      rule("marketplace.shopee.fees"),
      rule("ads.pacing", "compiler:ads-pacing"),
      rule("stage.gate", "compiler:stage-gate"),
      rule("constitution.caps", "constitution:PER_TX_CAP_OVER_25PCT"),
      rule("constitution.payees", "constitution:PLAN_ADDS_PAYEE"),
    ].map((r) => ruleRow(r, manifest));
    expect(rows.map((r) => [r.title, r.value])).toEqual([
      ["Register the business (ACRA)", "SGD 115.00"],
      ["Business type", "Sole proprietor"],
      ["GST registration", "Not needed yet"],
      ["E-invoicing (InvoiceNow)", "Not needed"],
      ["Import duty", "Standard rate"],
      ["Import GST", "On goods, shipping, duty"],
      ["SFA approval", "Free"],
      ["Kept for tax", "5.00% of each sale"],
      ["Shopee fees", "Taken from each sale"],
      ["Ads pace", "75 BU a day"],
      ["Next release", "After 2,000 BU in sales"],
      ["Caps on every pocket", "25% a payment · 50% a week"],
      ["No one new to pay", undefined],
    ]);
    expect(rows.every((r) => r.plain)).toBe(true);
    for (const r of rows) expect(checkText(`${r.title} ${r.value ?? ""}`), r.title).toEqual([]);
  });

  it("names Malaysia's registration and tax by its own names", () => {
    const my = { ...manifest, countryCode: "MY" as const, displayCurrency: "MYR" };
    expect(ruleRow(rule("registration.ssm_sole_prop.fee.6000"), my)).toMatchObject({ title: "Register the business (SSM)", value: "MYR 60.00" });
    expect(ruleRow(rule("indirect-tax.registered"), my)).toMatchObject({ title: "SST registration", value: "Needed" });
    expect(ruleRow(rule("approval.none"), my)).toMatchObject({ title: "Product approval", value: "Not needed" });
    const formE = ruleRow(rule("duty.form_e"), my);
    expect(formE).toMatchObject({ title: "Import duty", value: "Agreement rate (Form E)" });
    expect(checkText(`${formE.title} ${formE.value}`)).toEqual([]);
  });

  it("shows the compiled text for an id it doesn't know or can't read, never a guess", () => {
    const unknown = [
      rule("landed-cost.total", "compiler:landed-cost", "Landed cost 12.30 BU a unit."),
      rule("registration.unknown_code.fee.100", "/r", "Register: something new."),
      rule("entity.override", "/e", "Business type changed."),
      rule("marketplace.etsy.fees", "/m", "etsy fees."),
      rule("constitution.caps", "/not-constitution", "Caps from somewhere else."),
    ];
    for (const r of unknown) expect(ruleRow(r, manifest), r.ruleId).toEqual({ title: r.text, topic: "other", plain: false });
    expect(ruleRow(rule("constitution.new", "constitution:MALFORMED_PLAN", "A new safety rule."), manifest)).toEqual({ title: "A new safety rule.", topic: "safety", plain: false });
    expect(ruleRow(rule("stage.gate", "compiler:stage-gate", "Stage text."), { ...manifest, stages: [MEI_STAGES[0]!] })).toMatchObject({ title: "Stage text.", plain: false });
  });

  it("tells the three origins apart", () => {
    expect(["/indirectTax/rate", "compiler:ads-pacing", "constitution:PLAN_ADDS_PAYEE"].map((sourceRef) => ruleOrigin({ sourceRef }))).toEqual(["country", "code", "safety"]);
  });
});

describe("isSignedDraft: the page offers to sign only a plan that isn't already signed", () => {
  const draft = { manifest: { ...manifest, schemaVersion: 1 } as unknown as PlanManifest };
  const hash = planHash(draft.manifest);
  it("is true only for the same plan hash with a signature on record", () => {
    expect(isSignedDraft(draft, { planHash: hash, txHash: `0x${"12".repeat(32)}` })).toBe(true);
    expect(isSignedDraft(draft, { planHash: hash, txHash: null })).toBe(false);
    expect(isSignedDraft(draft, { planHash: `0x${"ab".repeat(32)}`, txHash: `0x${"12".repeat(32)}` })).toBe(false);
    expect(isSignedDraft(draft, undefined)).toBe(false);
  });
});

describe("signStateOf: draft, signed, preview, still checking, or unknown", () => {
  const draft = { manifest: { ...manifest, schemaVersion: 1 } as unknown as PlanManifest };
  const record = { manifest: draft.manifest, status: "COMMITTED" as const, planHash: planHash(draft.manifest), txHash: `0x${"12".repeat(32)}` };
  const other = { ...record, planHash: `0x${"ab".repeat(32)}` };
  it("waits for the check before it offers anything", () => {
    expect(signStateOf(draft, { isPending: true }, false)).toEqual({ kind: "checking" });
  });
  it("is signed only for the same plan, a draft for a 404 or a different plan", () => {
    expect(signStateOf(draft, { isPending: false, data: record }, false)).toEqual({ kind: "signed", record });
    expect(signStateOf(draft, { isPending: false, error: { status: 404 } }, false)).toEqual({ kind: "draft" });
    expect(signStateOf(draft, { isPending: false, data: other }, false)).toEqual({ kind: "draft", lastSigned: other });
    expect(signStateOf(draft, { isPending: false, data: { ...record, txHash: null } }, false)).toEqual({ kind: "draft" });
  });
  it("never guesses on another failure, and a preview is always a preview", () => {
    expect(signStateOf(draft, { isPending: false, error: { status: 502 } }, false)).toEqual({ kind: "unknown" });
    expect(signStateOf(draft, { isPending: true }, true)).toEqual({ kind: "preview" });
    expect(signStateOf(draft, { isPending: false, data: record }, true)).toEqual({ kind: "preview", lastSigned: record });
  });
});

describe("settledAnswer: a background poll never looks like the first load (no flicker)", () => {
  const notFound = { isPending: false, error: { status: 404 } };
  const refetching = { isPending: true, error: null };
  it("keeps the last 404 through the refetch TanStack resets to pending, so the page stays a draft", () => {
    expect(settledAnswer(notFound, refetching)).toBe(notFound);
    const draft = { manifest: { ...manifest, schemaVersion: 1 } as unknown as PlanManifest };
    expect(signStateOf(draft, settledAnswer(notFound, refetching), false)).toEqual({ kind: "draft" });
  });
  it("is pending only on the very first load, and always takes a new answer as it arrives", () => {
    expect(settledAnswer(undefined, refetching)).toBe(refetching);
    const signed = { isPending: false, data: { txHash: "0x1" } };
    expect(settledAnswer(notFound, signed)).toBe(signed);
    const failed = { isPending: false, error: { status: 502 } };
    expect(settledAnswer(signed, failed)).toBe(failed);
  });
});

describe("planShown: no plan to show until the chat has drafted one", () => {
  it("reads a query as loading, found, a definite 404, or another failure", () => {
    expect(foundOf({ isPending: true })).toBe("loading");
    expect(foundOf({ isPending: false, data: {} })).toBe("found");
    expect(foundOf({ isPending: false, error: { status: 404 } })).toBe("missing");
    expect(foundOf({ isPending: false, error: { status: 403 } })).toBe("failed");
  });
  it("shows the plan once it is signed, whatever the thread says", () => {
    expect(planShown({ current: "found", draft: "found", threadDraft: "missing" })).toBe("plan");
  });
  it("waits for the signature check and the thread before it decides (never a flash of figures)", () => {
    expect(planShown({ current: "loading", draft: "found", threadDraft: "missing" })).toBe("loading");
    expect(planShown({ current: "loading", draft: "found", threadDraft: "loading" })).toBe("loading");
    expect(planShown({ current: "missing", draft: "found", threadDraft: "loading" })).toBe("loading");
  });
  it("shows the chat's draft while the signature check is still running", () => {
    expect(planShown({ current: "loading", draft: "found", threadDraft: "found" })).toBe("plan");
    expect(planShown({ current: "loading", draft: "loading", threadDraft: "found" })).toBe("plan");
  });
  it("shows an empty state before the chat's questions are done (nothing signed, no plan card in the thread)", () => {
    expect(planShown({ current: "missing", draft: "found", threadDraft: "missing" })).toBe("none");
    // The live API answers 404 to a draft before the intake is confirmed.
    expect(planShown({ current: "missing", draft: "missing", threadDraft: "missing" })).toBe("none");
    expect(planShown({ current: "missing", draft: "missing", threadDraft: "found" })).toBe("none");
  });
  it("shows the draft once the thread has a plan card, and never hides a plan on a failed check", () => {
    expect(planShown({ current: "missing", draft: "found", threadDraft: "found" })).toBe("plan");
    expect(planShown({ current: "failed", draft: "found", threadDraft: "missing" })).toBe("plan");
    expect(planShown({ current: "failed", draft: "found", threadDraft: "loading" })).toBe("plan");
  });
});
