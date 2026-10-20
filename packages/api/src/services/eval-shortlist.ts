/**
 * E3 suppliers (project.md §15): POST /api/eval/shortlist ranks one eval set (data/suppliers/eval/set-XX).
 *   hogee     the SHIPPED shortlist (services/shortlist.ts rankFixtures → core buildShortlist: hard gates, weighted
 *             criteria with evidence, rank stability, shortlistHash) with the live checks, failing closed;
 *   llm_rank  the BASELINE: the guarded reader model ranks the raw listings directly (@hogee/agent
 *             rankListingsBaseline). No gates and no scores: each candidate carries only its rank, the code-computed
 *             landed cost and payout hash, and a note that the model gave no reasons. weightsVersion "llm_rank".
 * The set's buyer need is its spec.json, else the Rina demo need (drinkware from CN, 1,000 units, 5,000 BU); like the
 * product, only listings from its buyFrom country are considered. Nothing is stored: an eval shortlist is never a
 * READY row, so a SupplierApproval can never pick from it.
 */
import { BASELINE_MAX_LISTINGS, BASELINE_MAX_LISTING_CHARS, BaselineRankError, rankListingsBaseline } from "@hogee/agent";
import { payoutAccountHash, shortlistHashOf, type RankedSupplier, type ScorerCandidate, type Shortlist, type ShortlistMode, type ShortlistSpec } from "@hogee/core";
import type { ApiDeps, Scope, SupplierFixture } from "../context";
import { fail } from "../http/problem";
import { llmCallSink } from "./chat-store";
import { packFor } from "./compile";
import { facilityRow } from "./facility";
import { newId } from "./ids";
import { pool } from "./sql";
import { forSpec, rankFixtures, scorerCandidates, unreadableListings } from "./shortlist";
import { appendEvalTrace } from "./traces";

/** The Rina demo need (§26.2; core exampleShortlistSpec), used when a set has no spec.json. */
export const DEFAULT_EVAL_SPEC: ShortlistSpec = { productCategory: "drinkware_food_contact", buyFrom: "CN", quantity: 1000, budgetMinor: "500000" };
export const LLM_RANK_WEIGHTS_VERSION = "llm_rank";
const NO_REASON = "LLM ranking baseline: the model gave no reasons, gates or evidence.";

/** What the baseline model sees for one supplier: the record's offer facts, then the raw (untrusted) listing text. */
export function baselineText(f: SupplierFixture): string {
  const s = f.supplier;
  const facts = { name: s.displayName, country: s.country, offer: { ...s.offer, fobUnit: s.offer.fobUnit.value }, terms: s.terms, certificates: s.certificates, metrics: s.metrics };
  return `Supplier record: ${JSON.stringify(facts)}\nListing text:\n${f.listingText || "(none)"}`.slice(0, BASELINE_MAX_LISTING_CHARS);
}

/** The baseline's ranking as a Shortlist: rank and code-computed facts only (no scores, gates or exclusions). */
export function llmRankShortlist(requestId: string, ranking: readonly string[], candidates: readonly ScorerCandidate[]): Shortlist {
  const byId = new Map(candidates.map((c) => [c.supplier.supplierId, c]));
  const ranked: RankedSupplier[] = ranking.map((id, i) => {
    const c = byId.get(id);
    if (!c) throw new Error(`ranking names unknown supplier ${id}`);
    return {
      supplierId: id,
      displayName: c.supplier.displayName,
      rank: i + 1,
      score: 0,
      criteria: [],
      landedCost: c.landedCost,
      payoutAccountHash: payoutAccountHash(c.supplier.xenditTest),
      evidenceCoverageBps: 0,
      gates: [],
      redFlags: [],
      pros: [],
      cons: [],
      whyNotNext: i < ranking.length - 1 ? NO_REASON : null,
      whatWouldChange: NO_REASON,
    };
  });
  const base = { requestId, weightsVersion: LLM_RANK_WEIGHTS_VERSION, candidates: ranked, excluded: [] };
  return { ...base, status: "READY", rankStabilityPct: null, shortlistHash: shortlistHashOf(base), failureReason: null };
}

