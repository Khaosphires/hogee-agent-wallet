/**
 * Runs the effects core asked for (core journey/effects.ts) against the live services and hands back outcomes. Every
 * id is re-checked here against the facility's own latest list; a refusal becomes a founder-facing failure reason,
 * never a raw error. Nothing here moves money or signs: the search and the catalog list go through their own services
 * (with their own limits), and the rest only reads.
 */
import {
  buildEnquiry,
  buildNeeds,
  effectFailed,
  effectOk,
  estimateTotalMinor,
  allCandidates,
  presetAvailability,
  resolveCandidate,
  resolveRanks,
  CurrencyCode,
  PlanIntent,
  PlanManifest,
  type CandidateList,
  type EffectOutcomes,
  type JourneyEffect,
  type JourneyFailure,
  type Persona,
  type ShortlistSpec,
  type TermsLimits,
} from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { ApiProblem } from "../http/problem";
import { supplierRoutes } from "../routes/suppliers";
import { loadDraft, packFor } from "../services/compile";
import { requireFacility } from "../services/facility";
import { committedPlanRow } from "../services/plans";
import { shortlistRow } from "../services/shortlist";
import { readSnapshot } from "../services/snapshot";
import { one, pool, type Q } from "../services/sql";
import { startWebSearch } from "../services/web-search";

/** The quantity a catalog list is priced for when no web search named one (v-search's default). */
export const DEFAULT_LIST_QUANTITY = 1000;
/** Client key of chat-started searches (v-search's per-session limit keys on persona and client). */
export const CHAT_CLIENT = "chat-action";

export interface EffectContext {
  readonly persona: Persona;
  /** The facility's latest supplier list (journey facts). */
  readonly list: CandidateList | null;
}

const REASONS: Readonly<Record<string, JourneyFailure>> = {
  NO_PLAN: "NO_PLAN",
  RATE_LIMITED: "BUSY",
  IN_FLIGHT: "BUSY",
  BUDGET: "BUDGET",
  MODEL_BUDGET_EXHAUSTED: "BUDGET",
};

/** A refusal in founder terms: the reason a service gave, else UNAVAILABLE (logged without its message). */
function reasonOf(deps: ApiDeps, effect: string, e: unknown): JourneyFailure {
  const reason = e instanceof ApiProblem ? e.failure.details?.reason : undefined;
  const mapped = typeof reason === "string" ? REASONS[reason] : undefined;
  if (!mapped) deps.log.warn("journey_effect_failed", { effect, code: e instanceof ApiProblem ? e.failure.code : "ERROR", reason: typeof reason === "string" ? reason : null });
  return mapped ?? "UNAVAILABLE";
}

async function committedPlan(q: Q, scope: Scope): Promise<{ manifest: PlanManifest; intent: PlanIntent } | null> {
  const row = await committedPlanRow(q, scope);
  if (!row?.draft_id) return null;
  const d = await one<{ intent_json: unknown }>(q, "select intent_json from plan_drafts where facility_id = $1 and id = $2", [scope.facilityId, row.draft_id]);
  const intent = PlanIntent.safeParse(d?.intent_json);
  const manifest = PlanManifest.safeParse(row.manifest_json);
  return intent.success && manifest.success ? { manifest: manifest.data, intent: intent.data } : null;
}

/** The SUPPLIER pocket's limits now (chain snapshot), as termsToSchedule reads them. */
export async function supplierLimits(deps: ApiDeps, manifest: PlanManifest): Promise<TermsLimits> {
  const lineId = manifest.lines.find((l) => l.lineKey === "SUPPLIER")?.lineId;
  if (!lineId) throw new Error("the committed plan has no SUPPLIER line");
  const s = await readSnapshot(deps);
  const view = s.lines.find((l) => l.lineId.toLowerCase() === lineId.toLowerCase());
  if (!view) throw new Error("the SUPPLIER line is not on-chain");
  const left = view.pocket.windowCapMinor - view.pocket.windowSpentMinor;
  return { freeMinor: view.pocket.availableMinor, perTxCapMinor: view.pocket.perTxCapMinor, windowCapMinor: left > 0n ? left : 0n };
}

async function startSearch(deps: ApiDeps, scope: Scope, ctx: EffectContext, quantity?: number): Promise<EffectOutcomes["search"]> {
  try {
    const r = await startWebSearch(deps, scope, quantity !== undefined ? { quantity } : {}, { persona: ctx.persona, client: CHAT_CLIENT });
    return effectOk({ searchId: r.searchId });
  } catch (e: unknown) {
    return effectFailed(reasonOf(deps, "START_SEARCH", e));
  }
}

