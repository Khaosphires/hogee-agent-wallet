/**
 * Hard gates and per-criterion scores (§11). Scores are integers in basis points (0..10,000) internally and
 * shown as 0..100. Only tier-1/tier-2 evidence earns points: a tier-3 item (unverified, or a FAKE_REPORT that
 * failed verification) earns none, so planting one cannot change the ranking (T25). Certificate PRESENCE (any
 * tier) is what the MISSING_CERT gate checks, because FAKE_REPORT alone must not exclude (G0 decision).
 *
 * Trust & verification (security audit run-2): the best of tier-1/tier-2 trust evidence and the trust built from
 * registry ids plus platform metrics. Registry ids are loose strings (G0 decision), so an id earns points only when a
 * packages/checks validator result bound to this supplier marks that exact id valid; no result, no points. Platform
 * metrics (rating, years on platform) count as tier-2 (§12 Sourced) and on their own top out at
 * METRICS_TRUST_MAX_BPS, below tier-2 evidence, so unvalidated inputs never outscore verified evidence.
 * The validators are offline format/checksum checks, so a fake supplier can copy a real factory's public USCC: registry
 * points plus metrics together are capped at LISTING_TRUST_MAX_BPS, strictly below tier-2 evidence (skills re-check of
 * run-5), until registry points come from a registry lookup matched to the supplier's legal name.
 */
import { SUPPLIER_CRITERIA, SUPPLIER_GATES, type ProductCategory, type SupplierCriterion, type SupplierGate } from "../schemas/enums";
import type { EvidenceTier } from "../schemas/primitives";
import type { LandedCost, Supplier, SupplierEvidence } from "../schemas/supplier";
import { parseMinor } from "../money/index";
import { FLAG_SUPPLIER_GATE, detectImperativeText, type ImperativeFlag } from "../taint/imperative";

export const BPS_MAX = 10_000;
export const TIER_SCORE_BPS: { readonly [T in EvidenceTier]: number } = { tier1: 10_000, tier2: 7_500, tier3: 0 };

/** A certificate whose type or issuer contains one of these satisfies MISSING_CERT for the category. */
export const REQUIRED_CERT_KEYWORDS: { readonly [P in ProductCategory]: readonly string[] } = {
  drinkware_food_contact: ["food", "lfgb", "fda", "gb 4806"],
  cosmetics: ["gmp", "iso 22716", "npra", "bpom"],
  electrical: ["sirim", "iec", "ce", "ul"],
  food: ["haccp", "halal", "iso 22000", "food safety"],
  apparel: [],
  other: [],
};

/** Lead time scoring: full marks up to 14 days, zero from 60 days, linear between. */
export const LEAD_TIME_FULL_DAYS = 14;
export const LEAD_TIME_ZERO_DAYS = 60;

/** Trust points for a registry id a validator marked valid: a business registration (USCC, SSM or UEN), and an LEI. */
export const REGISTRY_ID_TRUST_BPS = { registration: 3_000, lei: 1_000 } as const;
/** Platform-metric trust: 800 per year on the platform (up to 5) plus 400 per rating star (0..5). */
export const METRICS_TRUST_MAX_BPS = 6_000;
/** Listing-derived trust (registry ids + platform metrics) never reaches tier-2 evidence: a copied USCC must not win. */
export const LISTING_TRUST_MAX_BPS = TIER_SCORE_BPS.tier2 - 500;

export type RegistryIdKind = keyof Supplier["ids"];
/** Every registry id kind, in the order red flags list failed checks. */
export const REGISTRY_ID_KINDS = ["uscc", "ssm", "uen", "lei"] as const satisfies readonly RegistryIdKind[];
/** Business registrations (any one earns REGISTRY_ID_TRUST_BPS.registration): China USCC, Malaysia SSM, Singapore UEN. */
export const BUSINESS_REGISTRATION_KINDS = ["uscc", "ssm", "uen"] as const satisfies readonly RegistryIdKind[];

/** One packages/checks result (validateUSCC, validateSSM, validateUEN, GLEIF lookup) for one of a supplier's registry ids. */
export interface RegistryIdCheck {
  readonly supplierId: Supplier["supplierId"];
  /** The exact id string the validator checked; the result counts only if it equals the supplier's id. */
  readonly id: string;
  readonly valid: boolean;
}
export type RegistryIdChecks = { readonly [K in RegistryIdKind]?: RegistryIdCheck };

