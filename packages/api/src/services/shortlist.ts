/**
 * Supplier shortlist (§11, §26.1 step 5): catalog fixtures + live checks → core buildShortlist (hard gates, weighted
 * criteria with evidence ids, rank stability, shortlistHash). Listing text is UNTRUSTED: the scorer scans it for
 * imperative text and never follows it (T11). Every supplier input is stored per facility; checks that cannot run
 * fail closed (the shortlist is FAILED, never ranked on missing facts).
 */
import {
  buildShortlist,
  Shortlist,
  WEIGHTS_VERSION,
  landedCostFromPack,
  payoutAccountPreimage,
  type RegistryIdCheck,
  type RegistryIdChecks,
  type ScorerCandidate,
  type Shortlist as ShortlistT,
  type ShortlistSpec,
  type Supplier,
  type SupplierOrigin,
} from "@hogee/core";
import { isRegistryKind, type ApiDeps, type RegistryKind, type Scope, type SupplierFixture } from "../context";
import { fail } from "../http/problem";
import { currencyFor } from "../runtime/env";
import { packFor } from "./compile";
import { one, rows, type Q } from "./sql";
import { SUPERSEDED_REASON } from "./writer-bounds";

const TIER_ORDER = { tier1: 0, tier2: 1, tier3: 2 } as const;

/**
 * Audit run-8 (SG-DESIGN fail-open 3 on the shortlist): landed cost applies the server's HOGEE_COUNTRY pack and converts
 * into `currency` (the facility's), so both must be that country's, as compileEnv requires (requireServerCountry).
 * Otherwise an SG server would price an MYR facility's CN drinkware as SG MFN plus 9% GST instead of MY Form E plus 10%
 * sales tax, or the reverse. Refused (CONFLICT) before any FX, sanctions, registry or pack read.
 */
export function requirePricingCurrency(deps: ApiDeps, currency: string): void {
  const country = deps.config.countryCode;
  const own = currencyFor(country);
  if (currency !== own || deps.config.currency !== own) {
    throw fail("CONFLICT", `This server prices for ${country} (${own}), but the shortlist is in ${currency}; nothing was priced`);
  }
}

async function candidateOf(deps: ApiDeps, f: SupplierFixture, spec: ShortlistSpec, currency: string): Promise<ScorerCandidate> {
  const s = f.supplier;
  const listingText = f.listingText;
  if (listingText === null) throw new Error(`listing text of ${s.supplierId} unreadable`);
  const pack = await packFor(deps, deps.config.countryCode);
  // The pack file itself must be that country's, in that currency (fails the shortlist closed if not).
  if (pack.countryCode !== deps.config.countryCode || pack.currency !== currency) throw new Error(`the ${deps.config.countryCode} pack is not for ${currency}`);
  const fx = await deps.checks.fx(`${s.offer.currency}/${currency}`, new Date(deps.clock()).toISOString().slice(0, 10));
  // The category selects the pack's MFN rate (SG: imports.mfnDutyRateBps.<category>); a missing one stays MFN_RATE_REQUIRED.
  const { landedCost } = landedCostFromPack({
    countryPack: pack,
    origin: s.country,
    productCategory: spec.productCategory,
    quantity: spec.quantity,
    fobUnitMinor: s.offer.fobUnit.value,
    freightPerUnitMinor: s.offer.freightPerUnit,
    fx,
  });
  const screens = await Promise.all(beneficiaryNames(s).map((name) => deps.checks.screenSanctions(name)));
  return { supplier: s, evidence: f.evidence, listingText, landedCost, sanctionsHit: screens.some((r) => r.hit), registryChecks: registryChecksOf(deps, s) };
}

/**
 * Audit run-8: every name that identifies who is paid, each screened (a hit on any one gates SANCTIONS): the display
 * name and the payout account holder that SupplierApproval shows the founder, binds in payoutAccountHash and settlement
 * pays (payoutAccountPreimage, so the screened holder is exactly the signed one). The Supplier record has no separate
 * legal-name field; one added later belongs here. A repeated name is screened once.
 */
export function beneficiaryNames(s: Supplier): readonly string[] {
  return [...new Set([s.displayName, payoutAccountPreimage(s.xenditTest).holderName])];
}

/** Registry ids no offline validator checks (an LEI needs a GLEIF lookup): skipped, so they earn no registry points. */
const UNCHECKED_ID_KINDS: ReadonlySet<string> = new Set(["lei"]);

/**
 * One validator result per registry id the supplier lists, each from its own kind's validator (SG-DESIGN §4 fail-open
 * 4: a UEN is never checked as SSM). An id of a kind with no validator throws, so the shortlist fails closed. Each
 * result is bound to this supplier and the exact id checked (core registryIdValidated requires both).
 */
