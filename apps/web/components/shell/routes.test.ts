/** The nav each persona sees (UX-PLAN D9): labels, order and routes; Proof covers its two sub-pages. */
import { describe, expect, it } from "vitest";
import { NAV_ROUTES, PROOF_TABS, SETTINGS_ROUTE, homeFor, isFullBleed, isNavActive, isRouteVisibleFor, navRoutesFor } from "./routes";

const nav = (persona: Parameters<typeof navRoutesFor>[0]) => navRoutesFor(persona).map((r) => `${r.label} ${r.href}`);
const proof = NAV_ROUTES.find((r) => r.label === "Proof");

describe("navRoutesFor", () => {
  it("gives the founder exactly Chat (home), Wallet and Plan, in that order", () => {
    expect(nav("founder:mei")).toEqual(["Chat /chat", "Wallet /dashboard", "Plan /plan"]);
    expect(nav("founder:rina")).toEqual(nav("founder:mei"));
  });

  it("gives the officer Loan officer (home), Wallet and Proof", () => {
    expect(nav("officer")).toEqual(["Loan officer /officer", "Wallet /dashboard", "Proof /evidence"]);
  });

  it("calls /dashboard Wallet, never Money (P1, UX round 2; the route stays)", () => {
    expect(NAV_ROUTES.find((r) => r.href === "/dashboard")?.label).toBe("Wallet");
    expect(NAV_ROUTES.map((r) => r.label)).not.toContain("Money");
  });

  it("keeps Settings out of the page list: it is pinned at the foot of the side nav", () => {
    expect(SETTINGS_ROUTE).toEqual({ href: "/settings", label: "Settings", audiences: ["founder", "officer"] });
    expect(NAV_ROUTES.map((r) => r.href)).not.toContain("/settings");
  });

  it("keeps Suppliers, Activity and Evidence out of every nav (routes unchanged)", () => {
    const labels = NAV_ROUTES.map((r) => r.label);
    for (const gone of ["Suppliers", "Activity", "Evidence", "CFO", "Officer console"]) expect(labels).not.toContain(gone);
  });
});

describe("Proof", () => {
  it("has two sub-pages: Checks (/evidence) and Activity record (/timeline)", () => {
    expect(PROOF_TABS).toEqual([
      { href: "/evidence", label: "Checks" },
      { href: "/timeline", label: "Activity record" },
    ]);
  });

  it("lights the Proof nav item on both sub-pages and nowhere else", () => {
    expect(proof).toBeDefined();
    if (!proof) return;
    expect(isNavActive("/evidence", proof)).toBe(true);
    expect(isNavActive("/timeline", proof)).toBe(true);
    expect(isNavActive("/timeline/abc", proof)).toBe(true);
    expect(isNavActive("/dashboard", proof)).toBe(false);
    expect(isNavActive("/timelines", proof)).toBe(false);
  });
});

describe("homes and visibility", () => {
  it("keeps each persona's home", () => {
    expect(homeFor("founder:mei")).toBe("/chat");
    expect(homeFor("officer")).toBe("/officer");
  });

  it("hides founder pages from the officer and keeps the shared ones", () => {
    expect(isRouteVisibleFor("/chat", "officer")).toBe(false);
    expect(isRouteVisibleFor("/plan", "officer")).toBe(false);
    expect(isRouteVisibleFor("/suppliers", "officer")).toBe(false);
    expect(isRouteVisibleFor("/evidence", "officer")).toBe(true);
    expect(isRouteVisibleFor("/timeline", "officer")).toBe(true);
    expect(isRouteVisibleFor("/dashboard", "founder:mei")).toBe(true);
  });

  it("lets the founder stay on Proof and Suppliers (reached from the Demo menu, the footer and the catalog flow)", () => {
    expect(isRouteVisibleFor("/evidence", "founder:mei")).toBe(true);
    expect(isRouteVisibleFor("/timeline", "founder:mei")).toBe(true);
    expect(isRouteVisibleFor("/suppliers", "founder:mei")).toBe(true);
    expect(isRouteVisibleFor("/officer", "founder:mei")).toBe(false);
  });

  it("lets both personas stay on Settings when they switch there", () => {
    expect(isRouteVisibleFor("/settings", "founder:mei")).toBe(true);
    expect(isRouteVisibleFor("/settings", "founder:rina")).toBe(true);
    expect(isRouteVisibleFor("/settings", "officer")).toBe(true);
  });
});

describe("isFullBleed", () => {
  it("lets only the chat own the canvas", () => {
    expect(isFullBleed("/chat")).toBe(true);
    expect(isFullBleed("/chat/abc")).toBe(true);
    expect(isFullBleed("/chatter")).toBe(false);
    expect(isFullBleed("/plan")).toBe(false);
  });
});
