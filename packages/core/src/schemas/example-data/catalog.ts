/** Country pack and supplier examples. URLs are clearly fake (example.invalid); sources are mock/tier3. */
import { RINA_COMMIT_AT_ISO, RINA_IDS } from "../../demo/rina";
import type { CountryPack } from "../country-pack";
import type { RankedSupplier, Shortlist, ShortlistSpec, Supplier, SupplierWithEvidence } from "../supplier";
import { fakeHex32 } from "./fake";

const mock = (path: string, label: string) => ({
  sourceUrl: `https://example.invalid/my/${path}`,
  retrievedAt: RINA_COMMIT_AT_ISO,
  snippetHash: fakeHex32(`snippet:${label}`),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
});

/** A 3-leaf MY sample (tier RESEARCHED, so most sections may be omitted). NOT the real MY pack. */
export const exampleCountryPack: CountryPack = {
  countryCode: "MY",
  version: "2026.10.16-example",
  tier: "RESEARCHED",
  currency: "MYR",
  reserveFloorBps: { value: 300, ...mock("reserve-floor", "my:reserve-floor"), verifiedBy: "@example" },
  indirectTax: { rate: { value: 1000, ...mock("sst-rate", "my:sst-rate") } },
  eInvoicing: { threshold: { value: "300000000", ...mock("e-invoicing", "my:einvoicing") } },
};

export const exampleSupplier: Supplier = {
  supplierId: RINA_IDS.supplierAId,
  displayName: "Supplier A (example drinkware factory)",
  country: "CN",
  ids: { uscc: "91330200MA2EXAMPL1" },
  listing: {
    url: "https://example.invalid/listings/supplier-a",
    sourceType: "mock",
    rawTextRef: "data/suppliers/demo/raw/a.txt",
  },
  offer: {
    currency: "CNY",
    fobUnit: { value: "1250", ...mock("listing/supplier-a", "supplier-a:fob") },
    moq: 500,
    leadTimeDays: 21,
    freightPerUnit: "180",
    incoterm: "FOB",
  },
  terms: { escrow: true, offPlatformDiscount: false, payeeType: "company" },
  certificates: [{ type: "LFGB food contact", issuer: "Example Test Lab", ref: "EX-2026-0001", tier: "tier2" }],
  metrics: { rating: 4.8, responseRate: 0.97, yearsOnPlatform: 6 },
  xenditTest: { channel: "MY_DUITNOW", accountNumber: "1234567890", holderName: "Supplier A Co Ltd" },
};

export const exampleSupplierWithEvidence: SupplierWithEvidence = {
  ...exampleSupplier,
  evidence: [
    {
      evidenceId: "ev-a-quality-1",
      supplierId: RINA_IDS.supplierAId,
      criterion: "quality_evidence",
      tier: "tier2",
      sourceType: "mock",
      sourceUrl: "https://example.invalid/listings/supplier-a#certs",
      snippetHash: fakeHex32("snippet:supplier-a:cert"),
      value: "LFGB food contact certificate EX-2026-0001",
      taint: { trust: "untrusted", sensitivity: "public" },
    },
  ],
};

export const exampleRankedSupplier: RankedSupplier = {
  supplierId: RINA_IDS.supplierAId,
  displayName: "Supplier A (example drinkware factory)",
  rank: 1,
  score: 84.5,
  criteria: [
    { criterion: "landed_cost", weight: 25, score: 80, evidenceIds: [] },
    { criterion: "quality_evidence", weight: 20, score: 90, evidenceIds: ["ev-a-quality-1"] },
    { criterion: "trust_verification", weight: 20, score: 85, evidenceIds: [] },
    { criterion: "lead_time", weight: 10, score: 80, evidenceIds: [] },
    { criterion: "compliance", weight: 10, score: 90, evidenceIds: [] },
    { criterion: "terms", weight: 10, score: 85, evidenceIds: [] },
    { criterion: "communication", weight: 5, score: 75, evidenceIds: [] },
  ],
  // Fake here; really keccak256(utf8(JCS(payoutAccountPreimage(exampleSupplier.xenditTest)))).
  payoutAccountHash: fakeHex32("payoutAccount:supplier-a"),
  landedCost: {
    cifMinor: "86000",
    dutyMinor: "0",
    sstMinor: "8600",
    feesMinor: "1500",
    totalMinor: "96100",
    fx: { value: 0.61, ...mock("fx/cny", "bnm:cny") },
  },
  evidenceCoverageBps: 8600,
  gates: [
    { gate: "NO_ESCROW", passed: true, evidenceIds: [] },
    { gate: "PERSONAL_PAYEE", passed: true, evidenceIds: [] },
    { gate: "MISSING_CERT", passed: true, evidenceIds: ["ev-a-quality-1"] },
    { gate: "OFF_PLATFORM_DISCOUNT", passed: true, evidenceIds: [] },
    { gate: "AI_INJECTION", passed: true, evidenceIds: [] },
    { gate: "OVER_MOQ", passed: true, evidenceIds: [] },
    { gate: "SANCTIONS", passed: true, evidenceIds: [] },
  ],
  redFlags: [],
  pros: [{ text: "Food-contact certificate on file", evidenceIds: ["ev-a-quality-1"] }],
  cons: [{ text: "Lead time 21 days, slower than Supplier B", evidenceIds: [] }],
  whyNotNext: "Supplier B is 4% cheaper landed but has no food-contact certificate evidence.",
  whatWouldChange: "A tier-1 certificate for Supplier B would move it to #1.",
};

export const exampleShortlist: Shortlist = {
  requestId: "sl-0001",
  status: "READY",
  candidates: [exampleRankedSupplier],
  excluded: [{ supplierId: "supplier-c", gate: "AI_INJECTION" }],
  rankStabilityPct: 91,
  shortlistHash: fakeHex32("shortlist:sl-0001"),
  weightsVersion: "w1",
  failureReason: null,
};

/** G2: a shortlist that failed closed, with the server's short reason (the only status that carries one). */
export const exampleFailedShortlist: Shortlist = {
  requestId: "sl-0002",
  status: "FAILED",
  candidates: [],
  excluded: [],
  rankStabilityPct: null,
  shortlistHash: null,
  weightsVersion: "w1",
  failureReason: "A supplier check could not run, so nothing was ranked",
};

export const exampleShortlistSpec: ShortlistSpec = {
  productCategory: "drinkware_food_contact",
  buyFrom: "CN",
  quantity: 1000,
  budgetMinor: "500000",
};
