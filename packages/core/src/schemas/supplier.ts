/**
 * Supplier, SupplierEvidence, SupplierFile, RankedSupplier, Shortlist (project.md §11, §26.5, §26.6).
 * Files: data/suppliers/demo/*.json (SupplierFile), data/suppliers/eval/set-XX/listings/*.json (Supplier).
 */
import { z } from "zod";
import {
  Incoterm,
  PayeeType,
  ProductCategory,
  ShortlistStatus,
  SupplierCriterion,
  SupplierGate,
} from "./enums";
import {
  Bps,
  CurrencyCode,
  EvidenceTier,
  Hex32,
  HttpUrl,
  Id,
  Iso2,
  Minor,
  NonNegInt,
  PosInt,
  SourceType,
  SupplierId,
  Taint,
  sourced,
} from "./primitives";

// G0-DECISION: supplier registry ids are loose strings; format/checksum validation is packages/checks'
// job, so fixtures can plant malformed ids for the validators to catch.
// w2-core (SG): `uen` is a Singapore UEN (ACRA), checked by packages/checks validateUEN; additive and optional.
const RegistryId = z.string().min(1).max(64);

export const Supplier = z.strictObject({
  supplierId: SupplierId,
  displayName: z.string().min(1).max(200),
  country: Iso2,
  ids: z.strictObject({ uscc: RegistryId.optional(), ssm: RegistryId.optional(), lei: RegistryId.optional(), uen: RegistryId.optional() }),
  listing: z.strictObject({
    url: HttpUrl,
    sourceType: SourceType,
    rawTextRef: z.string().min(1).max(300).describe("Repo-relative path of the raw listing text, e.g. data/suppliers/eval/set-01/raw/a.txt"),
  }),
  offer: z.strictObject({
    currency: CurrencyCode,
    // G0-DECISION: §26.5 says fobUnit: Sourced<number>, but D16 (money = integer minor units) wins:
    // fobUnit and freightPerUnit are Minor in offer.currency minor units (e.g. CNY 12.50 = "1250").
    fobUnit: sourced(Minor),
    moq: PosInt,
    leadTimeDays: NonNegInt,
    freightPerUnit: Minor,
    incoterm: Incoterm,
  }),
  terms: z.strictObject({ escrow: z.boolean(), offPlatformDiscount: z.boolean(), payeeType: PayeeType }),
  certificates: z.array(
    z.strictObject({
      type: z.string().min(1).max(100),
      issuer: z.string().min(1).max(200),
      ref: z.string().min(1).max(200),
      tier: EvidenceTier,
    }),
  ),
  // G0-DECISION: rating 0..5, responseRate is a fraction 0..1, yearsOnPlatform integer years.
  metrics: z.strictObject({
    rating: z.number().min(0).max(5),
    responseRate: z.number().min(0).max(1),
    yearsOnPlatform: NonNegInt,
  }),
  xenditTest: z.strictObject({
    channel: z.string().min(1).max(64),
    accountNumber: z.string().regex(/^[0-9]{4,34}$/),
    holderName: z.string().min(1).max(200),
  }),
});
export type Supplier = z.infer<typeof Supplier>;

/**
 * VISION-DECISIONS §3: a web supplier's id is "supplier-w" + the first 12 characters of the lowercase, unpadded base32
 * of sha256(canonical listing URL). It fits ShortId and the API's SUPPLIER_RE / ORDER_RE (order-w<12>-001).
 */
export const WEB_SUPPLIER_ID_RE = /^supplier-w[a-z2-7]{12}$/;

/** True for an id of a supplier found by web search (never a catalog id). */
export function isWebSupplierId(id: string): boolean {
  return WEB_SUPPLIER_ID_RE.test(id);
}

/** The object whose JCS keccak256 is RankedSupplier.payoutAccountHash (key set is frozen). */
export function payoutAccountPreimage(x: Supplier["xenditTest"]): { channel: string; accountNumber: string; holderName: string } {
  return { channel: x.channel, accountNumber: x.accountNumber, holderName: x.holderName };
}

export const SupplierEvidence = z.strictObject({
  evidenceId: Id,
  supplierId: SupplierId,
  criterion: SupplierCriterion,
  tier: EvidenceTier,
  sourceType: SourceType,
  sourceUrl: HttpUrl,
  snippetHash: Hex32,
  // G0-DECISION: evidence value is a JSON primitive (string | number | boolean).
  value: z.union([z.string(), z.number(), z.boolean()]),
  taint: Taint,
});
export type SupplierEvidence = z.infer<typeof SupplierEvidence>;

/**
 * One supplier data file (docs/decisions/suppliers.md Q1): `{supplier, evidence[]}`, or a plain Supplier with no
 * evidence rows. The same two shapes packages/api runtime/files.ts loads. Every evidence row must name the file's
 * supplier, and evidence ids are unique within the file (validate:data also checks them across the demo catalog,
 * because the API stores evidence per facility keyed by evidenceId only).
 */
