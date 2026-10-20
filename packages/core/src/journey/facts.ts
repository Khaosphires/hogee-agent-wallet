/**
 * JourneyFacts from what live and mock read (VISION-DECISIONS §3, §7): each side reads its own store (Postgres and the
 * chain mirror, or the mock's memory) into a SourceFacts, and this one function turns that plus the session's history
 * into JourneyFacts, so both derive the same stage. The candidate list helpers resolve "#2" and check that a picked or
 * named supplier is really in the latest list; nothing outside the list is ever accepted.
 */
import type { JourneyFacts } from "../schemas/journey";
import type { PlanStatus, Persona, SearchStatus, SupplierOrigin, TermsStatus } from "../schemas/enums";
import type { SupplierId } from "../schemas/primitives";
import type { SupplierSearch } from "../schemas/search";
import { effectFailed, effectOk, type Outcome } from "./effects";
import type { JourneyHistory } from "./history";

export interface ListCandidate {
  readonly supplierId: SupplierId;
  readonly rank: number | null;
  /** The candidate's landed cost at the search quantity (minor units), when the list prices it. */
  readonly landedCostMinor: string | null;
}

/** The latest supplier list: a web search or the catalog shortlist. */
export interface CandidateList {
  readonly searchId: string;
  readonly origin: SupplierOrigin;
  readonly status: SearchStatus;
  readonly candidates: readonly ListCandidate[];
  /** The quantity the list was priced for (web searches), else null. */
  readonly quantity: number | null;
}

export const listOfSearch = (s: SupplierSearch): CandidateList => ({
  searchId: s.searchId,
  origin: "web",
  status: s.status,
  candidates: s.status === "READY" ? s.candidates.map((c) => ({ supplierId: c.supplierId, rank: c.rank, landedCostMinor: c.landedCostMinor })) : [],
  quantity: s.quantity,
});

/** What a store says about the founder, before the session's history is applied. */
export interface SourceFacts {
  readonly facilityId: string;
  readonly persona: Persona;
  readonly now: string;
  readonly draftId: string | null;
  readonly planStatus: PlanStatus | null;
  readonly founderKeyActive: boolean;
  readonly list: CandidateList | null;
  readonly terms: { readonly termsId: string; readonly supplierId: SupplierId; readonly status: TermsStatus } | null;
  readonly order: JourneyFacts["order"];
  /** Treasury.paused(), as GET /api/balances shows it (rcfix-journey A-7). */
  readonly paused: boolean;
}

const rankOf = (list: CandidateList, supplierId: string): number | null => list.candidates.find((c) => c.supplierId === supplierId)?.rank ?? null;

export function journeyFactsOf(src: SourceFacts, history: JourneyHistory): JourneyFacts {
  const list = src.list;
  const pick = history.lastPick;
  const picked = list && list.origin === "web" && list.status === "READY" && pick?.searchId === list.searchId ? pick.supplierIds.filter((id) => list.candidates.some((c) => c.supplierId === id)) : [];
  const open = history.openTermsSupplierId;
  const termsDraft = open && list?.candidates.some((c) => c.supplierId === open) ? { supplierId: open } : null;
  return {
    facilityId: src.facilityId,
    persona: src.persona,
    draftId: src.draftId,
    planStatus: src.planStatus,
    founderKeyActive: src.founderKeyActive,
    search: list ? { searchId: list.searchId, status: list.status, origin: list.origin } : null,
    pickedSupplierIds: picked,
    ...(list && picked.length > 0 ? { pickedRanks: picked.map((id) => rankOf(list, id)) } : {}),
    termsDraft,
    terms: src.terms,
    order: src.order,
    paused: src.paused === true,
    now: src.now,
  };
}

/** "#2 and #4" → the supplier ids, in the order named; any rank not in the list → NOT_FOUND. */
export function resolveRanks(list: CandidateList | null, ranks: readonly number[]): Outcome<{ readonly supplierIds: readonly SupplierId[]; readonly ranks: readonly number[] }> {
  if (!list || list.status !== "READY" || list.origin !== "web") return effectFailed("NOT_FOUND");
  const ids = ranks.map((r) => list.candidates.find((c) => c.rank === r)?.supplierId);
  if (ids.some((id) => id === undefined)) return effectFailed("NOT_FOUND");
  return effectOk({ supplierIds: ids as SupplierId[], ranks: [...ranks] });
}

/** A supplier named by id or rank, if it is a candidate of the READY web list `searchId`. */
export function resolveCandidate(list: CandidateList | null, searchId: string, target: { readonly supplierId: string } | { readonly rank: number }): Outcome<ListCandidate> {
  if (!list || list.searchId !== searchId || list.status !== "READY" || list.origin !== "web") return effectFailed("NOT_FOUND");
  const c = "rank" in target ? list.candidates.find((x) => x.rank === target.rank) : list.candidates.find((x) => x.supplierId === target.supplierId);
  return c ? effectOk(c) : effectFailed("NOT_FOUND");
}

/** Every id is a candidate of the READY web list `searchId`. */
export function allCandidates(list: CandidateList | null, searchId: string, supplierIds: readonly string[]): boolean {
  if (!list || list.searchId !== searchId || list.status !== "READY" || list.origin !== "web") return false;
  return supplierIds.every((id) => list.candidates.some((c) => c.supplierId === id));
}

/** The total the preset check estimates with: the listed landed cost, capped by what the pocket has free (whole BU). */
export function estimateTotalMinor(candidate: ListCandidate, freeMinor: bigint): bigint {
  const listed = candidate.landedCostMinor !== null ? BigInt(candidate.landedCostMinor) : freeMinor;
  const total = listed < freeMinor ? listed : freeMinor;
  return total - (total % 100n);
}
