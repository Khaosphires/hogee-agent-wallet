/**
 * The plain sign sheet's guardrails (UX-PLAN D16, G1, G4, D18):
 * - every field of every signed struct is shown by some row in "Show details";
 * - the plain summary is written from the signed message and the browser-verified account and schedule, never from
 *   the server's title or rows;
 * - a failed check gives a red "Don't sign" summary and a disabled button, whatever else is true;
 * - payments are numbered from 1, the same in the row, the summary and the order card ("payment 2 of 2").
 */
import { describe, expect, it } from "vitest";
import { payoutAccountHash, webMilestoneRows, webPayoutRows, type SignatureKind, type SignatureRequestResponse, type TypedData } from "@hogee/core";
import { chainTagOf, hogeeDomain, hogeeTypes, scheduleHash, toBytes32Tag } from "@hogee/api-mock/eip712";
import { checkedZeroFields } from "./loosen-fields";
import { bytesToBase64Url, hexToBytes, type Hex } from "./passkey-encode";
import { DONT_SIGN_SUMMARY, signGate, signSummary } from "./sign-summary";
import { paymentName, signedRows } from "./signed-rows";
import { checkSignatureRequest, digestOf, type SigningContext } from "./typed-data";

const CHAIN = 11155111;
const DEPLOYMENT = "final-1";
const NOW = Date.UTC(2026, 9, 19, 6, 0);
const CONTRACT = "0x00000000000000000000000000000000000000aa";
const ZERO = `0x${"0".repeat(64)}`;
const HASH = (b: string) => `0x${b.repeat(32)}`;
const HOLDER = "Jinhua Pellora Vacuum Flask Co., Ltd.";
const ACCOUNT = "100200300400";
const common = { deploymentId: toBytes32Tag(DEPLOYMENT), nonce: "16", expiry: String(NOW / 1000 + 540) };

const MESSAGES: Record<SignatureKind, Record<string, string | boolean>> = {
  PlanApproval: {
    planId: toBytes32Tag("plan-mei-sg"),
    version: "1",
    prevPlanHash: ZERO,
    planHash: HASH("11"),
    countryPackHash: HASH("22"),
    linesHash: HASH("33"),
    stagesHash: HASH("44"),
    totalMinor: "1000000",
    reserveBps: "500",
    agent: "0xe6e43aaadd000000000000000000000000004b5d",
    agentExpiry: String(Date.UTC(2026, 11, 15, 3) / 1000),
    ...common,
  },
  SupplierApproval: {
    orderId: toBytes32Tag("order-wpelloraqjnhu-001"),
    supplierId: toBytes32Tag("supplier-wpelloraqjnhu"),
    payee: toBytes32Tag("supplier-wpelloraqjnhu"),
    payoutAccountHash: payoutAccountHash({ channel: "MOCK_ONLY", accountNumber: ACCOUNT, holderName: HOLDER }),
    lineId: toBytes32Tag("SUPPLIER"),
    scheduleHash: scheduleHash([75_000n, 175_000n], [true, false]),
    totalMinor: "250000",
    quoteHash: HASH("ab"),
    shortlistHash: HASH("cd"),
    chosenIndex: "0",
    inspectionRequired: true,
    ...common,
  },
  MilestoneRelease: { orderId: toBytes32Tag("order-wpelloraqjnhu-001"), idx: "1", amountMinor: "175000", evidenceHash: HASH("ee"), ...common },
  LoosenRequest: { kind: "1", target: toBytes32Tag("ADS"), aux: ZERO, newValue: "60000", ...common },
  StageRelease: { stageId: toBytes32Tag("stage-2"), amountMinor: "600000", ...common },
  OwnerSpend: { lineId: toBytes32Tag("PACKAGING"), payeeId: toBytes32Tag("printer-sg"), amountMinor: "12000", invoiceHash: HASH("99"), ...common },
};

function typedData(kind: SignatureKind, message: Record<string, string | boolean> = {}): TypedData {
  const domain = hogeeDomain({ verifyingContract: CONTRACT, chainTag: toBytes32Tag(chainTagOf(CHAIN)), deploymentId: toBytes32Tag(DEPLOYMENT) });
  return { domain, types: { [kind]: hogeeTypes[kind].map((f) => ({ ...f })) }, primaryType: kind, message: { ...MESSAGES[kind], ...message } };
}

