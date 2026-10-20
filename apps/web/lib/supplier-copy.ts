/** Plain-English labels for supplier gates and scoring criteria (project.md §11). */
import type { SupplierCriterion, SupplierGate } from "@hogee/core";

export const GATE_COPY: Record<SupplierGate, { pass: string; fail: string }> = {
  NO_ESCROW: { pass: "Agrees to be paid in steps, held until delivery", fail: "Won't accept payment held until delivery" },
  PERSONAL_PAYEE: { pass: "Gets paid into a company account", fail: "Wants payment to a personal account" },
  MISSING_CERT: { pass: "Has the safety certificate needed", fail: "The safety certificate needed is missing" },
  OFF_PLATFORM_DISCOUNT: { pass: "Doesn't ask you to pay outside the marketplace", fail: "Offers a discount if you pay outside the marketplace (a common scam)" },
  AI_INJECTION: { pass: "No hidden instructions for AI on the page", fail: "The page has hidden instructions for AI" },
  OVER_MOQ: { pass: "Minimum order fits your plan's budget", fail: "The minimum order or price doesn't fit your plan's budget" },
  SANCTIONS: { pass: "Not on any banned-companies list", fail: "On a banned-companies list (sanctions)" },
};

export const CRITERION_LABEL: Record<SupplierCriterion, string> = {
  landed_cost: "Delivered cost",
  quality_evidence: "Proof of quality",
  trust_verification: "Trust checks",
  lead_time: "Delivery time",
  compliance: "Follows the rules",
  terms: "Payment terms",
  communication: "Communication",
};

/** Where the UI keeps the shortlist the planner started (chat → suppliers). */
export const SHORTLIST_KEY = "hogee.shortlist.requestId";

export function storedShortlistId(): string | undefined {
  try {
    return window.localStorage.getItem(SHORTLIST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeShortlistId(id: string): void {
  try {
    window.localStorage.setItem(SHORTLIST_KEY, id);
  } catch {
    // Storage unavailable: the shortlist stays for this page view.
  }
}

export function clearShortlistId(): void {
  try {
    window.localStorage.removeItem(SHORTLIST_KEY);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}
