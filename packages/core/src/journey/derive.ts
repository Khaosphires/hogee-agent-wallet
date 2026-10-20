/**
 * The journey stage from facts only (VISION-DECISIONS §3; plan §2 "journey logic is shared in core"). Pure: the live
 * API and the mock each build JourneyFacts and both call this, so they derive the same stage.
 *
 * Most advanced first:
 *   - an order: not yet bound → ORDER_PENDING; bound and cooling not over → COOLING; else OPERATING. Terms already
 *     USED without the order in the facts read as ORDER_PENDING (the order row is written with them). An order whose
 *     binding failed (`bindFailed`: the worker cancelled its payee) is no order: the stages below apply;
 *   - before the plan is COMMITTED: SUBMITTED → PLAN_PENDING; no draft → INTAKE; a draft (PENDING_SIGNATURE, REVERTED,
 *     SUPERSEDED or none yet) → NEEDS_REVIEW with an active founder key, else FOUNDER_KEY_PENDING;
 *   - committed: an open terms pre-fill → TERMS_DRAFT; CONFIRMED terms → TERMS_CONFIRMED; picked suppliers of a READY
 *     search → PICKED; a PENDING search → SEARCHING; a READY one → CANDIDATES; otherwise (no search, or it FAILED)
 *     PLAN_ACTIVE.
 * The facts are parsed first: anything malformed throws (fail closed), it never derives a stage.
 */
import type { JourneyStage } from "../schemas/enums";
import { JourneyFacts, type JourneyState } from "../schemas/journey";

function beforeCommit(f: JourneyFacts): JourneyStage {
  if (f.planStatus === "SUBMITTED") return "PLAN_PENDING";
  if (f.draftId === null) return "INTAKE";
  return f.founderKeyActive ? "NEEDS_REVIEW" : "FOUNDER_KEY_PENDING";
}

function orderStage(order: NonNullable<JourneyFacts["order"]>, now: string): JourneyStage {
  if (!order.bound) return "ORDER_PENDING";
  if (order.coolingEndsAt !== null && Date.parse(now) < Date.parse(order.coolingEndsAt)) return "COOLING";
  return "OPERATING";
}

export function stageOf(f: JourneyFacts): JourneyStage {
  const bindFailed = f.order?.bindFailed === true;
  if (f.order && !bindFailed) return orderStage(f.order, f.now);
  if (f.terms?.status === "USED" && !bindFailed) return "ORDER_PENDING";
  if (f.planStatus !== "COMMITTED") return beforeCommit(f);
  if (f.termsDraft) return "TERMS_DRAFT";
  if (f.terms?.status === "CONFIRMED") return "TERMS_CONFIRMED";
  if (f.search?.status === "READY" && f.pickedSupplierIds.length > 0) return "PICKED";
  if (f.search?.status === "PENDING") return "SEARCHING";
  if (f.search?.status === "READY") return "CANDIDATES";
  return "PLAN_ACTIVE";
}

export function deriveJourney(facts: JourneyFacts): JourneyState {
  const f = JourneyFacts.parse(facts);
  return { stage: stageOf(f), facts: f };
}

/** Stages at or after a signed plan (the supplier and CFO steps are open from here). */
const AFTER_SIGNING: ReadonlySet<JourneyStage> = new Set([
  "PLAN_PENDING",
  "PLAN_ACTIVE",
  "SEARCHING",
  "CANDIDATES",
  "PICKED",
  "TERMS_DRAFT",
  "TERMS_CONFIRMED",
  "ORDER_PENDING",
  "COOLING",
  "OPERATING",
]);
export const planSigned = (stage: JourneyStage): boolean => AFTER_SIGNING.has(stage);

/** Stages with a signed supplier order (its terms can no longer change in chat). */
const ORDERED: ReadonlySet<JourneyStage> = new Set(["ORDER_PENDING", "COOLING", "OPERATING"]);
export const hasOrder = (stage: JourneyStage): boolean => ORDERED.has(stage);

/** Free text goes to the planner while the plan is being drafted; later it is classified (VISION-DECISIONS §9). */
export const plannerStage = (stage: JourneyStage): boolean => stage === "INTAKE" || stage === "NEEDS_REVIEW" || stage === "FOUNDER_KEY_PENDING";