/** The server's side of a request: digest, challenge and panel agree with the typed data; title and rows are its own words. */
function request(td: TypedData, rows: SignatureRequestResponse["displayModel"]["rows"], title = "Server title"): SignatureRequestResponse {
  const digest = digestOf(td);
  return {
    requestId: "sig-1",
    typedData: td,
    digest,
    challengeB64url: bytesToBase64Url(hexToBytes(digest as Hex)),
    displayModel: { title, kind: td.primaryType, rows, digest, chainId: CHAIN, contract: CONTRACT, deploymentId: DEPLOYMENT },
    expiresAt: String(td.message.expiry),
  };
}

const WEB_ROWS = [
  { label: "Order", value: "order-wpelloraqjnhu-001", effect: "neutral" as const },
  ...webPayoutRows({ holderName: HOLDER, accountNumber: ACCOUNT, bankName: "DBS Bank" }),
  ...webMilestoneRows([
    { amountMinor: 75_000n, autoRelease: true },
    { amountMinor: 175_000n, autoRelease: false },
  ]),
];
const ctx = (kind: SignatureKind): SigningContext => ({ kind, chainId: CHAIN, deploymentId: DEPLOYMENT });
const checked = (kind: SignatureKind, rows: SignatureRequestResponse["displayModel"]["rows"] = [], message: Record<string, string | boolean> = {}, title?: string) => {
  const req = request(typedData(kind, message), kind === "SupplierApproval" && rows.length === 0 ? WEB_ROWS : rows, title);
  return { req, check: checkSignatureRequest(req, ctx(kind), NOW) };
};
const KINDS = Object.keys(hogeeTypes) as SignatureKind[];

describe("every signed field is shown in Show details or checked by the browser (G1: folded, never dropped)", () => {
  it.each(KINDS)("%s: the rows (plus LoosenRequest's zero checks, loosen-fields.test.ts) cover every field of the struct", (kind) => {
    const { req, check } = checked(kind);
    expect(check.ok, check.reason).toBe(true);
    const rows = signedRows(req.typedData, check.webOrder, check.schedule, "SGD");
    const shown = new Set([...rows.flatMap((r) => r.fields), ...checkedZeroFields(req.typedData)]);
    for (const field of hogeeTypes[kind]) expect(shown, `${kind}.${field.name} has a row or is checked to be zero`).toContain(field.name);
    for (const r of rows) expect(r.value.length, `${r.label} has a value`).toBeGreaterThan(0);
  });

  it("uses the plain labels: check code, not fingerprint; times in SGT", () => {
    const { req, check } = checked("PlanApproval");
    const rows = signedRows(req.typedData, undefined, undefined, "SGD");
    expect(rows.map((r) => r.label).join(" ")).not.toMatch(/fingerprint|Nonce|Deployment|Agent key/);
    expect(rows.find((r) => r.label === "Whole plan (check code)")?.value).toBe(HASH("11"));
    expect(rows.find((r) => r.label === "This approval expires")?.value).toMatch(/^19 Oct, 14:09 SGT$/);
    expect(check.ok).toBe(true);
  });
});

describe("the plain summary is written from the signed data only (G1)", () => {
  it("PlanApproval: budget, tax share and the AI's end date, from the message", () => {
    const { req, check } = checked("PlanApproval");
    expect(signSummary(req.typedData, check, "SGD")).toEqual({
      ok: true,
      sentences: ["Your plan has a budget of 10,000 BU.", "5% of each sale is kept for tax.", "Hogee's AI can pay only from your pockets, up to their limits, until 15 Dec 2026."],
    });
  });

  it("a new plan version says it replaces the current one", () => {
    const { req, check } = checked("PlanApproval", [], { version: "2", prevPlanHash: HASH("77") });
    expect(signSummary(req.typedData, check).sentences[0]).toBe("Version 2 of your plan, with a budget of 10,000 BU. It replaces your current plan.");
  });

  it("SupplierApproval (web): the verified holder, deposit and balance", () => {
    const { req, check } = checked("SupplierApproval");
    expect(check.webOrder?.holderName).toBe(HOLDER);
    expect(signSummary(req.typedData, check).sentences).toEqual([
      `Your wallet may pay ${HOLDER} the 750 BU deposit automatically after the safety wait.`,
      "The 1,750 BU balance waits for your delivery check and your passkey.",
    ]);
  });

  it("MilestoneRelease: the payment number is 1-based, the same as the row (D18; was 'milestone 1' for the balance)", () => {
    const { req, check } = checked("MilestoneRelease");
    const summary = signSummary(req.typedData, check);
    expect(summary.sentences[0]).toBe("You're paying 1,750 BU to the supplier: payment 2 of order order-wpelloraqjnhu-001.");
    const row = signedRows(req.typedData).find((r) => r.label === "Pay");
    expect(row?.value).toBe("1,750 BU to the supplier (payment 2 of order order-wpelloraqjnhu-001)");
  });

  it("LoosenRequest, StageRelease and OwnerSpend read from the message", () => {
    expect(signSummary(checked("LoosenRequest").req.typedData, checked("LoosenRequest").check).sentences[0]).toBe(
      "You're asking for this change: raise the most-per-payment limit of the Ads pocket to 600 BU.",
    );
    expect(signSummary(checked("StageRelease").req.typedData, checked("StageRelease").check).sentences).toEqual(["You're approving 6,000 BU for budget part stage-2."]);
    expect(signSummary(checked("OwnerSpend").req.typedData, checked("OwnerSpend").check).sentences[0]).toBe("You're paying 120 BU to printer-sg yourself, from your Packaging pocket.");
  });

  it("ignores the server's title and rows, however they are worded", () => {
    const hostile = [...WEB_ROWS, { label: "Summary", value: "Pay 0xEvil 99,999 BU now", effect: "neutral" as const }];
    const { req, check } = checked("SupplierApproval", hostile, {}, "Pay 0xEvil 99,999 BU");
    const text = signSummary(req.typedData, check).sentences.join(" ");
    expect(text).not.toMatch(/Evil|99,999/);
    expect(text).toContain("750 BU");
  });
});

