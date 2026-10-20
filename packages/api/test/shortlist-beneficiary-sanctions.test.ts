/**
 * Audit run-8 (shortlist.ts candidateOf, sanctions-screens-displayName-not-payout-holder): the SANCTIONS gate screens
 * every name that identifies the beneficiary, not only the display name. SupplierApproval shows the founder the payout
 * account holder (payoutAccountPreimage's holderName), binds it in payoutAccountHash, and settlement pays it, so a clean
 * display name over a listed holder must be gated. A hit on any name gates the supplier; the shortlist says only which
 * gate, never the name that matched.
 */
import { describe, expect, it } from "vitest";
import { exampleShortlistSpec, payoutAccountPreimage } from "@hogee/core";
import type { ChecksPort, SupplierFixture } from "../src/context";
import { liveChecks } from "../src/runtime/ports";
import { CHECK_DOWN_REASON, beneficiaryNames, rankFixtures, scorerCandidates } from "../src/services/shortlist";
import { TEST_SUPPLIERS, testCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";
import { UN_SC } from "./support/supplier-data";

/** A name copied verbatim from the UN SC list (data/suppliers/un-sc-entities.json), as the demo's test row uses. */
const LISTED = UN_SC.entities[0]?.name as string;
const [A, ...REST] = TEST_SUPPLIERS as [SupplierFixture, ...SupplierFixture[]];

const withHolder = (f: SupplierFixture, holderName: string): SupplierFixture => ({ ...f, supplier: { ...f.supplier, xenditTest: { ...f.supplier.xenditTest, holderName } } });

/** The real offline UN SC screen (@hogee/checks through liveChecks); FX and registry are the test fakes. */
const realScreen: ChecksPort = { ...testChecks, screenSanctions: liveChecks.screenSanctions };

function fake(checks: ChecksPort = realScreen) {
  return fakeDeps({ deps: { catalog: testCatalog, checks } });
}

/** A screen that hits on exactly the names given and records every name it is asked about. */
function screenOf(listed: readonly string[]): { checks: ChecksPort; asked: string[] } {
  const asked: string[] = [];
  return { asked, checks: { ...testChecks, screenSanctions: async (name) => (asked.push(name), { hit: listed.includes(name) }) } };
}

describe("the SANCTIONS gate screens the payout beneficiary (audit run-8)", () => {
  it("a clean display name over a listed payout holder is excluded by SANCTIONS (real UN SC screen)", async () => {
    expect(LISTED).toMatch(/TRADING CORPORATION$/);
    const clean = await rankFixtures(fake().deps, "sl-holder-clean", TEST_SUPPLIERS, exampleShortlistSpec, "MYR");
    expect(clean.shortlist?.candidates.map((c) => c.supplierId)).toContain(A.supplier.supplierId);

    const out = await rankFixtures(fake().deps, "sl-holder-listed", [withHolder(A, LISTED), ...REST], exampleShortlistSpec, "MYR");
    expect(out.shortlist?.status).toBe("READY");
    expect(out.shortlist?.candidates.map((c) => c.supplierId)).not.toContain(A.supplier.supplierId);
    expect(out.shortlist?.excluded).toContainEqual({ supplierId: A.supplier.supplierId, gate: "SANCTIONS" });
  });

  it("screens the display name and the exact holder name the founder signs for; a repeated name once", async () => {
    const { checks, asked } = screenOf([]);
    await scorerCandidates(fake(checks).deps, [A], exampleShortlistSpec, "MYR");
    expect([...asked].sort()).toEqual([A.supplier.displayName, payoutAccountPreimage(A.supplier.xenditTest).holderName].sort());
    expect(beneficiaryNames(A.supplier)).toEqual([A.supplier.displayName, A.supplier.xenditTest.holderName]);

    const same = withHolder(A, A.supplier.displayName);
    expect(beneficiaryNames(same.supplier)).toEqual([A.supplier.displayName]);
  });

  it("a hit on any one name gates the supplier; no hit on any name passes it", async () => {
    const hitOn = async (listed: readonly string[]) => (await scorerCandidates(fake(screenOf(listed).checks).deps, [A], exampleShortlistSpec, "MYR"))[0]?.sanctionsHit;
    expect(await hitOn([A.supplier.xenditTest.holderName])).toBe(true);
    expect(await hitOn([A.supplier.displayName])).toBe(true);
    expect(await hitOn([A.supplier.displayName, A.supplier.xenditTest.holderName])).toBe(true);
    expect(await hitOn([])).toBe(false);
  });

  it("the shortlist and the logs name the gate only, never the listed name that matched", async () => {
    const f = fake();
    const out = await rankFixtures(f.deps, "sl-holder-echo", [withHolder(A, LISTED), ...REST], exampleShortlistSpec, "MYR");
    expect(out.shortlist?.excluded).toContainEqual({ supplierId: A.supplier.supplierId, gate: "SANCTIONS" });
    expect(JSON.stringify(out)).not.toContain(LISTED);
    expect(JSON.stringify(f.logs)).not.toContain(LISTED);
  });

  it("a holder name the screen cannot check fails the whole shortlist closed (nothing ranked)", async () => {
    const out = await rankFixtures(fake().deps, "sl-holder-unscreenable", [withHolder(A, "---"), ...REST], exampleShortlistSpec, "MYR");
    expect(out).toEqual({ error: CHECK_DOWN_REASON });
  });
});