const CHECKS_DOWN = "A supplier check (FX, sanctions or registry) is unavailable, so the set was not ranked";

async function candidatesOrNotFound(deps: ApiDeps, fixtures: readonly SupplierFixture[], spec: ShortlistSpec, currency: string): Promise<ScorerCandidate[]> {
  try {
    return await scorerCandidates(deps, fixtures, spec, currency);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "ApiProblem") throw error;
    deps.log.warn("eval_shortlist_checks_failed", { error });
    throw fail("NOT_FOUND", CHECKS_DOWN);
  }
}

export async function evalShortlist(deps: ApiDeps, scope: Scope, setId: string, mode: ShortlistMode, signal?: AbortSignal): Promise<Shortlist> {
  const set = await deps.catalog.supplierEvalSet(setId);
  if (!set || set.listings.length === 0) throw fail("NOT_FOUND", `No supplier set ${setId} with valid listings in data/suppliers/eval`);
  if (set.listings.length > BASELINE_MAX_LISTINGS) throw fail("NOT_FOUND", `${setId} has ${set.listings.length} listings; a set holds at most ${BASELINE_MAX_LISTINGS}`);
  if (new Set(set.listings.map((l) => l.supplier.supplierId)).size !== set.listings.length) throw fail("NOT_FOUND", `${setId} lists one supplierId twice; fix the dataset`);
  const spec = set.spec ?? DEFAULT_EVAL_SPEC;
  // Exactly the suppliers the product shortlist would consider for this spec (computeShortlist filters the same way).
  const listings = forSpec(set.listings, spec);
  if (listings.length === 0) throw fail("NOT_FOUND", `No listing of ${setId} sells from ${spec.buyFrom} (the set's buyFrom)`);
  const unreadable = unreadableListings(listings);
  if (unreadable) throw fail("NOT_FOUND", `${setId}: ${unreadable}`);
  await packFor(deps, deps.config.countryCode); // landed cost needs the pack: a missing pack is its own NOT_FOUND
  const currency = (await facilityRow(pool(deps.db), scope))?.currency ?? deps.config.currency;
  const requestId = newId("sl-eval");
  if (mode === "hogee") {
    const out = await rankFixtures(deps, requestId, listings, spec, currency);
    if (!out.shortlist) throw fail("NOT_FOUND", out.error ?? CHECKS_DOWN);
    await trace(deps, scope, requestId, `[eval E3 ${setId} hogee] ${out.shortlist.candidates.length} ranked, ${out.shortlist.excluded.length} excluded by hard gates; nothing stored`);
    return out.shortlist;
  }
  const candidates = await candidatesOrNotFound(deps, listings, spec, currency);
  const models = deps.agent.models({ facilityId: scope.facilityId, traceId: requestId }, llmCallSink(deps));
  let ranking: readonly string[];
  try {
    ranking = (await rankListingsBaseline(listings.map((f) => ({ supplierId: f.supplier.supplierId, text: baselineText(f) })), { model: models.reader, ...(signal ? { abortSignal: signal } : {}) })).ranking;
  } catch (e) {
    if (e instanceof BaselineRankError) throw fail("UPSTREAM", `The baseline model gave no usable ranking (${e.reason})`, { details: { reason: e.reason } });
    throw e;
  }
  await trace(deps, scope, requestId, `[eval E3 ${setId} llm_rank] the reader model ranked ${ranking.length} listings directly (baseline; no gates); nothing stored`);
  return llmRankShortlist(requestId, ranking, candidates);
}

async function trace(deps: ApiDeps, scope: Scope, traceId: string, summary: string): Promise<void> {
  await appendEvalTrace(deps.db, { facilityId: scope.facilityId, traceId, actor: "reader", kind: "TOOL_CALL", summary });
}