export interface ScorerCandidate {
  readonly supplier: Supplier;
  readonly evidence: readonly SupplierEvidence[];
  /** Raw listing text (untrusted): scanned for imperative text, never followed. */
  readonly listingText: string;
  /** Landed cost for the requested quantity (landedCostFromPack). */
  readonly landedCost: LandedCost;
  /** packages/checks screenSanctions(...).hit */
  readonly sanctionsHit: boolean;
  /** Validator results for the supplier's registry ids. Absent (or not valid for that exact id) = no registry points. */
  readonly registryChecks?: RegistryIdChecks;
}

export interface GateResult {
  readonly gate: SupplierGate;
  readonly passed: boolean;
  readonly evidenceIds: string[];
}

export interface CriterionResult {
  readonly criterion: SupplierCriterion;
  readonly scoreBps: number;
  readonly evidenceIds: string[];
}

const keywordRe = (k: string): RegExp => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

/** Certificates whose type or issuer names a required keyword as a whole word (case-insensitive). */
export function relevantCertificates(supplier: Supplier, category: ProductCategory): Supplier["certificates"] {
  const res = REQUIRED_CERT_KEYWORDS[category].map(keywordRe);
  return supplier.certificates.filter((c) => res.some((re) => re.test(`${c.type} ${c.issuer}`.toLowerCase())));
}

/** Every flag in the listing and in the untrusted evidence strings. */
export function listingFlags(c: ScorerCandidate): ImperativeFlag[] {
  const texts = [c.listingText, ...c.evidence.map((e) => (typeof e.value === "string" ? e.value : ""))];
  return texts.flatMap((t) => detectImperativeText(t));
}

function evidenceFor(c: ScorerCandidate, criterion: SupplierCriterion): SupplierEvidence[] {
  return c.evidence.filter((e) => e.criterion === criterion);
}

export function evaluateGates(c: ScorerCandidate, category: ProductCategory, quantity: number, budgetMinor: string): GateResult[] {
  const s = c.supplier;
  const flags = listingFlags(c);
  const flagged = (gate: SupplierGate) => flags.some((f) => FLAG_SUPPLIER_GATE[f.flag] === gate);
  const certsNeeded = REQUIRED_CERT_KEYWORDS[category].length > 0;
  const passed: { readonly [G in SupplierGate]: boolean } = {
    NO_ESCROW: s.terms.escrow,
    PERSONAL_PAYEE: s.terms.payeeType === "company",
    MISSING_CERT: !certsNeeded || relevantCertificates(s, category).length > 0,
    OFF_PLATFORM_DISCOUNT: !s.terms.offPlatformDiscount && !flagged("OFF_PLATFORM_DISCOUNT"),
    AI_INJECTION: !flagged("AI_INJECTION"),
    OVER_MOQ: s.offer.moq <= quantity && parseMinor(c.landedCost.totalMinor) <= parseMinor(budgetMinor),
    SANCTIONS: !c.sanctionsHit,
  };
  const ids = (criterion: SupplierCriterion) => evidenceFor(c, criterion).map((e) => e.evidenceId);
  return SUPPLIER_GATES.map((gate) => ({
    gate,
    passed: passed[gate],
    evidenceIds: gate === "MISSING_CERT" ? ids("compliance") : gate === "NO_ESCROW" || gate === "OFF_PLATFORM_DISCOUNT" ? ids("terms") : [],
  }));
}

function bestTier(tiers: readonly EvidenceTier[]): number {
  return tiers.reduce((m, t) => Math.max(m, TIER_SCORE_BPS[t]), 0);
}

/** The validator result for the supplier's `kind` id, only when it is bound to this supplier and to that exact id. */
function boundCheck(c: ScorerCandidate, kind: RegistryIdKind): RegistryIdCheck | undefined {
  const id = c.supplier.ids[kind];
  const check = c.registryChecks?.[kind];
  return id !== undefined && check !== undefined && check.id === id && check.supplierId === c.supplier.supplierId ? check : undefined;
}

/** True only if a validator result bound to this supplier marks its `kind` id, exactly as listed, valid. */
export function registryIdValidated(c: ScorerCandidate, kind: RegistryIdKind): boolean {
  return boundCheck(c, kind)?.valid === true;
}

