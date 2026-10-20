/**
 * TERMS_CANDIDATE (VISION-DECISIONS §9): the supplier is a candidate of a READY web search of this facility, not
 * excluded, orderable, and the search is under 7 days old. The v-search row contract: `shortlists` (source 'web') has
 * search_json = SupplierSearch, result_json = the scorer's Shortlist and shortlist_hash = its hash (recomputed here);
 * chosenIndex is the supplier's index in result_json.candidates (as the catalog planOrder signs it); the Reader's
 * grounded seller name is that RankedSupplier's displayName (covered by the signed shortlistHash), and the stored
 * Supplier record (insert-only) must carry the same name. The search must also belong to the CURRENT committed plan
 * (run-9): made after that plan was signed, for its product category and sourcing country (spec_json), so a search
 * from a superseded plan (whose gates were computed for another category) is never orderable.
 */
import { PlanIntent, Shortlist, Supplier, SupplierSearch, isWebSupplierId, shortlistHashOf, type CandidateCard } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { termsFailure } from "./terms-checks";
import { one, type Q } from "./sql";

/** A web search older than this is refused: prices and listings move (search again). */
export const CANDIDATE_MAX_AGE_MS = 7 * 86_400_000;
/** What a card shows for a seller name that fails the wording check (v-search's rule). */
export const HIDDEN_NAME = "(name hidden)";
const UINT8_MAX = 255;

export interface WebCandidate {
  readonly shortlistId: string;
  readonly shortlistHash: `0x${string}`;
  readonly chosenIndex: number;
  readonly card: CandidateCard;
  /** The Reader's grounded seller name (suppliers.record_json.displayName): matched and screened, never shown raw. */
  readonly sellerName: string;
  readonly listingHost: string;
  readonly createdAtMs: number;
}

interface SearchRow {
  status: string;
  source: string;
  search_json: unknown;
  result_json: unknown;
  shortlist_hash: string | null;
  created_at: Date;
}

const notOrderable = (why: string) => termsFailure("TERMS_CANDIDATE", `${why}; search again or pick another supplier`);

/** The search row as stored, both bodies parsed; a row that does not parse is refused, never trusted. */
async function readySearch(q: Q, scope: Scope, searchId: string): Promise<{ row: SearchRow; search: SupplierSearch; shortlist: Shortlist }> {
  const row = await one<SearchRow>(
    q,
    "select status::text as status, source, search_json, result_json, shortlist_hash, created_at from shortlists where facility_id = $1 and id = $2",
    [scope.facilityId, searchId],
  );
  if (!row) throw fail("NOT_FOUND", "No such supplier search", { details: { reason: "TERMS_CANDIDATE" } });
  if (row.source !== "web" || row.status !== "READY" || !row.shortlist_hash) throw notOrderable("That search is not a finished web search");
  const search = SupplierSearch.safeParse(row.search_json);
  const shortlist = Shortlist.safeParse(row.result_json);
  // The hash is recomputed (never only compared to the field next to it): what the founder signs commits to this list.
  const hashOk = shortlist.success && shortlist.data.shortlistHash?.toLowerCase() === row.shortlist_hash.toLowerCase() && shortlistHashOf(shortlist.data).toLowerCase() === row.shortlist_hash.toLowerCase();
  if (!search.success || !shortlist.success || !hashOk) {
    throw notOrderable("That search's stored result is unreadable");
  }
  return { row, search: search.data, shortlist: shortlist.data };
}

interface PlanBinding {
  intent_json: unknown;
  spec_json: unknown;
  after_plan: boolean;
}

/**
 * TERMS_CANDIDATE unless the search was made under the facility's current committed plan: created at or after that
 * plan's signature (both database times), with the plan's product category and sourcing country in its spec.
 */
async function requireCurrentPlan(q: Q, scope: Scope, searchId: string): Promise<void> {
  const r = await one<PlanBinding>(
    q,
    `select d.intent_json, s.spec_json, s.created_at >= coalesce(p.signed_at, p.created_at) as after_plan
       from shortlists s
       join lateral (select draft_id, signed_at, created_at from plans
                      where facility_id = s.facility_id and status = 'COMMITTED' order by version desc limit 1) p on true
       left join plan_drafts d on d.facility_id = s.facility_id and d.id = p.draft_id
      where s.facility_id = $1 and s.id = $2`,
    [scope.facilityId, searchId],
  );
  const intent = PlanIntent.safeParse(r?.intent_json);
  const spec = r?.spec_json as { productCategory?: unknown; buyFrom?: unknown } | null | undefined;
  const same = intent.success && spec?.productCategory === intent.data.productCategory && spec?.buyFrom === intent.data.buyFrom;
  if (!r?.after_plan || !same) throw notOrderable("That search was made for an earlier plan");
}

/** The candidate, re-read from the facility's stored search and supplier record (confirm, prepare and finalize). */
export async function webCandidateOf(deps: ApiDeps, q: Q, scope: Scope, searchId: string, supplierId: string): Promise<WebCandidate> {
  if (!isWebSupplierId(supplierId)) throw notOrderable("Only a supplier found by web search is ordered through these terms");
  const { row, search, shortlist } = await readySearch(q, scope, searchId);
  const createdAtMs = new Date(row.created_at).getTime();
  if (!(deps.clock() - createdAtMs <= CANDIDATE_MAX_AGE_MS)) throw notOrderable("That search is more than 7 days old");
  await requireCurrentPlan(q, scope, searchId);
  const chosenIndex = shortlist.candidates.findIndex((c) => c.supplierId === supplierId);
  const card = search.candidates.find((c) => c.supplierId === supplierId);
  const excluded = shortlist.excluded.some((x) => x.supplierId === supplierId);
  if (chosenIndex < 0 || chosenIndex > UINT8_MAX || !card || excluded) throw notOrderable("That supplier is not an orderable candidate of the search");
  const ranked = shortlist.candidates[chosenIndex];
  // Gates from the hashed list too, not only from the (unhashed) card.
  if (card.origin !== "web" || !card.unverified || !card.canOrder || card.failedGates.length > 0 || !ranked || ranked.gates.some((g) => !g.passed)) {
    throw notOrderable("That supplier failed a check");
  }
  const stored = await one<{ record_json: unknown }>(q, "select record_json from suppliers where facility_id = $1 and supplier_id = $2", [scope.facilityId, supplierId]);
  const supplier = Supplier.safeParse(stored?.record_json);
  if (!supplier.success || supplier.data.supplierId !== supplierId) throw notOrderable("That supplier's record is missing");
  // The seller name is the one THIS search's hashed list holds (signed via shortlistHash); the stored record must agree.
  if (supplier.data.displayName !== ranked.displayName) throw notOrderable("That supplier's record no longer matches the search");
  let listingHost: string;
  try {
    listingHost = new URL(supplier.data.listing.url).hostname;
  } catch {
    throw notOrderable("That supplier's listing address is unreadable");
  }
  return {
    shortlistId: searchId,
    shortlistHash: row.shortlist_hash?.toLowerCase() as `0x${string}`,
    chosenIndex,
    card,
    sellerName: ranked.displayName,
    listingHost,
    createdAtMs,
  };
}