export const SupplierFile = z
  .union([z.strictObject({ supplier: Supplier, evidence: z.array(SupplierEvidence) }), Supplier])
  .superRefine((file, ctx) => {
    if (!("supplier" in file)) return;
    const seen = new Set<string>();
    file.evidence.forEach((e, i) => {
      if (e.supplierId !== file.supplier.supplierId) {
        ctx.addIssue({ code: "custom", path: ["evidence", i, "supplierId"], message: `evidence names ${e.supplierId}, the file's supplier is ${file.supplier.supplierId}` });
      }
      if (seen.has(e.evidenceId)) ctx.addIssue({ code: "custom", path: ["evidence", i, "evidenceId"], message: `duplicate evidenceId ${e.evidenceId}` });
      seen.add(e.evidenceId);
    });
  });
export type SupplierFile = z.infer<typeof SupplierFile>;

/** The Supplier and its evidence rows (none for a plain Supplier record) of a schema-valid SupplierFile. */
export function supplierFileParts(file: SupplierFile): { readonly supplier: Supplier; readonly evidence: readonly SupplierEvidence[] } {
  return "supplier" in file ? file : { supplier: file, evidence: [] };
}

/** GET /api/suppliers/:id → Supplier + evidence[]. */
export const SupplierWithEvidence = Supplier.extend({ evidence: z.array(SupplierEvidence) });
export type SupplierWithEvidence = z.infer<typeof SupplierWithEvidence>;

/** Templated pro/con keyed to evidence ids. */
export const EvidenceNote = z.strictObject({ text: z.string().min(1).max(500), evidenceIds: z.array(Id) });
export type EvidenceNote = z.infer<typeof EvidenceNote>;

/** Red flag (same shape as the chat data-redflag part). */
export const RedFlag = z.strictObject({
  text: z.string().min(1).max(500),
  source: z.string().min(1).max(300).describe("Where it came from, e.g. listing:supplier-c or a URL"),
});
export type RedFlag = z.infer<typeof RedFlag>;

export const LandedCost = z.strictObject({
  // Facility display-currency minor units.
  cifMinor: Minor,
  dutyMinor: Minor,
  sstMinor: Minor,
  feesMinor: Minor,
  totalMinor: Minor,
  fx: sourced(z.number().positive()).describe("Offer currency → display currency rate (BNM)"),
});
export type LandedCost = z.infer<typeof LandedCost>;

// G0-DECISION: score and per-criterion scores are numbers in [0, 100];
// supplierId + displayName are added (the §26.5 field list has no link back to the supplier).
export const RankedSupplier = z.strictObject({
  supplierId: SupplierId,
  displayName: z.string().min(1).max(200),
  rank: PosInt,
  score: z.number().min(0).max(100),
  criteria: z.array(
    z.strictObject({
      criterion: SupplierCriterion,
      weight: z.number().int().min(0).max(100),
      score: z.number().min(0).max(100),
      evidenceIds: z.array(Id),
    }),
  ),
  landedCost: LandedCost,
  // G0-REVIEW: payout destination the founder signs in SupplierApproval and settlement checks the Xendit
  // destination against: keccak256(utf8(JCS({channel, accountNumber, holderName}))) of Supplier.xenditTest
  // (see payoutAccountPreimage). Server-computed; not stored in supplier fixtures.
  payoutAccountHash: Hex32,
  evidenceCoverageBps: Bps.describe("Evidence coverage (never a probability)"),
  gates: z.array(z.strictObject({ gate: SupplierGate, passed: z.boolean(), evidenceIds: z.array(Id) })),
  redFlags: z.array(RedFlag),
  pros: z.array(EvidenceNote),
  cons: z.array(EvidenceNote),
  // G0-DECISION: whyNotNext is null for the last candidate.
  whyNotNext: z.string().min(1).max(500).nullable(),
  whatWouldChange: z.string().min(1).max(500),
});
export type RankedSupplier = z.infer<typeof RankedSupplier>;

export const Shortlist = z
  .strictObject({
    requestId: Id,
    status: ShortlistStatus,
    candidates: z.array(RankedSupplier),
    excluded: z.array(z.strictObject({ supplierId: SupplierId, gate: SupplierGate })),
    // G0-DECISION: rankStabilityPct and shortlistHash are null until status = READY.
    rankStabilityPct: z.number().min(0).max(100).nullable(),
    shortlistHash: Hex32.nullable(),
    weightsVersion: z.string().min(1).max(64),
    // G2 (P2 request, PR #10): why a FAILED shortlist failed, as a short server-written summary (never listing text or
    // a stack trace); null for every other status. Additive: optional on input (fixtures and stored results predate
    // it) and always present once parsed (default null). Not hashed: shortlistHash covers only
    // {requestId, weightsVersion, candidates, excluded} (scorer shortlistHashOf), so no existing hash changes.
    failureReason: z.string().min(1).max(300).nullable().default(null),
  })
  .refine((s) => s.status === "FAILED" || s.failureReason === null, { message: "failureReason is null unless status is FAILED", path: ["failureReason"] });
export type Shortlist = z.infer<typeof Shortlist>;

// G0-DECISION: POST /api/suppliers/shortlist {spec} (spec shape not given in §26.6).
export const ShortlistSpec = z.strictObject({
  productCategory: ProductCategory,
  buyFrom: Iso2,
  quantity: PosInt,
  budgetMinor: Minor,
});
export type ShortlistSpec = z.infer<typeof ShortlistSpec>;