/**
 * The supplier's registry ids that a validator result bound to this supplier and to that exact id marks invalid
 * (REGISTRY_ID_KINDS order). A result for another supplier or another id string is not about this id: it earns no
 * points (registryIdValidated) and raises no flag here.
 */
export function failedRegistryChecks(c: ScorerCandidate): RegistryIdKind[] {
  return REGISTRY_ID_KINDS.filter((kind) => boundCheck(c, kind)?.valid === false);
}

/** Trust from validated registry ids plus platform metrics (before tier-1/tier-2 trust evidence is considered). */
function listingTrustBps(c: ScorerCandidate): number {
  const { metrics } = c.supplier;
  const registration = BUSINESS_REGISTRATION_KINDS.some((kind) => registryIdValidated(c, kind)) ? REGISTRY_ID_TRUST_BPS.registration : 0;
  const lei = registryIdValidated(c, "lei") ? REGISTRY_ID_TRUST_BPS.lei : 0;
  const fromMetrics = Math.min(METRICS_TRUST_MAX_BPS, Math.min(metrics.yearsOnPlatform, 5) * 800 + Math.round(metrics.rating * 400));
  return Math.min(LISTING_TRUST_MAX_BPS, registration + lei + Math.max(0, fromMetrics));
}

function leadTimeBps(days: number): number {
  if (days <= LEAD_TIME_FULL_DAYS) return BPS_MAX;
  if (days >= LEAD_TIME_ZERO_DAYS) return 0;
  return Math.floor(((LEAD_TIME_ZERO_DAYS - days) * BPS_MAX) / (LEAD_TIME_ZERO_DAYS - LEAD_TIME_FULL_DAYS));
}

const INCOTERM_BONUS_BPS: { readonly [k: string]: number } = { FOB: 4000, FCA: 4000, CFR: 4000, CIF: 4000, CPT: 4000, CIP: 4000, DAP: 3000, DPU: 3000, DDP: 3000, EXW: 1000, FAS: 1000 };

/** Criterion scores in bps. `cheapestMinor` = lowest landed total among gate-passing candidates. */
export function scoreCriteria(c: ScorerCandidate, category: ProductCategory, cheapestMinor: bigint): CriterionResult[] {
  const s = c.supplier;
  const evTiers = (k: SupplierCriterion) => evidenceFor(c, k).map((e) => e.tier);
  const certTiers = relevantCertificates(s, category).map((x) => x.tier);
  const total = parseMinor(c.landedCost.totalMinor);
  const trust = listingTrustBps(c);
  const scores: { readonly [K in SupplierCriterion]: number } = {
    landed_cost: total === 0n ? BPS_MAX : Number((cheapestMinor * BigInt(BPS_MAX)) / total),
    quality_evidence: bestTier([...evTiers("quality_evidence"), ...certTiers]),
    trust_verification: Math.min(BPS_MAX, Math.max(trust, bestTier(evTiers("trust_verification")))),
    lead_time: leadTimeBps(s.offer.leadTimeDays),
    compliance: REQUIRED_CERT_KEYWORDS[category].length === 0 ? BPS_MAX : bestTier([...certTiers, ...evTiers("compliance")]),
    terms: Math.min(BPS_MAX, (s.terms.escrow ? 6000 : 0) + (INCOTERM_BONUS_BPS[s.offer.incoterm] ?? 0)),
    communication: Math.min(BPS_MAX, Math.round(s.metrics.responseRate * BPS_MAX)),
  };
  return SUPPLIER_CRITERIA.map((criterion) => ({
    criterion,
    scoreBps: Math.max(0, Math.min(BPS_MAX, scores[criterion])),
    evidenceIds: evidenceFor(c, criterion).map((e) => e.evidenceId),
  }));
}

/** Evidence coverage (bps, never a probability): weighted share of criteria backed by tier-1/tier-2 evidence. */
export function evidenceCoverageBps(c: ScorerCandidate, weights: { readonly [K in SupplierCriterion]: number }): number {
  const covered = (k: SupplierCriterion): boolean =>
    evidenceFor(c, k).some((e) => e.tier !== "tier3") || (k === "landed_cost" && c.supplier.offer.fobUnit.evidence !== "tier3");
  return SUPPLIER_CRITERIA.reduce((sum, k) => sum + (covered(k) ? weights[k] * 100 : 0), 0);
}