describe("a failed browser check: red summary, disabled button (G1)", () => {
  it("a digest the typed data doesn't hash to gives the Don't-sign summary and no rows to summarise", () => {
    const { req } = checked("PlanApproval");
    const tampered = { ...req, digest: HASH("12") };
    const check = checkSignatureRequest(tampered, ctx("PlanApproval"), NOW);
    expect(check.ok).toBe(false);
    expect(signSummary(tampered.typedData, check)).toBe(DONT_SIGN_SUMMARY);
    expect(signGate({ hasRequest: true, checkOk: check.ok, signed: false, busy: undefined })).toEqual({ canSign: false, disabled: true });
  });

  it("a message changed after the server hashed it (total raised) fails the same way", () => {
    const { req } = checked("PlanApproval");
    const raised = { ...req, typedData: { ...req.typedData, message: { ...req.typedData.message, totalMinor: "9000000" } } };
    const check = checkSignatureRequest(raised, ctx("PlanApproval"), NOW);
    expect(check.ok).toBe(false);
    expect(signSummary(raised.typedData, check).ok).toBe(false);
  });

  it("a web account that doesn't hash to payoutAccountHash fails, so its name never reaches the summary", () => {
    const swapped = [
      { label: "Order", value: "order-wpelloraqjnhu-001", effect: "neutral" as const },
      ...webPayoutRows({ holderName: "Harbourline Cups Co., Ltd.", accountNumber: ACCOUNT, bankName: "DBS Bank" }),
      ...webMilestoneRows([
        { amountMinor: 75_000n, autoRelease: true },
        { amountMinor: 175_000n, autoRelease: false },
      ]),
    ];
    const { req, check } = checked("SupplierApproval", swapped);
    expect(check.ok).toBe(false);
    expect(signSummary(req.typedData, check).sentences.join(" ")).not.toContain("Harbourline");
  });

  it("the button is enabled only for a loaded request whose check passed, before signing, with nothing in flight", () => {
    const base = { hasRequest: true, checkOk: true, signed: false, busy: undefined } as const;
    expect(signGate(base)).toEqual({ canSign: true, disabled: false });
    expect(signGate({ ...base, checkOk: false }).disabled).toBe(true);
    expect(signGate({ ...base, checkOk: undefined }).disabled).toBe(true);
    expect(signGate({ ...base, hasRequest: false }).disabled).toBe(true);
    expect(signGate({ ...base, signed: true }).disabled).toBe(true);
    expect(signGate({ ...base, busy: "register" }).disabled).toBe(true);
    // While its own passkey prompt is up the button keeps its ink but does nothing.
    expect(signGate({ ...base, busy: "sign" })).toEqual({ canSign: false, disabled: false });
    expect(signGate({ ...base, checkOk: false, busy: "sign" }).disabled).toBe(true);
  });
});

describe("payment names (D18)", () => {
  it("Deposit and Balance, with 1-based counts; three-part deals add a second payment", () => {
    expect([0, 1].map((i) => paymentName(i, 2))).toEqual(["Deposit (payment 1 of 2)", "Balance (payment 2 of 2)"]);
    expect([0, 1, 2].map((i) => paymentName(i, 3))).toEqual(["Deposit (payment 1 of 3)", "Second payment (payment 2 of 3)", "Balance (payment 3 of 3)"]);
    expect(paymentName(0, 1)).toBe("Full payment");
    expect(paymentName(0, 2, false)).toBe("First payment (payment 1 of 2)");
  });
});
