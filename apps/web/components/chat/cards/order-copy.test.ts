import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { OrderTermsInput, type ChatAction, type OrderTerms } from "@hogee/core";
import {
  ACTION_LABEL,
  ORDER_TEXT,
  PAY_BUTTON,
  PAY_DIALOG_TITLE,
  PAY_SIGNED_TEXT,
  PAY_TEXT,
  PHASE_PILL,
  TERMS_TEXT,
  TRANSIT_TEXT,
  UPLOAD_TEXT,
  UPLOAD_TEXT_EARLY,
  blockedSplitText,
  conditionText,
  confirmingText,
  orderSheetTitle,
  orderSteps,
  payerText,
  receiptText,
  rowStatusText,
  saveAndSign,
  scheduleRowName,
  termsBody,
  type TermsForm,
} from "./order-copy";
import { ENQUIRY_TEXT, enquiryTip } from "./enquiry-copy";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

const SELLER = "Jinhua Pellora Vacuum Flask Co., Ltd.";
const form: TermsForm = {
  supplierId: "supplier-wabcdefghijkl",
  searchId: "search-1",
  quantity: 600,
  totalMinor: 250000n,
  milestones: [
    { bps: 3000, trigger: "ON_ORDER" },
    { bps: 7000, trigger: "ON_DELIVERY_INSPECTED" },
  ],
  holder: `  ${SELLER} `,
  bank: " DBS Bank ",
  account: "100200300400",
  payeeType: "company",
};
const confirmed = (over: Partial<OrderTerms> = {}): OrderTerms =>
  ({ termsId: "terms-01abc", status: "CONFIRMED", supplierId: form.supplierId, orderId: null, ...over }) as OrderTerms;

describe("Save and sign is still two server steps (G2)", () => {
  it("saves first, then tells the chat and opens the order's sheet for exactly those terms", async () => {
    const calls: string[] = [];
    const act = vi.fn((a: ChatAction) => void calls.push(`act:${a.type}`));
    const openSheet = vi.fn((r: { refId: string }) => void calls.push(`open:${r.refId}`));
    const save = vi.fn(async () => {
      calls.push("save");
      return confirmed();
    });
    await saveAndSign(termsBody(form), orderSheetTitle(SELLER), { save, act, openSheet, newActionId: () => "0192f0c0-0000-7000-8000-000000000001" });
    expect(calls).toEqual(["save", "act:terms_saved", "open:terms-01abc"]);
    expect(act).toHaveBeenCalledWith({ type: "terms_saved", actionId: "0192f0c0-0000-7000-8000-000000000001", termsId: "terms-01abc" }, ACTION_LABEL.termsSaved);
    expect(openSheet).toHaveBeenCalledWith({ kind: "SupplierApproval", refId: "terms-01abc", title: `Sign your order with ${SELLER}` });
  });

  it("a refused save opens no sheet and tells the chat nothing", async () => {
    const act = vi.fn();
    const openSheet = vi.fn();
    const save = vi.fn(async () => {
      throw new Error("TERMS_OVER_POCKET");
    });
    await expect(saveAndSign(termsBody(form), "t", { save, act, openSheet, newActionId: () => "x" })).rejects.toThrow("TERMS_OVER_POCKET");
    expect(act).not.toHaveBeenCalled();
    expect(openSheet).not.toHaveBeenCalled();
  });

  it("terms the server didn't confirm open no sheet either", async () => {
    const act = vi.fn();
    const openSheet = vi.fn();
    for (const status of ["SUPERSEDED", "USED"] as const) {
      await expect(saveAndSign(termsBody(form), "t", { save: async () => confirmed({ status }), act, openSheet, newActionId: () => "x" })).rejects.toThrow();
    }
    expect(act).not.toHaveBeenCalled();
    expect(openSheet).not.toHaveBeenCalled();
  });
});

describe("the payout account comes only from the form (G12)", () => {
  it("sends exactly what the founder typed (trimmed), in the API's input shape", () => {
    const body = termsBody(form);
    expect(OrderTermsInput.safeParse(body).success).toBe(true);
    expect(body.payout).toEqual({ holderName: SELLER, bankName: "DBS Bank", accountNumber: "100200300400", payeeType: "company" });
    expect(body.totalMinor).toBe("250000");
  });

  it("copies no other field into the body (a stray prefill or chat field never reaches it)", () => {
    const polluted = { ...form, accountFromChat: "999999999", payout: { accountNumber: "111111111" } } as unknown as TermsForm;
    const body = termsBody(polluted);
    expect(Object.keys(body).sort()).toEqual(["milestones", "payout", "quantity", "searchId", "supplierId", "totalMinor"]);
    expect(body.payout.accountNumber).toBe("100200300400");
    expect(JSON.stringify(body)).not.toContain("999999999");
    expect(JSON.stringify(body)).not.toContain("111111111");
  });
});

