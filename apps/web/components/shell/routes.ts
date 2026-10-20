import type { Persona } from "@hogee/core";
// Relative, not "@/": the unit tests run this file without the Next path alias.
import { isFounderPersona } from "../../lib/persona";

/** Who a route is for. Either founder persona (Mei in SG, Rina in MY) is "the founder". */
export type Audience = "founder" | "officer";

export type NavRoute = {
  href: string;
  label: string;
  audiences: readonly Audience[];
  /** Other paths that light this item up (Proof covers its two sub-pages). */
  also?: readonly string[];
};

const BOTH: readonly Audience[] = ["founder", "officer"];

/** The Proof area (UX-PLAN D9): two sub-pages under one header. Routes are unchanged. */
export const PROOF_TABS: readonly { href: string; label: string }[] = [
  { href: "/evidence", label: "Checks" },
  { href: "/timeline", label: "Activity record" },
];
export const PROOF_HREF = "/evidence";

/**
 * The main nav (UX-PLAN D9; the side nav since UX round 2), in this order. Founder: Chat (home), Wallet, Plan. Officer:
 * Loan officer (home), Wallet, Proof. Founders and judges reach Proof from the quick settings and the page footer, not
 * the nav (P1, 19 Oct). Routes are unchanged: /dashboard is "Wallet" (it was "Money"; P1, UX round 2); Suppliers left
 * the nav and keeps its route (the catalog flow links to it).
 */
export const NAV_ROUTES: readonly NavRoute[] = [
  { href: "/chat", label: "Chat", audiences: ["founder"] },
  { href: "/officer", label: "Loan officer", audiences: ["officer"] },
  { href: "/dashboard", label: "Wallet", audiences: BOTH },
  { href: "/plan", label: "Plan", audiences: ["founder"] },
  { href: PROOF_HREF, label: "Proof", audiences: ["officer"], also: PROOF_TABS.map((t) => t.href).filter((h) => h !== PROOF_HREF) },
];

/** Settings, pinned at the foot of the side nav for both personas (UX round 2). Not one of the "Main" nav's pages. */
export const SETTINGS_ROUTE: NavRoute = { href: "/settings", label: "Settings", audiences: BOTH };

/** Pages a persona may stay on although the nav doesn't list them: Proof and Settings for both, Suppliers for the founder. */
const OFF_NAV: readonly NavRoute[] = [
  SETTINGS_ROUTE,
  { href: "/evidence", label: "Checks", audiences: BOTH },
  { href: "/timeline", label: "Activity record", audiences: BOTH },
  { href: "/suppliers", label: "Suppliers", audiences: ["founder"] },
];

const HOME: Record<Audience, string> = {
  founder: "/chat",
  officer: "/officer",
};

/** A new persona fails typecheck here until it is given an audience. */
export function audienceOf(persona: Persona): Audience {
  if (isFounderPersona(persona)) return "founder";
  return persona;
}

export function homeFor(persona: Persona): string {
  return HOME[audienceOf(persona)];
}

export function navRoutesFor(persona: Persona): readonly NavRoute[] {
  const audience = audienceOf(persona);
  return NAV_ROUTES.filter((r) => r.audiences.includes(audience));
}

export function isActiveRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The nav item is current on its own page and on any page it covers (Proof on both sub-pages). */
export function isNavActive(pathname: string, route: NavRoute): boolean {
  return [route.href, ...(route.also ?? [])].some((href) => isActiveRoute(pathname, href));
}

/** Whether a persona may stay on this page after switching (its nav pages, plus Proof, Settings and, for the founder, Suppliers). */
export function isRouteVisibleFor(pathname: string, persona: Persona): boolean {
  const audience = audienceOf(persona);
  return [...NAV_ROUTES, ...OFF_NAV].some((r) => r.audiences.includes(audience) && isNavActive(pathname, r));
}

/** The page's <main> (shell-frame.tsx): the skip link's target (skip-link.tsx). */
export const MAIN_ID = "main";

/** Routes whose page owns the whole canvas under the top bar (no padded container, no BU footer). */
export const FULL_BLEED_ROUTES: readonly string[] = ["/chat"];

export function isFullBleed(pathname: string): boolean {
  return FULL_BLEED_ROUTES.some((href) => isActiveRoute(pathname, href));
}