export function registryChecksOf(deps: ApiDeps, s: Supplier): RegistryIdChecks {
  const ids: Readonly<Record<string, string | undefined>> = s.ids;
  const checks = Object.entries(ids)
    .filter((e): e is [string, string] => e[1] !== undefined && !UNCHECKED_ID_KINDS.has(e[0]))
    .map(([kind, id]): [RegistryKind, RegistryIdCheck] => {
      if (!isRegistryKind(kind)) throw new Error(`supplier ${s.supplierId} lists a registry id kind with no validator`);
      return [kind, { supplierId: s.supplierId, id, valid: deps.checks.validateRegistryId(kind, id).valid }];
    });
  // A "uen" result feeds core's scorer like USCC and SSM: a valid UEN earns registry trust, a failed one a red flag.
  const out: Partial<Readonly<Record<RegistryKind, RegistryIdCheck>>> = Object.fromEntries(checks);
  return out;
}

/** Stores the supplier records and evidence for this facility (payees and orders reference them). */
export async function storeSuppliers(q: Q, scope: Scope, fixtures: readonly SupplierFixture[]): Promise<void> {
  for (const f of fixtures) {
    const s = f.supplier;
    const tier = [...f.evidence.map((e) => e.tier), "tier3" as const].sort((a, b) => TIER_ORDER[a] - TIER_ORDER[b])[0];
    await q.query(
      `insert into suppliers (facility_id, supplier_id, display_name, country, record_json, evidence_tier, source_type)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (facility_id, supplier_id) do update set display_name = excluded.display_name, record_json = excluded.record_json,
         evidence_tier = excluded.evidence_tier, source_type = excluded.source_type, updated_at = now()`,
      [scope.facilityId, s.supplierId, s.displayName, s.country, JSON.stringify(s), tier, s.listing.sourceType],
    );
    for (const e of f.evidence) {
      await q.query(
        `insert into supplier_evidence (facility_id, evidence_id, supplier_id, criterion, tier, source_type, source_url, snippet_hash, value, taint)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb) on conflict (facility_id, evidence_id) do nothing`,
        [scope.facilityId, e.evidenceId, e.supplierId, e.criterion, e.tier, e.sourceType, e.sourceUrl, e.snippetHash, JSON.stringify(e.value), JSON.stringify(e.taint)],
      );
    }
  }
}

export interface ShortlistOutcome {
  readonly shortlist?: ShortlistT;
  readonly error?: string;
}

/** The failure summaries rankFixtures writes to `shortlists.error` (and failureReasonOf lets back out). */
export const CHECK_DOWN_REASON = "A supplier check could not run, so nothing was ranked";
const LISTING_UNREADABLE_RE = /^The listing text of [a-z0-9][a-z0-9_-]{0,31}(, [a-z0-9][a-z0-9_-]{0,31})* could not be read, so nothing was ranked$/;
const LISTING_UNREADABLE_SHORT = "The listing text of some suppliers could not be read, so nothing was ranked";
const UNKNOWN_FAILURE = "The shortlist could not be completed; start a new one";
const MAX_REASON_CHARS = 300;

/**
 * G2 (P2 request): the FAILED shortlist's `failureReason`. Only a summary this module wrote is returned (supplier ids,
 * never listing text); anything else in the column (an older row, a bare "failed", an error message or a stack trace)
 * reads as one generic sentence, so the reason can never leak what a failure carried.
 */
export function failureReasonOf(stored: string | null): string {
  if (stored === CHECK_DOWN_REASON || stored === SUPERSEDED_REASON) return stored;
  if (stored !== null && LISTING_UNREADABLE_RE.test(stored)) return stored.length <= MAX_REASON_CHARS ? stored : LISTING_UNREADABLE_SHORT;
  return UNKNOWN_FAILURE;
}

/**
 * Scorer candidates for these fixtures (landed cost, sanctions and registry checks); throws when a check cannot run,
 * and CONFLICT before any check when `currency` is not the server country's (requirePricingCurrency).
 */
export async function scorerCandidates(deps: ApiDeps, fixtures: readonly SupplierFixture[], spec: ShortlistSpec, currency: string): Promise<ScorerCandidate[]> {
  requirePricingCurrency(deps, currency);
  return Promise.all(fixtures.map((x) => candidateOf(deps, x, spec, currency)));
}

/** The suppliers whose listing text could not be read: their injection and off-platform gates cannot be checked. */
export function unreadableListings(fixtures: readonly SupplierFixture[]): string | null {
  const ids = fixtures.filter((f) => f.listingText === null).map((f) => f.supplier.supplierId);
  return ids.length === 0 ? null : `The listing text of ${ids.join(", ")} could not be read, so nothing was ranked`;
}