describe("labels the cards send to the chat never carry a seller name (G3)", () => {
  it("are fixed sentences", () => {
    const labels = [ACTION_LABEL.termsSaved, ACTION_LABEL.pickOne, ACTION_LABEL.pickMany(3), ACTION_LABEL.showCandidates, ACTION_LABEL.catalog, ACTION_LABEL.retrySearch];
    for (const l of labels) {
      expect(l).not.toContain(SELLER);
      expect(l).not.toMatch(/Co\.|Ltd|BU|\d{6,}/);
    }
  });
});

describe("Deposit / Balance naming, 1-based (D18)", () => {
  const rows = [{ autoRelease: true }, { autoRelease: false }];
  it("names the rows and their state", () => {
    expect(scheduleRowName(0, rows)).toBe("Deposit (payment 1 of 2)");
    expect(scheduleRowName(1, rows)).toBe("Balance (payment 2 of 2)");
    expect(scheduleRowName(0, [{ autoRelease: false }])).toBe("Full payment");
    expect(rowStatusText({ autoRelease: true, released: true })).toBe("Paid automatically");
    expect(rowStatusText({ autoRelease: false, released: true })).toBe("Paid with your passkey");
    expect(rowStatusText({ autoRelease: false, released: false })).toBe("Waiting for you");
    expect(rowStatusText({ autoRelease: true, released: false })).toBe("Not paid yet");
  });

  it("keeps the security meaning of each row: the deposit only after the wait, the balance only with the founder's check and passkey", () => {
    expect(conditionText(true)).toBe("after the safety wait");
    expect(conditionText(false)).toBe("after you upload a delivery check and sign");
    expect(confirmingText("X", "750 BU", "1,750 BU")).toBe("Your wallet may pay X 750 BU automatically after the safety wait, and 1,750 BU only when you approve it. Nothing is paid until you sign.");
  });

  it("walks the steps Signed, Safety wait, Deposit paid, You pay the balance", () => {
    const labels = orderSteps("cooling", rows).map((s) => s.label);
    expect(labels).toEqual(["Signed", "Safety wait", "Deposit paid", "You pay the balance"]);
    expect(orderSteps("cooling", rows).map((s) => s.state)).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(orderSteps("done", rows).every((s) => s.state === "done")).toBe(true);
    expect(orderSteps("waiting", [{ autoRelease: false }]).map((s) => s.label)).toEqual(["Signed", "Safety wait", "You pay"]);
  });
});

describe("every string passes the wording lint", () => {
  it("has no banned or avoided words", () => {
    const texts = [
      ...Object.values(ORDER_TEXT),
      ...Object.values(TERMS_TEXT),
      ...Object.values(PHASE_PILL).map((p) => p?.text ?? ""),
      TRANSIT_TEXT,
      UPLOAD_TEXT,
      UPLOAD_TEXT_EARLY,
      PAY_SIGNED_TEXT,
      PAY_TEXT("1,750 BU", true),
      PAY_TEXT("1,000 BU", false),
      PAY_BUTTON(true),
      PAY_DIALOG_TITLE(true),
      PAY_DIALOG_TITLE(false),
      receiptText("Holder Co.", "Deposit"),
      receiptText("Holder Co.", null),
      blockedSplitText("50/50", "The deposit is above your supplier pocket's per-payment limit."),
      payerText(true),
      payerText(false),
      ENQUIRY_TEXT.title,
      ENQUIRY_TEXT.paste,
      ENQUIRY_TEXT.never,
      enquiryTip([2]),
      enquiryTip([null]),
    ];
    for (const t of texts) expect(checkText(t), t).toEqual([]);
    // Never "the agent" to Mei, never "release" as jargon on the pay step.
    for (const t of texts) expect(t.toLowerCase(), t).not.toMatch(/the agent|escrow|fingerprint|on-chain/);
  });

  it("says Hogee never sends messages, and the tip uses the founder's own pick", () => {
    expect(ENQUIRY_TEXT.never).toBe("Hogee never sends messages for you.");
    expect(enquiryTip([3, 1])).toContain('"I went with #3, 30% deposit');
    expect(enquiryTip([])).not.toContain("#");
  });
});