/** The labelled demo catalog shortlist, through the existing route logic (its reuse window and writer bounds). */
async function useCatalog(deps: ApiDeps, scope: Scope, ctx: EffectContext): Promise<EffectOutcomes["catalog"]> {
  try {
    const plan = await committedPlan(pool(deps.db), scope);
    if (!plan) return effectFailed("NO_PLAN");
    const supplier = plan.manifest.lines.find((l) => l.lineKey === "SUPPLIER");
    if (!supplier) return effectFailed("UNAVAILABLE");
    const quantity = ctx.list?.quantity ?? DEFAULT_LIST_QUANTITY;
    const spec: ShortlistSpec = { productCategory: plan.intent.productCategory, buyFrom: plan.intent.buyFrom, quantity, budgetMinor: supplier.amountMinor };
    const handler = supplierRoutes.shortlistSuppliers;
    if (!handler) return effectFailed("UNAVAILABLE");
    const res = (await handler({ req: { body: { spec } }, deps, scope } as never)) as { requestId: string };
    const row = await shortlistRow(pool(deps.db), scope, res.requestId);
    return effectOk({ requestId: res.requestId, status: row?.status ?? "PENDING" });
  } catch (e: unknown) {
    return effectFailed(reasonOf(deps, "USE_CATALOG", e));
  }
}

async function needs(deps: ApiDeps, scope: Scope, draftId: string): Promise<EffectOutcomes["needs"]> {
  try {
    const q = pool(deps.db);
    const [facility, stored] = await Promise.all([requireFacility(q, scope), loadDraft(q, scope, draftId)]);
    if (!stored || stored.preview) return effectFailed("NOT_FOUND");
    const pack = await packFor(deps, stored.draft.manifest.countryCode);
    return effectOk(buildNeeds(stored.draft, pack, { reserveFloorBps: Number(facility.reserve_floor_bps) }));
  } catch (e: unknown) {
    return effectFailed(reasonOf(deps, "NEEDS", e));
  }
}

async function enquiry(deps: ApiDeps, scope: Scope, ctx: EffectContext, searchId: string, supplierIds: readonly string[]): Promise<EffectOutcomes["enquiry"]> {
  if (!allCandidates(ctx.list, searchId, supplierIds)) return effectFailed("NOT_FOUND");
  try {
    const q = pool(deps.db);
    const [plan, facility] = await Promise.all([committedPlan(q, scope), requireFacility(q, scope)]);
    if (!plan) return effectFailed("NO_PLAN");
    const quantity = ctx.list?.quantity ?? DEFAULT_LIST_QUANTITY;
    return effectOk(buildEnquiry({ supplierIds, productCategory: plan.intent.productCategory, quantity, currency: CurrencyCode.parse(facility.currency) }));
  } catch (e: unknown) {
    return effectFailed(reasonOf(deps, "ENQUIRY", e));
  }
}

async function prefill(deps: ApiDeps, scope: Scope, ctx: EffectContext, effect: Extract<JourneyEffect, { kind: "TERMS_PREFILL" }>): Promise<EffectOutcomes["prefill"]> {
  const c = resolveCandidate(ctx.list, effect.searchId, effect.supplier);
  if (!c.ok) return effectFailed(c.reason);
  try {
    const plan = await committedPlan(pool(deps.db), scope);
    if (!plan) return effectFailed("NO_PLAN");
    const limits = await supplierLimits(deps, plan.manifest);
    const availability = presetAvailability(estimateTotalMinor(c.value, limits.freeMinor), limits, "web");
    return effectOk({ supplierId: c.value.supplierId, availability });
  } catch (e: unknown) {
    // The limits could not be read: offer the form with no preset marked as fitting (the submit re-checks anyway).
    deps.log.warn("journey_limits_unavailable", { code: e instanceof ApiProblem ? e.failure.code : "ERROR" });
    return effectOk({ supplierId: c.value.supplierId, availability: [] });
  }
}

/** Runs each effect in order; one outcome per kind. */
export async function runEffects(deps: ApiDeps, scope: Scope, ctx: EffectContext, effects: readonly JourneyEffect[]): Promise<EffectOutcomes> {
  let out: EffectOutcomes = {};
  for (const e of effects) {
    switch (e.kind) {
      case "START_SEARCH":
        out = { ...out, search: await startSearch(deps, scope, ctx, e.quantity) };
        break;
      case "USE_CATALOG":
        out = { ...out, catalog: await useCatalog(deps, scope, ctx) };
        break;
      case "NEEDS":
        out = { ...out, needs: await needs(deps, scope, e.draftId) };
        break;
      case "ENQUIRY":
        out = { ...out, enquiry: await enquiry(deps, scope, ctx, e.searchId, e.supplierIds) };
        break;
      case "RESOLVE_RANKS":
        out = { ...out, ranks: ctx.list?.searchId === e.searchId ? resolveRanks(ctx.list, e.ranks) : effectFailed("NOT_FOUND") };
        break;
      case "TERMS_PREFILL":
        out = { ...out, prefill: await prefill(deps, scope, ctx, e) };
        break;
    }
  }
  return out;
}
