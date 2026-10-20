/**
 * Singapore shortlist (SG-DESIGN §3 packages/api): CN goods into SG route MFN, and the SG pack holds the MFN rate per
 * product category (imports.mfnDutyRateBps.<category>), so the shortlist must pass the spec's category to
 * landedCostFromPack. Without it every SG quote fails with MFN_RATE_REQUIRED and nothing ranks. A category the pack
 * has no rate for still fails closed: it is never priced at 0 duty. The second block ranks the real demo catalog for
 * Mei with the SG fixture pack: supplier-a first, the sanctions-screening row blocked, import GST in every landed cost.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exampleShortlistSpec, type Shortlist, type ShortlistSpec } from "@hogee/core";
import type { ApiDeps, ChecksPort } from "../src/context";
import { fileCatalog, findDataDir } from "../src/runtime/catalog";
import { liveChecks } from "../src/runtime/ports";
import { CHECK_DOWN_REASON, forSpec, rankFixtures, scorerCandidates } from "../src/services/shortlist";
import { FX_SGD, TEST_PACK_SG, TEST_SUPPLIERS_SG, sgTestCatalog, testChecks } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

const REPO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** An SG facility (Mei's): its env names SG/SGD, so the shortlist prices against the SG pack. */
function sgDeps(deps: Partial<ApiDeps> = {}): ApiDeps {
  const base = fakeDeps({ deps: { catalog: sgTestCatalog, checks: testChecks, ...deps } }).deps;
  return { ...base, config: { ...base.config, facilityId: "fac-mei", founderId: "founder-mei", countryCode: "SG", currency: "SGD" } };
}

const SPEC: ShortlistSpec = { ...exampleShortlistSpec, quantity: 1000, budgetMinor: "500000" };

describe("SG shortlist landed cost (product category to the pack's MFN rate)", () => {
  it("ranks CN quotes for an SG facility: MFN at the pack's 0 rate, 9% import GST on CIF + duty", async () => {
    const out = await rankFixtures(sgDeps(), "sl-sg-1", TEST_SUPPLIERS_SG, SPEC, "SGD");
    expect(out.error).toBeUndefined();
    expect(out.shortlist?.status).toBe("READY");
    const a = out.shortlist?.candidates.find((c) => c.supplierId === "supplier-a");
    expect(a?.landedCost.fx).toEqual(FX_SGD["CNY/SGD"]);
    expect(a?.landedCost.dutyMinor).toBe("0");
    const cif = BigInt(a?.landedCost.cifMinor ?? "0");
    expect(cif).toBeGreaterThan(0n);
    expect(BigInt(a?.landedCost.sstMinor ?? "0")).toBe((cif * 900n + 5_000n) / 10_000n);
    expect(TEST_PACK_SG.indirectTax?.rate?.value).toBe(900);
  });

  it("fails closed when the pack has no MFN rate for the category (SG `other`): nothing ranked, never 0 duty", async () => {
    const other: ShortlistSpec = { ...SPEC, productCategory: "other" };
    expect(TEST_PACK_SG.imports?.mfnDutyRateBps?.other).toBeUndefined();
    await expect(scorerCandidates(sgDeps(), TEST_SUPPLIERS_SG, other, "SGD")).rejects.toThrow(/imports\.mfnDutyRateBps\.other/);
    expect(await rankFixtures(sgDeps(), "sl-sg-2", TEST_SUPPLIERS_SG, other, "SGD")).toEqual({ error: CHECK_DOWN_REASON });
  });
});

/**
 * Mei's shortlist over the real demo catalog (data/suppliers/demo through the real file loader), ranked by the shipped
 * service with the real offline checks (@hogee/checks UN SC screen and registry validators through liveChecks). Only
 * FX is a fake (CNY/SGD); the pack is the SG fixture (data/country-packs/SG.json is sg-pack's).
 */
describe("SG shortlist of the demo catalog (real loader, real ranking, real offline checks)", () => {
  /** Mei: 1,000 insulated tumblers from China, SUPPLIER line SGD 5,000. */
  const MEI_SPEC: ShortlistSpec = { productCategory: "drinkware_food_contact", buyFrom: "CN", quantity: 1000, budgetMinor: "500000" };
  const realChecks: ChecksPort = { screenSanctions: liveChecks.screenSanctions, validateRegistryId: liveChecks.validateRegistryId, fx: testChecks.fx };

  async function demoShortlist(): Promise<Shortlist> {
    const log = { events: [] as string[], info: () => undefined, warn: (e: string) => void log.events.push(e), error: (e: string) => void log.events.push(e) };
    const demo = await fileCatalog(findDataDir(undefined, join(REPO_DIR, "packages", "api")), log).suppliers();
    expect(log.events).toEqual([]);
    const out = await rankFixtures(sgDeps({ checks: realChecks }), "sl-sg-demo", forSpec(demo, MEI_SPEC), MEI_SPEC, "SGD");
    expect(out.error).toBeUndefined();
    return out.shortlist as Shortlist;
  }

  it("supplier-a ranks first; every planted supplier is excluded by its gate", async () => {
    const s = await demoShortlist();
    expect(s.status).toBe("READY");
    expect(s.shortlistHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.candidates[0]).toMatchObject({ supplierId: "supplier-a", rank: 1 });
    expect(s.candidates.map((c) => c.supplierId)).toEqual(["supplier-a", "supplier-g", "supplier-h", "supplier-b"]);
    expect(s.excluded).toEqual([
      { supplierId: "supplier-c", gate: "AI_INJECTION" },
      { supplierId: "supplier-d", gate: "OFF_PLATFORM_DISCOUNT" },
      { supplierId: "supplier-e", gate: "OVER_MOQ" },
      { supplierId: "supplier-f", gate: "SANCTIONS" },
      { supplierId: "supplier-i", gate: "MISSING_CERT" },
    ]);
  });

  it("the sanctions-screening test row is blocked by the real UN SC screen", async () => {
    const s = await demoShortlist();
    expect(s.excluded.find((e) => e.supplierId === "supplier-f")?.gate).toBe("SANCTIONS");
    expect(s.candidates.map((c) => c.supplierId)).not.toContain("supplier-f");
    expect((await liveChecks.screenSanctions("KOREA MINING DEVELOPMENT TRADING CORPORATION")).hit).toBe(true);
  });

  it("import GST is in every landed cost: MFN duty 0, GST 9% of CIF + duty, in SGD at the CNY/SGD rate", async () => {
    const s = await demoShortlist();
    for (const c of s.candidates) {
      const lc = c.landedCost;
      const [cif, duty, gst, fees] = [lc.cifMinor, lc.dutyMinor, lc.sstMinor, lc.feesMinor].map(BigInt);
      expect(duty, c.supplierId).toBe(0n);
      expect(gst, c.supplierId).toBeGreaterThan(0n);
      expect(gst, c.supplierId).toBe(((cif! + duty!) * 900n + 5_000n) / 10_000n);
      expect(BigInt(lc.totalMinor), c.supplierId).toBe(cif! + duty! + gst! + fees!);
      expect(lc.fx, c.supplierId).toEqual(FX_SGD["CNY/SGD"]);
      expect(BigInt(lc.totalMinor), c.supplierId).toBeLessThanOrEqual(BigInt(MEI_SPEC.budgetMinor));
    }
  });
});