/**
 * Gates, scores and ranks fixtures with the live checks (no writes). Fails closed, never ranking on missing facts:
 * a listing whose text could not be read (its gates would pass on no text), or a check that cannot run. A currency
 * that is not the server country's is refused (CONFLICT, thrown) before anything else.
 */
export async function rankFixtures(deps: ApiDeps, requestId: string, fixtures: readonly SupplierFixture[], spec: ShortlistSpec, currency: string): Promise<ShortlistOutcome> {
  requirePricingCurrency(deps, currency);
  const unreadable = unreadableListings(fixtures);
  if (unreadable) {
    deps.log.warn("shortlist_listing_unreadable", { requestId });
    return { error: unreadable };
  }
  try {
    return { shortlist: buildShortlist({ requestId, spec, candidates: await scorerCandidates(deps, fixtures, spec, currency) }) };
  } catch (error: unknown) {
    deps.log.warn("shortlist_failed", { requestId, error });
    return { error: CHECK_DOWN_REASON };
  }
}

/** The suppliers a shortlist for `spec` considers: those selling from the spec's buyFrom country (product and E3). */
export function forSpec(fixtures: readonly SupplierFixture[], spec: ShortlistSpec): SupplierFixture[] {
  return fixtures.filter((x) => x.supplier.country === spec.buyFrom);
}

/**
 * The product shortlist's inputs and outcome, computed WITHOUT a database client: the outside checks (FX, sanctions,
 * registry) may be slow, so the caller stores the fixtures and the outcome in its own short transaction afterwards.
 */
export async function computeShortlist(deps: ApiDeps, currency: string, requestId: string, spec: ShortlistSpec): Promise<{ fixtures: SupplierFixture[]; outcome: ShortlistOutcome }> {
  const fixtures = forSpec(await deps.catalog.suppliers(), spec);
  return { fixtures, outcome: await rankFixtures(deps, requestId, fixtures, spec, currency) };
}

interface ShortlistRow {
  id: string;
  status: ShortlistT["status"];
  result_json: unknown;
  weights_version: string | null;
  error: string | null;
}

export function shortlistView(r: ShortlistRow): ShortlistT {
  if (r.status === "READY" && r.result_json) return Shortlist.parse(r.result_json);
  return {
    requestId: r.id,
    status: r.status,
    candidates: [],
    excluded: [],
    rankStabilityPct: null,
    shortlistHash: null,
    weightsVersion: r.weights_version ?? WEIGHTS_VERSION,
    failureReason: r.status === "FAILED" ? failureReasonOf(r.error) : null,
  };
}

export async function shortlistRow(q: Q, scope: Scope, id: string): Promise<ShortlistRow | undefined> {
  return one<ShortlistRow>(q, "select id, status, result_json, weights_version, error from shortlists where facility_id = $1 and id = $2", [scope.facilityId, id]);
}

/**
 * The newest READY shortlist of one source (what a SupplierApproval may choose from). VISION-DECISIONS §6: a web search
 * and the catalog shortlist never stand in for each other; the catalog flow passes "catalog".
 */
export async function latestReadyShortlist(q: Q, scope: Scope, source: SupplierOrigin): Promise<{ shortlist: ShortlistT; spec: ShortlistSpec } | undefined> {
  const [r] = await rows<{ result_json: unknown; spec_json: ShortlistSpec }>(
    q,
    "select result_json, spec_json from shortlists where facility_id = $1 and status = 'READY' and source = $2 order by created_at desc limit 1",
    [scope.facilityId, source],
  );
  return r ? { shortlist: Shortlist.parse(r.result_json), spec: r.spec_json } : undefined;
}

/**
 * Re-check M2: past MAX_OPEN_SHORTLISTS open (PENDING or READY) shortlists of one source, the oldest open ones of that
 * source are superseded (FAILED with SUPERSEDED_REASON), never refused. VISION-DECISIONS §6: per source, so web searches
 * never supersede the catalog shortlist (or the reverse).
 */
export async function supersedeOldShortlists(q: Q, scope: Scope, source: SupplierOrigin, keep: number): Promise<void> {
  await q.query(
    `update shortlists set status = 'FAILED', error = $2, updated_at = now()
      where facility_id = $1 and source = $4 and status in ('PENDING', 'READY') and id not in (
        select id from shortlists where facility_id = $1 and source = $4 and status in ('PENDING', 'READY') order by created_at desc, id desc limit $3)`,
    [scope.facilityId, SUPERSEDED_REASON, keep, source],
  );
}
