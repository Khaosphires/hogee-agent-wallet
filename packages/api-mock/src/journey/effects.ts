/**
 * Runs core's journey effects against the mock (the live counterpart is packages/api/src/journey/effects.ts): the
 * search and the catalog list through their mock handlers (v-search's, the existing shortlist), the enquiry through
 * core buildEnquiry, ranks and terms checks through core's list helpers, the preset checks over the store's SUPPLIER
 * pocket. Every id is re-checked against the latest list.
 * The needs card is core buildNeeds over a really compiled plan and the data/ country pack (./needs.ts).
 */
import {
  allCandidates,
  buildEnquiry,
  effectFailed,
  effectOk,
  estimateTotalMinor,
  presetAvailability,
  resolveCandidate,
  resolveRanks,
  type CandidateList,
  type EffectOutcomes,
  type JourneyEffect,
  type JourneyFailure,
  type Persona,
} from "@hogee/core";
import type { MockEnv } from "../env";
import { searchHandlers } from "../features/search";
import { coreHandlers } from "../handlers-core";
import { isFailure } from "../result";
import { currentPlan, type MockState } from "../store";
import { callHandler } from "./facts";
import { mockNeeds } from "./needs";

/** The quantity a list is priced for when no web search named one (v-search's default). */
const DEFAULT_LIST_QUANTITY = 1000;

const REASONS: Readonly<Record<string, JourneyFailure>> = { NO_PLAN: "NO_PLAN", RATE_LIMITED: "BUSY", IN_FLIGHT: "BUSY", BUDGET: "BUDGET" };
const reasonOf = (out: unknown): JourneyFailure => {
  const reason = isFailure(out) ? out.details?.reason : undefined;
  return (typeof reason === "string" ? REASONS[reason] : undefined) ?? "UNAVAILABLE";
};

export interface MockEffectContext {
  readonly st: MockState;
  readonly env: MockEnv;
  readonly persona: Persona;
  readonly list: CandidateList | null;
}

async function startSearch(x: MockEffectContext, quantity?: number): Promise<EffectOutcomes["search"]> {
  try {
    const out = await callHandler(searchHandlers.startSupplierSearch, x.st, x.env, x.persona, { body: quantity !== undefined ? { quantity } : {} });
    if (isFailure(out)) return effectFailed(reasonOf(out));
    const searchId = (out as { searchId?: unknown }).searchId;
    return typeof searchId === "string" ? effectOk({ searchId }) : effectFailed("UNAVAILABLE");
  } catch {
    return effectFailed("UNAVAILABLE");
  }
}

async function useCatalog(x: MockEffectContext): Promise<EffectOutcomes["catalog"]> {
  const plan = currentPlan(x.st);
  const draft = x.st.loaded.scenario["plan-draft.json"];
  const supplier = plan?.manifest.lines.find((l) => l.lineKey === "SUPPLIER");
  if (!plan || plan.status !== "COMMITTED" || !supplier) return effectFailed("NO_PLAN");
  const spec = { productCategory: draft.intent.productCategory, buyFrom: draft.intent.buyFrom, quantity: x.list?.quantity ?? DEFAULT_LIST_QUANTITY, budgetMinor: supplier.amountMinor };
  const out = await callHandler(coreHandlers.shortlistSuppliers, x.st, x.env, x.persona, { body: { spec } });
  if (isFailure(out)) return effectFailed(reasonOf(out));
  const requestId = (out as { requestId: string }).requestId;
  return effectOk({ requestId, status: x.st.shortlists.get(requestId)?.shortlist.status ?? "PENDING" });
}

function enquiry(x: MockEffectContext, searchId: string, supplierIds: readonly string[]): EffectOutcomes["enquiry"] {
  if (!allCandidates(x.list, searchId, supplierIds)) return effectFailed("NOT_FOUND");
  try {
    const intent = x.st.loaded.scenario["plan-draft.json"].intent;
    return effectOk(buildEnquiry({ supplierIds, productCategory: intent.productCategory, quantity: x.list?.quantity ?? DEFAULT_LIST_QUANTITY, currency: x.st.facility.currency }));
  } catch {
    return effectFailed("UNAVAILABLE");
  }
}

function prefill(x: MockEffectContext, effect: Extract<JourneyEffect, { kind: "TERMS_PREFILL" }>): EffectOutcomes["prefill"] {
  const c = resolveCandidate(x.list, effect.searchId, effect.supplier);
  if (!c.ok) return effectFailed(c.reason);
  const pocket = x.st.balances.pockets.find((p) => p.lineKey === "SUPPLIER");
  if (!pocket) return effectOk({ supplierId: c.value.supplierId, availability: [] });
  const left = BigInt(pocket.windowCap) - BigInt(pocket.windowSpent);
  const limits = { freeMinor: BigInt(pocket.available), perTxCapMinor: BigInt(pocket.perTxCap), windowCapMinor: left > 0n ? left : 0n };
  return effectOk({ supplierId: c.value.supplierId, availability: presetAvailability(estimateTotalMinor(c.value, limits.freeMinor), limits, "web") });
}

/** As live: the stored draft's checklist; an unknown draft is NOT_FOUND, one the mock cannot vouch for UNAVAILABLE. */
function needs(x: MockEffectContext, draftId: string): EffectOutcomes["needs"] {
  const draft = x.st.drafts.get(draftId);
  if (!draft) return effectFailed("NOT_FOUND");
  const checklist = mockNeeds(x.st, x.env, draft);
  return checklist ? effectOk(checklist) : effectFailed("UNAVAILABLE");
}

export async function runMockEffects(x: MockEffectContext, effects: readonly JourneyEffect[]): Promise<EffectOutcomes> {
  let out: EffectOutcomes = {};
  for (const e of effects) {
    switch (e.kind) {
      case "START_SEARCH":
        out = { ...out, search: await startSearch(x, e.quantity) };
        break;
      case "USE_CATALOG":
        out = { ...out, catalog: await useCatalog(x) };
        break;
      case "NEEDS":
        out = { ...out, needs: needs(x, e.draftId) };
        break;
      case "ENQUIRY":
        out = { ...out, enquiry: enquiry(x, e.searchId, e.supplierIds) };
        break;
      case "RESOLVE_RANKS":
        out = { ...out, ranks: x.list?.searchId === e.searchId ? resolveRanks(x.list, e.ranks) : effectFailed("NOT_FOUND") };
        break;
      case "TERMS_PREFILL":
        out = { ...out, prefill: prefill(x, e) };
        break;
    }
  }
  return out;
}
