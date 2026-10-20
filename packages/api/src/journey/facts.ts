/**
 * The founder's JourneyFacts from the database and the chain mirror (draft, plan status, founder key, latest supplier
 * list, picked suppliers, terms, order); core journeyFactsOf applies the session's history and deriveJourney turns them
 * into a stage, exactly as the mock does. Reads only, all facility-scoped.
 *
 *   - draft / plan: the COMMITTED plan's draft if there is one, else the latest plan row (when it is the session's
 *     draft) or the latest draft the chat showed; plan status COMMITTED wins over a later replan in flight;
 *   - founder key: founders.key_status REGISTERED;
 *   - list: the newest shortlists row (web search or catalog), a web row PENDING for over 2 minutes reads FAILED
 *     (v-search's rule); candidates from search_json (web) or result_json (catalog);
 *   - terms: the SESSION's own terms (critic gap 2): of the termsIds its terms_saved presses saved (core
 *     termsIdsNewestFirst, latest first), the first the facility has, whatever its status. Never another session's
 *     newest row, so a sign card only offers terms this conversation saved;
 *   - order: the USED terms' escrow order, bound when its payee is COOLING or BOUND (the worker mirrors payeeBinding),
 *     bindFailed when the worker CANCELLED its payee because its bindPayee never landed (audit run-9 critic gap 1),
 *     cooling end from payees.cooling_until, firstPaid when milestone 0 is released, balancePaid when every milestone
 *     is (UX-PLAN D35), releaseSigned when the first held milestone not released yet has a live RELEASE_MILESTONE row
 *     (founder-payments' commit; the same rule as routes/suppliers.ts, rcfix-journey A-6); `now` is chain time then
 *     (Anvil warps move it), wall time otherwise;
 *   - paused: Treasury.paused() at the head, as GET /api/balances shows it, read once the plan is COMMITTED (before
 *     that no step reads it). A failed read throws UPSTREAM: the reply never says payments run when it can't tell
 *     (fail closed, rcfix-journey A-7).
 * The session's history is the journey's projection of the whole session (chat-store loadHistoryParts), not the
 * newest-messages window, so a long session keeps its facts (audit run-9 lead 2).
 */
import {
  Shortlist,
  SupplierSearch,
  journeyFactsOf,
  listOfSearch,
  readHistory,
  termsIdsNewestFirst,
  type CandidateList,
  type HistoryMessage,
  type JourneyFacts,
  type JourneyHistory,
  type Persona,
  type PlanStatus,
  type SourceFacts,
  type TermsStatus,
} from "@hogee/core";
import { iTreasuryAbi } from "../chain-lib";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { chainNow } from "../services/chain";
import { loadHistoryParts } from "../services/chat-store";
import { one, pool, rows, type Q } from "../services/sql";

/** v-search: a web search still PENDING after this long reads as FAILED. */
export const STALE_SEARCH_SECONDS = 120;

interface ListRow {
  id: string;
  source: "catalog" | "web";
  status: "PENDING" | "READY" | "FAILED";
  stale: boolean;
  search_json: unknown;
  result_json: unknown;
}

/** A web row: PENDING / FAILED from its status column (stale PENDING → FAILED); READY only when its body parses. */
function webList(r: ListRow): CandidateList {
  const status = r.status === "PENDING" && r.stale ? "FAILED" : r.status;
  if (status !== "READY") return { searchId: r.id, origin: "web", status, candidates: [], quantity: null };
  const parsed = SupplierSearch.safeParse(r.search_json);
  if (!parsed.success) return { searchId: r.id, origin: "web", status: "FAILED", candidates: [], quantity: null };
  return { ...listOfSearch(parsed.data), searchId: r.id, status };
}

function catalogList(r: ListRow): CandidateList {
  const parsed = r.status === "READY" ? Shortlist.safeParse(r.result_json) : undefined;
  const candidates = parsed?.success ? parsed.data.candidates.map((c) => ({ supplierId: c.supplierId, rank: c.rank, landedCostMinor: null })) : [];
  return { searchId: r.id, origin: "catalog", status: parsed && !parsed.success ? "FAILED" : r.status, candidates, quantity: null };
}

