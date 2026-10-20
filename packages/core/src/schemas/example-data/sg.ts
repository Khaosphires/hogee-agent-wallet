/**
 * Singapore (Mei) examples, next to the Rina (MY) ones wherever a schema carries a country, currency or persona
 * (SG-DECISIONS: SG is the main demo country). Same conventions: fake hashes and addresses, example.invalid URLs,
 * mock/tier3 sources. exampleCountryPackSG is a 3-leaf sample, NOT data/country-packs/SG.json.
 */
import { MEI_COMMIT_AT_ISO, MEI_FACILITY, MEI_IDS, MEI_PLAN } from "../../demo/mei";
import type { CountryPack } from "../country-pack";
import type { E2LabelRow, E2PromptRow, E5DocRow } from "../datasets";
import type { Facility, Session } from "../session";
import { fakeAddress, fakeHex32 } from "./fake";

const mock = (path: string, label: string) => ({
  sourceUrl: `https://example.invalid/sg/${path}`,
  retrievedAt: MEI_COMMIT_AT_ISO,
  snippetHash: fakeHex32(`snippet:${label}`),
  evidence: "tier3" as const,
  sourceType: "mock" as const,
});

/** A 3-leaf SG sample (tier RESEARCHED). No eInvoicing section: an SG pack must not carry one (InvoiceNow follows GST). */
export const exampleCountryPackSG: CountryPack = {
  countryCode: "SG",
  version: "2026.10.18-example",
  tier: "RESEARCHED",
  currency: "SGD",
  reserveFloorBps: { value: MEI_FACILITY.reserveFloorBps, ...mock("reserve-floor", "sg:reserve-floor"), verifiedBy: "@example" },
  indirectTax: {
    rate: { value: 900, ...mock("gst-rate", "sg:gst-rate") },
    registrationThreshold: { value: "100000000", ...mock("gst-threshold", "sg:gst-threshold") },
  },
};

export const exampleSessionMei: Session = {
  persona: "founder:mei",
  founderId: MEI_IDS.founderId,
  facilityId: MEI_IDS.facilityId,
  mode: "mock",
  chainId: MEI_IDS.chainId,
  deploymentId: MEI_IDS.deploymentId,
};

export const exampleFacilityMei: Facility = {
  facilityId: MEI_IDS.facilityId,
  founderId: MEI_IDS.founderId,
  capMinor: MEI_FACILITY.capMinor,
  currency: MEI_FACILITY.currency,
  reserveFloorBps: MEI_FACILITY.reserveFloorBps,
  lenderAddress: fakeAddress("lender:final-1"),
  chainId: MEI_IDS.chainId,
  deploymentId: MEI_IDS.deploymentId,
  openedTx: fakeHex32("tx:openFacility:mei"),
};

export const exampleE2PromptRowSG: E2PromptRow = {
  promptId: "e2-sg-001",
  country: "SG",
  lang: "en",
  vague: true,
  hiddenSlot: "residency",
  text: "I want to sell insulated tumblers on Shopee Singapore, budget about S$10k. How do I start?",
};

/** Mei's expected E2 fields (SG-DESIGN §3 evals): ACRA business registration only at launch, MFN duty, SFA approval. */
export const exampleE2LabelRowSG: E2LabelRow = {
  promptId: "e2-sg-001",
  fields: {
    entityType: "sg_sole_prop",
    registrations: ["ACRA_BUSINESS"],
    indirectTaxRegistered: false,
    eInvoicing: false,
    dutyRoute: "MFN",
    productApproval: "SFA",
    reserveBps: MEI_PLAN.reserveBps,
    licenceCostMinor: "11500",
  },
};

/** Synthetic SG identifiers (the NRIC carries a valid check letter; the phone is an 8-digit mobile with +65). */
export const exampleE5DocRowSG: E5DocRow = {
  docId: "e5-sg-0001",
  text: "Name: Tan Mei Ling, NRIC S1234567D, mobile +65 9123 4567.",
  spans: [
    { start: 25, end: 34, entity: "SG_NRIC" },
    { start: 43, end: 56, entity: "SG_PHONE" },
  ],
};
