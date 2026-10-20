/**
 * A web supplier search as v-search stores it (its row contract, 19 Oct): a `shortlists` row with source 'web',
 * search_json = SupplierSearch, result_json = the scorer's Shortlist and shortlist_hash = its hash, plus a `suppliers`
 * row per candidate whose record_json.displayName is the Reader's seller name and whose xenditTest is the UNSET
 * sentinel (never paid). Built from a READY catalog shortlist of the same world, so the ranked fields are real ones;
 * only the ids, names and listing change. TEST FIXTURE: synthetic, fictional sellers.
 */
import { CandidateCard, Shortlist, SupplierSearch, exampleShortlistSpec, payoutAccountHash, shortlistHashOf, type Supplier } from "@hogee/core";
import { TEST_SUPPLIERS } from "./catalog";
import type { World } from "./world";

export interface WebSeller {
  readonly supplierId: string;
  readonly sellerName: string;
  readonly listingUrl: string;
}

export const CORVANE: WebSeller = {
  supplierId: "supplier-wcorvanetest2",
  sellerName: "Yongkang Corvane Drinkware Co., Ltd.",
  listingUrl: "https://corvane.en.alibaba.com/product/1600000000001.html",
};
/** Excluded by the OFF_PLATFORM_DISCOUNT gate (asks to be paid off the platform). */
export const GLINTORA: WebSeller = {
  supplierId: "supplier-wglintoratest",
  sellerName: "Glintora Houseware Co., Ltd.",
  listingUrl: "https://www.made-in-china.com/glintora/product-2.html",
};

function webSupplier(s: WebSeller): Supplier {
  const base = TEST_SUPPLIERS[0]?.supplier as Supplier;
  return {
    ...base,
    supplierId: s.supplierId,
    displayName: s.sellerName,
    country: "CN",
    ids: {},
    listing: { url: s.listingUrl, sourceType: "mock", rawTextRef: `data/suppliers/search/recorded/${s.supplierId}.txt` },
    terms: { escrow: true, offPlatformDiscount: false, payeeType: "company" },
    certificates: [],
    xenditTest: { channel: "UNSET", accountNumber: "0000", holderName: s.sellerName },
  };
}

export interface PlantedSearch {
  readonly searchId: string;
  readonly shortlistHash: string;
}

/**
 * Stores a READY web search `searchId` whose only candidate is `seller` (rank 1), with GLINTORA gate-excluded.
 * `catalog` is a READY catalog Shortlist of the world (its first candidate lends the scored fields).
 */
export async function plantWebSearch(w: World, catalog: Shortlist, searchId: string, opts: { seller?: WebSeller; ageDays?: number } = {}): Promise<PlantedSearch> {
  const seller = opts.seller ?? CORVANE;
  const ranked = catalog.candidates[0];
  if (!ranked) throw new Error("the catalog shortlist has no candidate");
  const supplier = webSupplier(seller);
  const candidates = [{ ...ranked, supplierId: seller.supplierId, displayName: seller.sellerName, rank: 1, payoutAccountHash: payoutAccountHash(supplier.xenditTest), whyNotNext: null }];
  const excluded = [{ supplierId: GLINTORA.supplierId, gate: "OFF_PLATFORM_DISCOUNT" as const }];
  const base = { requestId: searchId, weightsVersion: catalog.weightsVersion, candidates, excluded };
  const shortlist = Shortlist.parse({ ...base, status: "READY", rankStabilityPct: 100, shortlistHash: shortlistHashOf(base), failureReason: null });
  const host = new URL(seller.listingUrl).hostname;
  // The row keeps the full time (a search is bound to the plan signed before it, run-9); the body has whole seconds.
  const createdAtFull = new Date(Date.now() - (opts.ageDays ?? 0) * 86_400_000).toISOString();
  const createdAt = createdAtFull.replace(/\.\d{3}Z$/, "Z");
  const card = CandidateCard.parse({
    supplierId: seller.supplierId,
    origin: "web",
    displayName: seller.sellerName,
    rank: 1,
    landedCostMinor: ranked.landedCost.totalMinor,
    moq: 300,
    leadTimeDays: 25,
    evidenceCoverageBps: ranked.evidenceCoverageBps,
    failedGates: [],
    redFlagCount: 0,
    listingHost: host,
    listingUrl: seller.listingUrl,
    unverified: true,
    canOrder: true,
    priceFlag: false,
  });
  const search = SupplierSearch.parse({
    searchId,
    status: "READY",
    stage: "DONE",
    provider: "recorded",
    sourcesFound: 2,
    omitted: [],
    excludedByGate: [{ gate: "OFF_PLATFORM_DISCOUNT", count: 1 }],
    failure: null,
    shortlistRequestId: null,
    candidates: [card],
    quantity: 500,
    createdAt,
  });
  const q = w.live.db.$client;
  for (const s of [supplier, webSupplier(GLINTORA)]) {
    await q.query(
      `insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type)
       values ($1, $2, $3, $4, $5::jsonb, 'tier3', 'mock') on conflict (facility_id, supplier_id) do nothing`,
      [w.facilityId, s.supplierId, s.displayName, s.country, JSON.stringify(s)],
    );
  }
  await q.query(
    `insert into shortlists (id, facility_id, status, spec_json, result_json, shortlist_hash, weights_version, source, search_json, created_at)
     values ($1, $2, 'READY', $3::jsonb, $4::jsonb, $5, $6, 'web', $7::jsonb, $8)`,
    [searchId, w.facilityId, JSON.stringify(exampleShortlistSpec), JSON.stringify(shortlist), shortlist.shortlistHash, shortlist.weightsVersion, JSON.stringify(search), createdAtFull],
  );
  return { searchId, shortlistHash: shortlist.shortlistHash as string };
}