/** The facility's newest supplier list (web search or catalog shortlist). */
export async function latestList(q: Q, scope: Scope): Promise<CandidateList | null> {
  const r = await one<ListRow>(
    q,
    `select id, source, status, search_json, result_json, created_at < now() - make_interval(secs => $2) as stale
       from shortlists where facility_id = $1 order by created_at desc, id desc limit 1`,
    [scope.facilityId, STALE_SEARCH_SECONDS],
  );
  if (!r) return null;
  return r.source === "web" ? webList(r) : catalogList(r);
}

async function planFacts(q: Q, scope: Scope, sessionDraftId: string | null): Promise<{ draftId: string | null; planStatus: PlanStatus | null }> {
  const committed = await one<{ draft_id: string | null }>(q, "select draft_id from plans where facility_id = $1 and status = 'COMMITTED' order by version desc limit 1", [scope.facilityId]);
  if (committed) return { draftId: committed.draft_id ?? sessionDraftId, planStatus: "COMMITTED" };
  const latest = await one<{ draft_id: string | null; status: PlanStatus }>(
    q,
    "select draft_id, status from plans where facility_id = $1 order by version desc, created_at desc limit 1",
    [scope.facilityId],
  );
  if (latest && (sessionDraftId === null || latest.draft_id === sessionDraftId)) return { draftId: latest.draft_id ?? sessionDraftId, planStatus: latest.status };
  return { draftId: sessionDraftId, planStatus: null };
}

async function founderKeyActive(q: Q, scope: Scope): Promise<boolean> {
  const f = await one<{ key_status: string }>(q, "select key_status from founders where facility_id = $1 and id = $2", [scope.facilityId, scope.founderId]);
  return f?.key_status === "REGISTERED";
}

/** The first of the session's saved termsIds (latest save first) that the facility has; none saved → null. */
async function termsFacts(q: Q, scope: Scope, termsIds: readonly string[]): Promise<{ termsId: string; supplierId: string; status: TermsStatus; orderId: string | null } | null> {
  if (termsIds.length === 0) return null;
  const found = await rows<{ id: string; supplier_id: string; status: TermsStatus; order_id: string | null }>(
    q,
    "select id, supplier_id, status, order_id from supplier_terms where facility_id = $1 and id = any($2::text[])",
    [scope.facilityId, [...termsIds]],
  );
  const byId = new Map(found.map((r) => [r.id, r]));
  const r = termsIds.map((id) => byId.get(id)).find((x) => x !== undefined);
  return r ? { termsId: r.id, supplierId: r.supplier_id, status: r.status, orderId: r.order_id } : null;
}

