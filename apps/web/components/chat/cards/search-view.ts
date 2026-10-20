/**
 * Pure helpers for the search and candidates cards (search-card.tsx, candidates-card.tsx), testable without rendering:
 * the stage steps, the one-line status summary, the failure copy, the "left out" summaries, the listing link a card may
 * render and the BU figures. Every string here is founder-visible copy (the wording lint scans this folder). Web
 * strings (seller names) arrive already checked by the server ("(name hidden)" otherwise).
 */
import { isListingHost, type CandidateCard, type SearchFailure, type SearchOmitReason, type SearchStage, type SupplierGate, type SupplierSearch } from "@hogee/core";

export type StepState = "done" | "current" | "todo";

export interface SearchStep {
  readonly stage: SearchStage;
  readonly label: string;
  readonly state: StepState;
}

const STEPS: readonly { readonly stage: SearchStage; readonly label: string }[] = [
  { stage: "SEARCHING", label: "Searching the web" },
  { stage: "READING", label: "Reading pages" },
  { stage: "CHECKING", label: "Checking for problems" },
  { stage: "SCORING", label: "Ranking the best" },
];

/** The four pipeline steps with their state (all done once READY). */
export function searchSteps(s: Pick<SupplierSearch, "stage" | "status" | "sourcesFound">): SearchStep[] {
  const at = s.stage === "DONE" || s.status === "READY" ? STEPS.length : STEPS.findIndex((x) => x.stage === s.stage);
  return STEPS.map((x, i) => ({
    stage: x.stage,
    label: x.stage === "READING" && s.sourcesFound > 0 ? `${x.label} (${s.sourcesFound})` : x.label,
    state: i < at ? "done" : i === at ? (s.status === "FAILED" ? "todo" : "current") : "todo",
  }));
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const total = (xs: readonly { readonly count: number }[]): number => xs.reduce((n, x) => n + x.count, 0);

/** "Search finished · 10 pages found · 5 kept · 5 left out" (READY only). */
export function finishedSummary(s: SupplierSearch): string[] {
  const left = total(s.omitted) + total(s.excludedByGate);
  return ["Search finished", plural(s.sourcesFound, "page found", "pages found"), `${s.candidates.length.toLocaleString("en-US")} kept`, `${left.toLocaleString("en-US")} left out`];
}

export interface FailureCopy {
  readonly title: string;
  readonly body: string;
}

/** What didn't happen and why, per failure. Every one says nothing was paid or changed. */
export function failureCopy(f: SearchFailure | null): FailureCopy {
  const tail = "Nothing was paid or changed. You can try again, or use Hogee's sample supplier list.";
  switch (f) {
    case "PROVIDER_LIMIT":
      return { title: "The web search is busy", body: `The search service asked Hogee to slow down. ${tail}` };
    case "BUDGET":
      return { title: "Hogee can't read more pages right now", body: `It has read as many pages as it can today. ${tail}` };
    case "SANCTIONS_UNAVAILABLE":
      return {
        title: "The banned-companies check didn't run",
        body: `Hogee checks every supplier against government lists of banned companies (sanctions lists). It never shows one it couldn't check. ${tail}`,
      };
    case "NO_PLAN":
      return { title: "There is no signed plan yet", body: "Hogee searches for what your signed plan says you need. Sign the plan first. Nothing was paid or changed." };
    case "TOO_LARGE":
      return { title: "The search answer was too large to read safely", body: tail };
    default:
      return { title: "The web search didn't answer", body: tail };
  }
}

const GATE_REASON: { readonly [G in SupplierGate]: { readonly one: string; readonly many: string } } = {
  AI_INJECTION: { one: "it contained instructions aimed at the AI", many: "they contained instructions aimed at the AI" },
  OFF_PLATFORM_DISCOUNT: { one: "it asked to be paid outside the platform", many: "they asked to be paid outside the platform" },
  MISSING_CERT: { one: "it showed no safety test report for this product", many: "they showed no safety test report for this product" },
  OVER_MOQ: { one: "its minimum order costs more than your supplier pocket", many: "their minimum orders cost more than your supplier pocket" },
  SANCTIONS: { one: "its name is on a list of banned companies", many: "their names are on a list of banned companies" },
  NO_ESCROW: { one: "it won't let the payment be held until delivery", many: "they won't let the payment be held until delivery" },
  PERSONAL_PAYEE: { one: "it asked to be paid to a personal account", many: "they asked to be paid to a personal account" },
};

/** Gate order the founder reads them in: the attack first. */
const GATE_ORDER: readonly SupplierGate[] = ["AI_INJECTION", "OFF_PLATFORM_DISCOUNT", "PERSONAL_PAYEE", "SANCTIONS", "MISSING_CERT", "OVER_MOQ", "NO_ESCROW"];

/** "2 pages left out: they contained instructions aimed at the AI." One sentence per gate. */
export function excludedLines(excluded: SupplierSearch["excludedByGate"]): string[] {
  return GATE_ORDER.flatMap((gate) => {
    const n = excluded.find((e) => e.gate === gate)?.count ?? 0;
    if (n === 0) return [];
    return [`${plural(n, "page", "pages")} left out: ${n === 1 ? GATE_REASON[gate].one : GATE_REASON[gate].many}.`];
  });
}

const OMIT_REASON: { readonly [R in SearchOmitReason]: string } = {
  OFF_LIST: "not on the listing sites Hogee reads",
  NO_PRICE: "showed no price Hogee could find in the text",
  NO_SELLER: "named no seller",
  READER_REJECTED: "could not be read safely",
  CURRENCY: "priced in a currency Hogee can't convert today",
  WORDING: "used words Hogee won't show",
};

/** "Also skipped: 1 not on the listing sites Hogee reads, 2 could not be read safely." or null. */
export function omittedLine(omitted: SupplierSearch["omitted"]): string | null {
  const parts = omitted.filter((o) => o.count > 0).map((o) => `${o.count.toLocaleString("en-US")} ${OMIT_REASON[o.reason]}`);
  return parts.length > 0 ? `Also skipped: ${parts.join(", ")}.` : null;
}

/**
 * The listing link a card may render: the server-checked https URL, only when its host is the card's listingHost, on a
 * listing site (checked again here), with no credentials or port, as origin + path only (like the server's
 * allowedListingUrl: no query string or fragment ever reaches the listing host). Anything else is not linked (the host
 * may be text).
 */
export function listingHref(c: Pick<CandidateCard, "listingUrl" | "listingHost">): string | null {
  if (!c.listingUrl || !c.listingHost) return null;
  let u: URL;
  try {
    u = new URL(c.listingUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "" || u.hostname !== c.listingHost || !isListingHost(u.hostname)) return null;
  return `${u.origin}${u.pathname}`;
}

/** Whole BU, rounded to the nearest: "3,952 BU". */
export function wholeBu(minor: string): string {
  const v = BigInt(minor);
  const whole = (v + 50n) / 100n;
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} BU`;
}

/** About what one unit lands at, in whole BU ("about 4 BU each"), or null. */
export function perUnitBu(totalMinor: string | null, quantity: number): string | null {
  if (!totalMinor || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const each = BigInt(totalMinor) / BigInt(quantity);
  return each < 50n ? "under 1 BU each" : `about ${wholeBu(each.toString())} each`;
}

/** "Not stated" for a missing figure. */
export const orNotStated = (n: number | null, unit: string): string => (n === null ? "Not stated" : `${n.toLocaleString("en-US")}${unit}`);

/** The pick checkbox's accessible name ("Pick #2 Zhejiang Tidelume Cup Industry Co., Ltd."). */
export const pickLabel = (c: Pick<CandidateCard, "rank" | "displayName">): string => `Pick #${c.rank ?? "–"} ${c.displayName}`;

/**
 * How much of a page's claims Hogee could match to evidence, as the founder reads it (UX round 3, first-timer #19):
 * nothing matched yet is "Not checked yet" (never a red-sounding "0% proven"); else "40% of claims".
 */
export const coverage = (bps: number): string => (Math.round(bps / 100) <= 0 ? "Not checked yet" : `${Math.round(bps / 100)}% of claims`);

/** At most 5 picks (the pick action's limit). */
export const MAX_PICKS = 5;

/** The selection after toggling `id` (order kept as ranked; never more than MAX_PICKS). */
export function togglePick(picked: readonly string[], id: string, ranked: readonly string[]): string[] {
  const next = picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= MAX_PICKS ? [...picked] : [...picked, id];
  return ranked.filter((x) => next.includes(x));
}

/** How many candidates the card shows before "Show more" (UX-PLAN D27). */
export const FIRST_SHOWN = 3;

/**
 * The candidates the card shows: the first three, every picked one, or all once expanded. Hidden rows stay in the page
 * (with their Unverified pill), so nothing about a supplier is dropped, only folded.
 */
export function shownCandidateIds(ranked: readonly string[], picked: readonly string[], expanded: boolean): Set<string> {
  if (expanded) return new Set(ranked);
  return new Set([...ranked.slice(0, FIRST_SHOWN), ...picked]);
}

/** The Unverified pill shows on every web supplier, whatever else the data says (G12). */
export const showUnverified = (c: Pick<CandidateCard, "unverified" | "origin">): boolean => c.unverified || c.origin === "web";

/** "4 pages hidden for your safety": every page a gate left out, plus the skipped ones. */
export function leftOutCount(s: Pick<SupplierSearch, "omitted" | "excludedByGate">): number {
  return total(s.excludedByGate) + total(s.omitted);
}

export interface Recipient {
  readonly supplierId: string;
  readonly rank: number | null;
  readonly name: string;
  /** The listing page, only as listingHref allows it (https, a listing site, origin + path); null otherwise. */
  readonly href: string | null;
  readonly host: string | null;
  readonly unverified: boolean;
}

/**
 * Who the founder's message is for, from the search's structured candidates (never from a text part, G3): each picked
 * supplier's name, its place on the list and its listing page. Hogee never sends the message; the link only opens the
 * seller's own page. An id the search doesn't know is left out, never guessed.
 */
export function enquiryRecipients(supplierIds: readonly string[], search: Pick<SupplierSearch, "candidates"> | undefined): Recipient[] {
  if (!search) return [];
  return supplierIds.flatMap((id) => {
    const c = search.candidates.find((x) => x.supplierId === id);
    return c ? [{ supplierId: id, rank: c.rank, name: c.displayName, href: listingHref(c), host: c.listingHost, unverified: showUnverified(c) }] : [];
  });
}
