/**
 * buildNeeds refuses inputs it cannot vouch for (wrong or changed pack, malformed draft or options, a draft whose rules
 * disagree with the pack) and, on valid inputs, takes every item from the draft or the pack: a missing pack fact gives a
 * TODO item with no detail and no sourceRef, never an invented one. Variants are compiled with the real compiler.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CountryPack, MEI_PLAN_INTENT, compilePlan, meiCompileInput, type PlanDraft, type PlanIntent } from "../src/index";
import { buildNeeds, NeedsError } from "../src/needs/index";
import type { NeedsChecklist } from "../src/needs/types";
import { REPO_ROOT } from "../scripts/lib/paths";

const packJson = (cc: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(REPO_ROOT, "data", "country-packs", `${cc}.json`), "utf8")) as Record<string, unknown>;
const SG = CountryPack.parse(packJson("SG"));
const MY = CountryPack.parse(packJson("MY"));
const FLOOR = { reserveFloorBps: 300 };

const compileMei = (patch: Partial<PlanIntent> = {}, pack: CountryPack = SG): PlanDraft =>
  compilePlan({ ...meiCompileInput(pack), intent: { ...MEI_PLAN_INTENT, ...patch } as PlanIntent });
const MEI_DRAFT = compileMei();

const item = (needs: NeedsChecklist, itemId: string) => needs.items.find((i) => i.itemId === itemId);
const ids = (needs: NeedsChecklist) => needs.items.map((i) => i.itemId);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(NeedsError);
    return (e as NeedsError).code;
  }
  throw new Error("expected buildNeeds to throw");
}

describe("buildNeeds fails closed", () => {
  it("refuses another country's pack", () => {
    expect(codeOf(() => buildNeeds(MEI_DRAFT, MY, FLOOR))).toBe("PACK_MISMATCH");
  });

  it("refuses a pack that differs from the one the draft was compiled with (hash check), even by one fee", () => {
    const changed = structuredClone(SG);
    changed.registrations![0]!.cost.value = "11600";
    expect(codeOf(() => buildNeeds(MEI_DRAFT, changed, FLOOR))).toBe("PACK_MISMATCH");
  });

  it("refuses a malformed draft or pack", () => {
    expect(codeOf(() => buildNeeds({ ...MEI_DRAFT, draftId: "" }, SG, FLOOR))).toBe("INVALID_INPUT");
    expect(codeOf(() => buildNeeds({ ...MEI_DRAFT, manifest: { ...MEI_DRAFT.manifest, totalMinor: "-1" } }, SG, FLOOR))).toBe("INVALID_INPUT");
    expect(codeOf(() => buildNeeds(MEI_DRAFT, { ...SG, currency: "sgd" } as CountryPack, FLOOR))).toBe("INVALID_INPUT");
    expect(codeOf(() => buildNeeds(null as unknown as PlanDraft, SG, FLOOR))).toBe("INVALID_INPUT");
  });

  it("refuses a reserve floor that is not an integer 0..10000", () => {
    for (const reserveFloorBps of [-1, 1.5, 10_001, Number.NaN]) {
      expect(codeOf(() => buildNeeds(MEI_DRAFT, SG, { reserveFloorBps })), String(reserveFloorBps)).toBe("INVALID_INPUT");
    }
    expect(codeOf(() => buildNeeds(MEI_DRAFT, SG, {} as { reserveFloorBps: number }))).toBe("INVALID_INPUT");
  });

  it("refuses a draft whose rules do not carry a registration the pack requires", () => {
    const rules = MEI_DRAFT.manifest.rules.filter((r) => !r.ruleId.startsWith("registration."));
    expect(codeOf(() => buildNeeds({ ...MEI_DRAFT, manifest: { ...MEI_DRAFT.manifest, rules } }, SG, FLOOR))).toBe("DRAFT_MISMATCH");
  });

  it("refuses a draft whose rules do not carry the product approval the pack requires", () => {
    const rules = MEI_DRAFT.manifest.rules.filter((r) => !r.ruleId.startsWith("approval."));
    expect(codeOf(() => buildNeeds({ ...MEI_DRAFT, manifest: { ...MEI_DRAFT.manifest, rules } }, SG, FLOOR))).toBe("DRAFT_MISMATCH");
  });
});

describe("buildNeeds takes every item from the draft or the pack", () => {
  it("a pack with no marketplace or rail facts gives TODO account items with no detail and no sourceRef", () => {
    const bare = CountryPack.parse({ ...packJson("SG"), marketplaces: [], paymentRails: [] });
    const needs = buildNeeds(compileMei({}, bare), bare, FLOOR);
    expect(item(needs, "needs-account-seller-shopee")).toMatchObject({ title: "Shopee seller account", detail: null, sourceRef: null, status: "TODO" });
    expect(item(needs, "needs-account-payout-paynow")).toMatchObject({ title: "PayNow for paying people", detail: null, sourceRef: null, status: "TODO" });
  });

  it("marketplace fee names that would pass 300 characters are dropped whole, keeping every rate (never cut mid-text)", () => {
    const raw = packJson("SG");
    const market = (raw.marketplaces as { fees: { name: string }[] }[])[0]!;
    const fee = market.fees[0]!;
    const long = { ...raw, marketplaces: [{ ...market, fees: [1, 2, 3, 4].map((n) => ({ ...fee, name: `fee ${n} ${"x".repeat(74)}` })) }] };
    const pack = CountryPack.parse(long);
    const seller = item(buildNeeds(compileMei({}, pack), pack, FLOOR), "needs-account-seller-shopee");
    expect(seller?.detail).toBe("Sell on Shopee in Singapore. Fees on each sale: 14.17%, 14.17%, 14.17%, 14.17%.");
    expect(seller?.sourceRef).toBe("/marketplaces/0/fees/0/rateBps");
  });

  it("a facility floor above the plan's reserve raises the checklist rate and marks it TODO (the plan must be raised)", () => {
    const needs = buildNeeds(MEI_DRAFT, SG, { reserveFloorBps: 800 });
    expect(needs.reserveBps).toBe(800);
    expect(item(needs, "needs-tax_reserve-reserve")).toMatchObject({ title: "Kept for tax: 8% of each sale", status: "TODO" });
  });

  it("an own-website seller has no platform logistics payee, so logistics is a counterparty to find", () => {
    const needs = buildNeeds(compileMei({ sellChannel: "own_site" }), SG, FLOOR);
    expect(ids(needs).filter((id) => id.startsWith("needs-supplier-"))).toEqual(["needs-supplier-supplier", "needs-supplier-packaging", "needs-supplier-logistics"]);
    expect(item(needs, "needs-supplier-logistics")).toMatchObject({ lineKey: "LOGISTICS", status: "TODO", sourceRef: "constitution:PLAN_ADDS_PAYEE" });
    // The SG pack lists Shopee only: no marketplace fact for an own website, so no detail.
    expect(item(needs, "needs-account-seller-own_site")).toMatchObject({ detail: null, sourceRef: null, status: "TODO" });
  });

  it("a product approval with a fee: the HSA item carries the pack fee and the LICENSING line cites the compiler's licensing rule", () => {
    const needs = buildNeeds(compileMei({ productCategory: "cosmetics" }), SG, FLOOR);
    expect(item(needs, "needs-registration-approval-hsa")).toMatchObject({
      amountMinor: "1300",
      sourceRef: "/productApprovals/cosmetics/cost",
      status: "TODO",
    });
    expect(item(needs, "needs-budget_line-licensing")).toMatchObject({ amountMinor: "1300", sourceRef: "compiler:licensing-line", status: "IN_PLAN" });
  });

  it("a Pte Ltd registers by ACRA incorporation, at the pack's incorporation fee", () => {
    const needs = buildNeeds(compileMei({ entityType: "pte_ltd" }), SG, FLOOR);
    expect(ids(needs).filter((id) => id.startsWith("needs-registration-"))).toEqual(["needs-registration-acra_pte_ltd", "needs-registration-approval-sfa"]);
    expect(item(needs, "needs-registration-acra_pte_ltd")).toMatchObject({ amountMinor: "31500", sourceRef: "/registrations/1/cost" });
  });

  it("never marks anything DONE: a fresh draft has nothing done yet", () => {
    const needs = buildNeeds(MEI_DRAFT, SG, FLOOR);
    expect(needs.items.some((i) => i.status === "DONE")).toBe(false);
  });
});