const iso = (unixSeconds: bigint): string => new Date(Number(unixSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The founder's release of the order's held milestone is recorded: a RELEASE_MILESTONE row (founder-payments' commit)
 * for the first milestone needing her release that is not released yet, unless it failed (routes/suppliers.ts's rule).
 */
const RELEASE_SIGNED = `exists (
    select 1 from payments r where r.facility_id = o.facility_id and r.kind = 'RELEASE_MILESTONE' and r.order_id = o.order_id
       and r.state not in ('POLICY_DENIED', 'REVERTED', 'CANCELLED')
       and r.milestone_idx = (select min(m.idx) from escrow_milestones m
                               where m.facility_id = o.facility_id and m.order_id = o.order_id and not m.auto_release and m.released_minor = 0))`;

interface OrderRow {
  order_id: string;
  supplier_id: string;
  payee_status: string | null;
  cooling_until: string | null;
  first_released: string | null;
  all_released: boolean | null;
  release_signed: boolean | null;
}

async function orderFacts(deps: ApiDeps, q: Q, scope: Scope, orderId: string): Promise<{ order: JourneyFacts["order"]; now: string | null }> {
  const o = await one<OrderRow>(
    q,
    `select o.order_id, o.supplier_id, p.status as payee_status, p.cooling_until::text as cooling_until,
            (select released_minor::text from escrow_milestones m where m.facility_id = o.facility_id and m.order_id = o.order_id and m.idx = 0) as first_released,
            (select bool_and(m.released_minor > 0) from escrow_milestones m where m.facility_id = o.facility_id and m.order_id = o.order_id) as all_released,
            ${RELEASE_SIGNED} as release_signed
       from escrow_orders o left join payees p on p.facility_id = o.facility_id and p.id = o.payee_id
      where o.facility_id = $1 and o.order_id = $2`,
    [scope.facilityId, orderId],
  );
  if (!o) return { order: null, now: null };
  const bound = o.payee_status === "COOLING" || o.payee_status === "BOUND";
  let now: string | null = null;
  try {
    now = iso(await chainNow(deps));
  } catch {
    deps.log.warn("journey_chain_time_unavailable", { orderId });
  }
  return {
    order: {
      orderId: o.order_id as NonNullable<JourneyFacts["order"]>["orderId"],
      supplierId: o.supplier_id,
      bound,
      coolingEndsAt: bound && o.cooling_until ? iso(BigInt(o.cooling_until)) : null,
      firstPaid: BigInt(o.first_released ?? "0") > 0n,
      // UX-PLAN D35: every milestone released (no milestones reads false: bool_and over none is null).
      balancePaid: o.all_released === true,
      releaseSigned: o.release_signed === true,
      ...(o.payee_status === "CANCELLED" ? { bindFailed: true } : {}),
    },
    now,
  };
}

/** Treasury.paused() at the head (what GET /api/balances shows); unreadable → UPSTREAM, never "not paused". */
async function treasuryPaused(deps: ApiDeps): Promise<boolean> {
  try {
    return await deps.client.readContract({ address: deps.deployment.contracts.Treasury.address, abi: iTreasuryAbi, functionName: "paused" });
  } catch (error: unknown) {
    deps.log.warn("journey_paused_unavailable", { error });
    throw fail("UPSTREAM", "The chain node could not be read; try again shortly");
  }
}

/** What Postgres and the chain say, before the session's history is applied. */
export async function sourceFacts(deps: ApiDeps, q: Q, scope: Scope, persona: Persona, history: JourneyHistory): Promise<SourceFacts> {
  const [plan, keyActive, list, terms] = await Promise.all([
    planFacts(q, scope, history.latestDraftId),
    founderKeyActive(q, scope),
    latestList(q, scope),
    termsFacts(q, scope, termsIdsNewestFirst(history)),
  ]);
  const [order, paused] = await Promise.all([
    terms?.status === "USED" && terms.orderId ? orderFacts(deps, q, scope, terms.orderId) : Promise.resolve({ order: null, now: null }),
    plan.planStatus === "COMMITTED" ? treasuryPaused(deps) : Promise.resolve(false),
  ]);
  return {
    facilityId: scope.facilityId,
    persona,
    now: order.now ?? iso(BigInt(Math.floor(deps.clock() / 1000))),
    ...plan,
    founderKeyActive: keyActive,
    list,
    terms: terms ? { termsId: terms.termsId, supplierId: terms.supplierId, status: terms.status } : null,
    order: order.order,
    paused,
  };
}

/**
 * The session's JourneyFacts and the list behind them (the effects check picks and ranks against it). `messages` is
 * the session's history projection (loadHistoryParts), plus the press being answered when it is not stored yet.
 */
export async function journeyView(deps: ApiDeps, q: Q, scope: Scope, persona: Persona, messages: readonly HistoryMessage[]) {
  const history = readHistory(messages);
  const src = await sourceFacts(deps, q, scope, persona, history);
  return { facts: journeyFactsOf(src, history), list: src.list, history };
}

export async function journeyFacts(deps: ApiDeps, scope: Scope, sessionId: string, persona: Persona): Promise<JourneyFacts> {
  const q = pool(deps.db);
  return (await journeyView(deps, q, scope, persona, await loadHistoryParts(q, scope, sessionId))).facts;
}
