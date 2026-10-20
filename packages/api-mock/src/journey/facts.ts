/**
 * The mock's SourceFacts (core journey/facts.ts) from the in-memory store: the same facts the live API reads from
 * Postgres and the chain, so core derives the same stage. The latest list and the latest saved terms are found through
 * the session's history and read back through the feature handlers (v-search's getSupplierSearch, v-terms'
 * getOrderTerms), so the journey sees exactly what their cards see. An answer for another id than the one asked for
 * (a stub serving the contract example) counts as nothing (fail closed).
 *
 * rcfix-journey: `paused` is the store's Treasury pause (what GET /api/balances shows), once the plan is committed, as
 * live (A-7); the order's `releaseSigned` is a submitted MilestoneRelease of that order whose signed milestone the store
 * released (the mock applies a release at submit, so this is its RELEASE_MILESTONE row for that order/idx, A-6).
 */
import {
  OrderTerms,
  Shortlist,
  SupplierSearch,
  listOfSearch,
  termsIdsNewestFirst,
  type CandidateList,
  type EscrowSchedule,
  type JourneyHistory,
  type Persona,
  type SourceFacts,
} from "@hogee/core";
import type { MockEnv } from "../env";
import { orderHandlers } from "../features/orders";
import { searchHandlers } from "../features/search";
import { isFailure } from "../result";
import { currentPlan, founderKeyActive, nowIso, type MockState } from "../store";

/** Calls a feature handler the way the HTTP layer would (the journey has no hono Context; the handlers do not use it). */
export async function callHandler(handler: (ctx: never) => unknown, st: MockState, env: MockEnv, persona: Persona, req: unknown): Promise<unknown> {
  return (handler as (ctx: unknown) => unknown)({ req, st, env, persona, c: undefined });
}

async function webList(st: MockState, env: MockEnv, persona: Persona, searchId: string): Promise<CandidateList | null> {
  const out = await callHandler(searchHandlers.getSupplierSearch, st, env, persona, { params: { id: searchId } });
  if (isFailure(out) || out instanceof Response) return null;
  const parsed = SupplierSearch.safeParse(out);
  if (!parsed.success || parsed.data.searchId !== searchId) return null;
  return listOfSearch(parsed.data);
}

function catalogList(st: MockState, requestId: string): CandidateList | null {
  const job = st.shortlists.get(requestId);
  const parsed = job ? Shortlist.safeParse(job.shortlist) : undefined;
  if (!parsed?.success) return null;
  const s = parsed.data;
  return { searchId: requestId, origin: "catalog", status: s.status, candidates: s.candidates.map((c) => ({ supplierId: c.supplierId, rank: c.rank, landedCostMinor: null })), quantity: null };
}

/** A submitted MilestoneRelease of `orderId` names a held milestone the store has released (its signed idx). */
function releaseSigned(st: MockState, orderId: string, milestones: EscrowSchedule): boolean {
  const released = new Set(milestones.filter((m) => !m.autoRelease && m.released).map((m) => String(m.idx)));
  return [...st.signatures.values()].some((r) => r.submitted && r.body.kind === "MilestoneRelease" && r.body.refId === orderId && released.has(String(r.response.typedData.message.idx)));
}

/** The session's own terms: of its saved termsIds (latest save first), the first the store knows, as live; and their order. */
async function termsAndOrder(st: MockState, env: MockEnv, persona: Persona, history: JourneyHistory): Promise<Pick<SourceFacts, "terms" | "order">> {
  for (const termsId of termsIdsNewestFirst(history)) {
    const out = await callHandler(orderHandlers.getOrderTerms, st, env, persona, { params: { id: termsId } });
    if (isFailure(out) || out instanceof Response) continue;
    const parsed = OrderTerms.safeParse(out);
    if (!parsed.success || parsed.data.termsId !== termsId) continue;
    const t = parsed.data;
    const terms = { termsId: t.termsId, supplierId: t.supplierId, status: t.status };
    if (t.status !== "USED" || !t.orderId) return { terms, order: null };
    const milestones = st.escrow.get(t.orderId) ?? [];
    const firstPaid = milestones[0]?.released ?? false;
    // UX-PLAN D35: every milestone released, so the order is complete (as live: all escrow_milestones released).
    const balancePaid = milestones.length > 0 && milestones.every((m) => m.released);
    return {
      terms,
      order: { orderId: t.orderId, supplierId: t.supplierId, bound: t.coolingEndsAt !== null, coolingEndsAt: t.coolingEndsAt, firstPaid, balancePaid, releaseSigned: releaseSigned(st, t.orderId, milestones) },
    };
  }
  return { terms: null, order: null };
}

export async function mockSourceFacts(st: MockState, env: MockEnv, persona: Persona, history: JourneyHistory): Promise<SourceFacts> {
  const plan = currentPlan(st);
  const seededDraft = st.loaded.scenario["plan-draft.json"].draftId;
  const draftId = history.latestDraftId ?? (plan ? seededDraft : null);
  const latest = history.latestList;
  const list = latest === null ? null : latest.origin === "web" ? await webList(st, env, persona, latest.id) : catalogList(st, latest.id);
  return {
    facilityId: st.facility.facilityId,
    persona,
    now: nowIso(),
    draftId,
    planStatus: plan?.status ?? null,
    founderKeyActive: founderKeyActive(st),
    list,
    ...(await termsAndOrder(st, env, persona, history)),
    paused: plan?.status === "COMMITTED" && st.balances.paused,
  };
}
