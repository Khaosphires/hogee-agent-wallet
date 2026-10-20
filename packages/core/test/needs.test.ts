/**
 * buildNeeds (VISION-DECISIONS §8 core-needs) on the real demo drafts: Mei (SG.json) and Rina (MY.json), each compiled
 * with the real compiler from the demo intent. Pins the whole checklist, its determinism, that every sourceRef points at
 * a sourced pack leaf or a rule the draft carries, the §3 limits, and the wording lint on every string.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CountryPack, Id, LINE_KEYS, LineKey, Minor, PlanRule, compilePlan, meiCompileInput, type PlanDraft } from "../src/index";
import { buildNeeds, NEEDS_LINE_SPLIT_REF } from "../src/needs/index";
import type { NeedsChecklist, NeedsGroup } from "../src/needs/types";
import { REPO_ROOT } from "../scripts/lib/paths";
import { RINA_COMPILE_INPUT } from "./fixtures/rina-compile";

const packJson = (cc: string): unknown => JSON.parse(readFileSync(join(REPO_ROOT, "data", "country-packs", `${cc}.json`), "utf8"));
const SG_RAW = packJson("SG");
const MY_RAW = packJson("MY");
const SG = CountryPack.parse(SG_RAW);
const MY = CountryPack.parse(MY_RAW);
const MEI_DRAFT = compilePlan(meiCompileInput(SG));
const RINA_DRAFT = compilePlan({ ...RINA_COMPILE_INPUT, countryPack: MY });
const FLOOR = { reserveFloorBps: 300 };
const MEI = buildNeeds(MEI_DRAFT, SG, FLOOR);
const RINA = buildNeeds(RINA_DRAFT, MY, FLOOR);
const CASES: readonly (readonly [string, NeedsChecklist, PlanDraft, unknown])[] = [
  ["Mei (SG)", MEI, MEI_DRAFT, SG_RAW],
  ["Rina (MY)", RINA, RINA_DRAFT, MY_RAW],
];

const GROUPS: readonly NeedsGroup[] = ["REGISTRATION", "BUDGET_LINE", "SUPPLIER", "ACCOUNT", "TAX_RESERVE"];
const SOURCED_KEYS = ["value", "sourceUrl", "retrievedAt", "snippetHash", "evidence", "sourceType"];

/** RFC 6901 pointer into the raw pack JSON; undefined when any step is missing. */
function resolvePointer(doc: unknown, pointer: string): unknown {
  let at: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** The wording lint's own checker (scripts/lint-wording), as apps/web/lib/reason-labels.test.ts imports it. */
const { checkText } = (await import(join(REPO_ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly { term: string }[] };

describe("buildNeeds: the demo checklists", () => {
  it("Mei (SG): ACRA + the free SFA importer registration, six budget lines, two suppliers to find, Shopee + PayNow, 5% reserve", () => {
    expect(MEI).toMatchInlineSnapshot(`
      {
        "currency": "SGD",
        "draftId": "draft-mei-001",
        "items": [
          {
            "amountMinor": "11500",
            "detail": "A government fee. You pay it yourself, before the loan money arrives. It doesn't come from this budget.",
            "group": "REGISTRATION",
            "itemId": "needs-registration-acra_business",
            "lineKey": null,
            "sourceRef": "/registrations/0/cost",
            "status": "TODO",
            "title": "Register your business (ACRA, Singapore's business registry)",
          },
          {
            "amountMinor": "0",
            "detail": "For drinkware or food-contact items. No fee. Typical time: 1 day.",
            "group": "REGISTRATION",
            "itemId": "needs-registration-approval-sfa",
            "lineKey": null,
            "sourceRef": "/productApprovals/drinkware_food_contact/cost",
            "status": "TODO",
            "title": "Register as an importer of food-contact items (SFA, Singapore's food agency)",
          },
          {
            "amountMinor": "500000",
            "detail": "Your stock, from the supplier you choose. Paid in steps, held until delivery. At most 1,250 BU per payment, and 2,500 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-supplier",
            "lineKey": "SUPPLIER",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Supplier budget",
          },
          {
            "amountMinor": "150000",
            "detail": "Custom printed packaging. At most 375 BU per payment, and 750 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-packaging",
            "lineKey": "PACKAGING",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Packaging budget",
          },
          {
            "amountMinor": "80000",
            "detail": "Shipping your stock to you, and delivery to your buyers. At most 200 BU per payment, and 400 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-logistics",
            "lineKey": "LOGISTICS",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Delivery budget",
          },
          {
            "amountMinor": "120000",
            "detail": "Ads on the marketplace, spread out day by day. At most 300 BU per payment, and 600 BU every 7 days. At most 75 BU a day.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-ads",
            "lineKey": "ADS",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Ads budget",
          },
          {
            "amountMinor": "50000",
            "detail": "The fees the marketplace charges on each sale. At most 125 BU per payment, and 250 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-platform_fees",
            "lineKey": "PLATFORM_FEES",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Marketplace fees budget",
          },
          {
            "amountMinor": "100000",
            "detail": "A safety buffer for surprise costs (only to people you approve). At most 250 BU per payment, and 500 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-contingency",
            "lineKey": "CONTINGENCY",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Safety buffer",
          },
          {
            "amountMinor": null,
            "detail": "Drinkware or food-contact items. Paid in steps from your supplier pocket. The last payment needs your passkey and a delivery check report.",
            "group": "SUPPLIER",
            "itemId": "needs-supplier-supplier",
            "lineKey": "SUPPLIER",
            "sourceRef": "constitution:SUPPLIER_LINE_NOT_ESCROW",
            "status": "TODO",
            "title": "Find a product supplier",
          },
          {
            "amountMinor": null,
            "detail": "Your plan doesn't name anyone to pay yet. When you choose someone, your loan officer must approve them before your Packaging pocket can pay them.",
            "group": "SUPPLIER",
            "itemId": "needs-supplier-packaging",
            "lineKey": "PACKAGING",
            "sourceRef": "constitution:PLAN_ADDS_PAYEE",
            "status": "TODO",
            "title": "Find a packaging printer",
          },
          {
            "amountMinor": null,
            "detail": "Sell on Shopee in Singapore. Fees on each sale: commission fee (sellers outside PXP; waived for a new seller's first 120 days) 14.17%, transaction fee 3.27%.",
            "group": "ACCOUNT",
            "itemId": "needs-account-seller-shopee",
            "lineKey": null,
            "sourceRef": "/marketplaces/0/fees/0/rateBps",
            "status": "TODO",
            "title": "Shopee seller account",
          },
          {
            "amountMinor": null,
            "detail": "People you pay get the money by PayNow (practice payments in this demo). Fee: 0% of each payment. Some conditions apply; see the source.",
            "group": "ACCOUNT",
            "itemId": "needs-account-payout-paynow",
            "lineKey": null,
            "sourceRef": "/paymentRails/0/feeBps",
            "status": "IN_PLAN",
            "title": "PayNow for paying people",
          },
          {
            "amountMinor": null,
            "detail": "Taken from every sale. It's the highest of: your plan (5%), the country's minimum (3%) and your loan's minimum (3%). This money can only go to IRAS, to pay your tax.",
            "group": "TAX_RESERVE",
            "itemId": "needs-tax_reserve-reserve",
            "lineKey": null,
            "sourceRef": "/reserveFloorBps",
            "status": "IN_PLAN",
            "title": "Kept for tax: 5% of each sale",
          },
        ],
        "reserveBps": 500,
        "totalMinor": "1000000",
      }
    `);
  });

  it("Rina (MY): SSM + LHDN, no product approval; the MY pack has no marketplace or rail facts, so those details are null", () => {
    expect(RINA).toMatchInlineSnapshot(`
      {
        "currency": "MYR",
        "draftId": "draft-rina-001",
        "items": [
          {
            "amountMinor": "6000",
            "detail": "A government fee. You pay it yourself, before the loan money arrives. It doesn't come from this budget.",
            "group": "REGISTRATION",
            "itemId": "needs-registration-ssm_sole_prop",
            "lineKey": null,
            "sourceRef": "/registrations/0/cost",
            "status": "TODO",
            "title": "SSM business registration",
          },
          {
            "amountMinor": "0",
            "detail": "No government fee.",
            "group": "REGISTRATION",
            "itemId": "needs-registration-lhdn_tin",
            "lineKey": null,
            "sourceRef": "/registrations/2/cost",
            "status": "TODO",
            "title": "LHDN tax identification number",
          },
          {
            "amountMinor": "500000",
            "detail": "Your stock, from the supplier you choose. Paid in steps, held until delivery. At most 1,250 BU per payment, and 2,500 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-supplier",
            "lineKey": "SUPPLIER",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Supplier budget",
          },
          {
            "amountMinor": "150000",
            "detail": "Custom printed packaging. At most 375 BU per payment, and 750 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-packaging",
            "lineKey": "PACKAGING",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Packaging budget",
          },
          {
            "amountMinor": "80000",
            "detail": "Shipping your stock to you, and delivery to your buyers. At most 200 BU per payment, and 400 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-logistics",
            "lineKey": "LOGISTICS",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Delivery budget",
          },
          {
            "amountMinor": "120000",
            "detail": "Ads on the marketplace, spread out day by day. At most 300 BU per payment, and 600 BU every 7 days. At most 75 BU a day.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-ads",
            "lineKey": "ADS",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Ads budget",
          },
          {
            "amountMinor": "50000",
            "detail": "The fees the marketplace charges on each sale. At most 125 BU per payment, and 250 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-platform_fees",
            "lineKey": "PLATFORM_FEES",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Marketplace fees budget",
          },
          {
            "amountMinor": "100000",
            "detail": "A safety buffer for surprise costs (only to people you approve). At most 250 BU per payment, and 500 BU every 7 days.",
            "group": "BUDGET_LINE",
            "itemId": "needs-budget_line-contingency",
            "lineKey": "CONTINGENCY",
            "sourceRef": "compiler:line-split",
            "status": "IN_PLAN",
            "title": "Safety buffer",
          },
          {
            "amountMinor": null,
            "detail": "Drinkware or food-contact items. Paid in steps from your supplier pocket. The last payment needs your passkey and a delivery check report.",
            "group": "SUPPLIER",
            "itemId": "needs-supplier-supplier",
            "lineKey": "SUPPLIER",
            "sourceRef": "constitution:SUPPLIER_LINE_NOT_ESCROW",
            "status": "TODO",
            "title": "Find a product supplier",
          },
          {
            "amountMinor": null,
            "detail": "Your plan doesn't name anyone to pay yet. When you choose someone, your loan officer must approve them before your Packaging pocket can pay them.",
            "group": "SUPPLIER",
            "itemId": "needs-supplier-packaging",
            "lineKey": "PACKAGING",
            "sourceRef": "constitution:PLAN_ADDS_PAYEE",
            "status": "TODO",
            "title": "Find a packaging printer",
          },
          {
            "amountMinor": null,
            "detail": null,
            "group": "ACCOUNT",
            "itemId": "needs-account-seller-shopee",
            "lineKey": null,
            "sourceRef": null,
            "status": "TODO",
            "title": "Shopee seller account",
          },
          {
            "amountMinor": null,
            "detail": null,
            "group": "ACCOUNT",
            "itemId": "needs-account-payout-duitnow",
            "lineKey": null,
            "sourceRef": null,
            "status": "TODO",
            "title": "DuitNow for paying people",
          },
          {
            "amountMinor": null,
            "detail": "Taken from every sale. It's the highest of: your plan (5%), the country's minimum (3%) and your loan's minimum (3%). This money can only go to LHDN, to pay your tax.",
            "group": "TAX_RESERVE",
            "itemId": "needs-tax_reserve-reserve",
            "lineKey": null,
            "sourceRef": "/reserveFloorBps",
            "status": "IN_PLAN",
            "title": "Kept for tax: 5% of each sale",
          },
        ],
        "reserveBps": 500,
        "totalMinor": "1000000",
      }
    `);
  });
});

describe.each(CASES)("buildNeeds: %s", (_name, needs, draft, raw) => {
  it("is deterministic: the same inputs (and a JSON round trip of them) give the same checklist, byte for byte", () => {
    const pack = CountryPack.parse(JSON.parse(JSON.stringify(raw)));
    const again = buildNeeds(JSON.parse(JSON.stringify(draft)) as PlanDraft, pack, FLOOR);
    expect(JSON.stringify(again)).toBe(JSON.stringify(needs));
    expect(buildNeeds(draft, pack, FLOOR)).toEqual(needs);
  });

  it("copies the draft's id, currency, total and reserve", () => {
    expect([needs.draftId, needs.currency, needs.totalMinor, needs.reserveBps]).toEqual([
      draft.draftId,
      draft.manifest.displayCurrency,
      draft.manifest.totalMinor,
      draft.manifest.reserveBps,
    ]);
  });

  it("every pack sourceRef resolves to a Sourced leaf; every other ref is one the draft's rules carry (or the line split)", () => {
    const draftRefs = new Set(draft.manifest.rules.map((r) => r.sourceRef));
    for (const item of needs.items) {
      if (item.sourceRef === null) continue;
      expect(PlanRule.shape.sourceRef.safeParse(item.sourceRef).success, item.itemId).toBe(true);
      if (item.sourceRef.startsWith("/")) {
        const leaf = resolvePointer(raw, item.sourceRef);
        expect(leaf, `${item.itemId} → ${item.sourceRef}`).toBeTypeOf("object");
        expect(Object.keys(leaf as object).sort(), item.sourceRef).toEqual(expect.arrayContaining(SOURCED_KEYS));
      } else if (item.sourceRef !== NEEDS_LINE_SPLIT_REF) {
        expect(draftRefs, `${item.itemId} → ${item.sourceRef}`).toContain(item.sourceRef);
      }
    }
  });

  it("meets the §3 limits: 1..40 items, unique Id-shaped item ids, titles ≤ 120, details ≤ 300, Minor amounts, line keys", () => {
    expect(needs.items.length).toBeGreaterThanOrEqual(1);
    expect(needs.items.length).toBeLessThanOrEqual(40);
    expect(new Set(needs.items.map((i) => i.itemId)).size).toBe(needs.items.length);
    for (const item of needs.items) {
      expect(Id.safeParse(item.itemId).success, item.itemId).toBe(true);
      expect(item.itemId).toMatch(/^needs-[a-z_]+-[a-z0-9_-]+$/);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.title.length).toBeLessThanOrEqual(120);
      if (item.detail !== null) expect(item.detail.length).toBeLessThanOrEqual(300);
      if (item.amountMinor !== null) expect(Minor.safeParse(item.amountMinor).success).toBe(true);
      if (item.lineKey !== null) expect(LineKey.safeParse(item.lineKey).success).toBe(true);
      expect(["TODO", "IN_PLAN", "DONE"]).toContain(item.status);
    }
  });

  it("orders items by group (NEEDS_GROUPS order) and budget lines in manifest order", () => {
    const groupIdx = needs.items.map((i) => GROUPS.indexOf(i.group));
    expect(groupIdx.every((g) => g >= 0)).toBe(true);
    expect([...groupIdx].sort((a, b) => a - b)).toEqual(groupIdx);
    const lines = needs.items.filter((i) => i.group === "BUDGET_LINE");
    expect(lines.map((i) => i.lineKey)).toEqual(draft.manifest.lines.map((l) => l.lineKey));
    expect(lines.map((i) => i.amountMinor)).toEqual(draft.manifest.lines.map((l) => l.amountMinor));
    expect(lines.every((i) => i.status === "IN_PLAN")).toBe(true);
    const lineOrder = lines.map((i) => LINE_KEYS.indexOf(i.lineKey as LineKey));
    expect([...lineOrder].sort((a, b) => a - b)).toEqual(lineOrder);
  });

  it("budget lines add up to the plan total", () => {
    const sum = needs.items.filter((i) => i.group === "BUDGET_LINE").reduce((s, i) => s + BigInt(i.amountMinor ?? "0"), 0n);
    expect(sum.toString()).toBe(needs.totalMinor);
  });

  it("passes the wording lint (and never says 'confidence') in every title and detail", () => {
    for (const item of needs.items) {
      for (const text of [item.title, item.detail ?? ""]) {
        expect(checkText(text).map((f) => f.term), text).toEqual([]);
        expect(text).not.toMatch(/confidence/i);
      }
    }
  });

  it("states no registration, approval or fee the draft does not carry", () => {
    const ruleIds = draft.manifest.rules.map((r) => r.ruleId);
    for (const item of needs.items.filter((i) => i.group === "REGISTRATION")) {
      const rule = draft.manifest.rules.find((r) => r.sourceRef === item.sourceRef && /^(registration|approval)\./.test(r.ruleId));
      expect(rule, item.itemId).toBeDefined();
      expect(rule?.ruleId.endsWith(`.fee.${item.amountMinor}`), `${item.itemId} vs ${rule?.ruleId}`).toBe(true);
    }
    const registrationRules = ruleIds.filter((r) => /^registration\./.test(r) || (/^approval\./.test(r) && r !== "approval.none"));
    expect(needs.items.filter((i) => i.group === "REGISTRATION")).toHaveLength(registrationRules.length);
  });
});
