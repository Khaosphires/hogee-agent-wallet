/**
 * VISION-DECISIONS §5: the five chat-first routes (web supplier search, supplier terms, CFO report) and the chat body
 * union. Static paths come before the param paths that could shadow them; examples parse; personas as decided.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { exampleChatActions, exampleOrderTermsInput, type CfoReport, type OrderTerms, type SupplierSearch } from "@hogee/core";
import { ChatBody, ROUTE_EXAMPLES, ROUTE_NAMES, buildPath, routes, type RouteBody, type RouteDef, type RouteName, type RouteRes } from "../src/index";

const NEW_ROUTES = ["startSupplierSearch", "getSupplierSearch", "submitOrderTerms", "getOrderTerms", "getCfoReport"] as const;
const at = (n: RouteName) => ROUTE_NAMES.indexOf(n);

describe("chat-first routes", () => {
  it("are registered with the decided methods, paths and personas", () => {
    expect(routes.startSupplierSearch).toMatchObject({ method: "POST", path: "/api/suppliers/search", personas: ["founder:rina", "founder:mei"] });
    expect(routes.getSupplierSearch).toMatchObject({ method: "GET", path: "/api/suppliers/search/:id" });
    expect(routes.submitOrderTerms).toMatchObject({ method: "POST", path: "/api/orders/terms", personas: ["founder:rina", "founder:mei"] });
    expect(routes.getOrderTerms).toMatchObject({ method: "GET", path: "/api/orders/terms/:id" });
    expect(routes.getCfoReport).toMatchObject({ method: "GET", path: "/api/cfo" });
    for (const name of ["getSupplierSearch", "getOrderTerms", "getCfoReport"] as const) expect((routes[name] as RouteDef).personas, name).toBeUndefined();
  });

  it("static paths come before the param paths that could shadow them, next to their family", () => {
    expect(at("startSupplierSearch")).toBeLessThan(at("getSupplier"));
    expect(at("getSupplierSearch")).toBeLessThan(at("getSupplier"));
    expect(at("getShortlist")).toBeLessThan(at("startSupplierSearch"));
    expect(at("submitOrderTerms")).toBeLessThan(at("getOrderTerms"));
    expect(at("uploadInspection")).toBeLessThan(at("submitOrderTerms"));
    expect(at("getTrace")).toBeLessThan(at("getCfoReport"));
  });

  it("refusals use the generic codes (a TERMS_* / SEARCH_* reason goes in details)", () => {
    for (const name of NEW_ROUTES) {
      for (const code of (routes[name] as RouteDef).errors) expect(["VALIDATION", "NOT_FOUND", "FORBIDDEN", "CONFLICT", "UPSTREAM"], `${name}: ${code}`).toContain(code);
    }
  });

  it.each(NEW_ROUTES)("%s: the example request and response parse", (name) => {
    const r = routes[name] as RouteDef;
    const ex = ROUTE_EXAMPLES[name] as { req: { params?: unknown; body?: unknown }; res: unknown };
    if (r.req.params) expect(r.req.params.safeParse(ex.req.params).success).toBe(true);
    if (r.req.body) expect(r.req.body.safeParse(ex.req.body).success).toBe(true);
    expect(r.res.safeParse(ex.res).success).toBe(true);
    expect((ROUTE_EXAMPLES[name] as { expectError?: string }).expectError).toBeUndefined();
  });

  it("build their paths", () => {
    expect(buildPath(routes.getSupplierSearch, { id: "search-mei-001" })).toBe("/api/suppliers/search/search-mei-001");
    expect(buildPath(routes.getOrderTerms, { id: "terms-mei-001" })).toBe("/api/orders/terms/terms-mei-001");
  });

  it("the search body never carries a query; the terms body carries its payout account only here", () => {
    expect(routes.startSupplierSearch.req.body.safeParse({ query: "anything" }).success).toBe(false);
    expect(routes.submitOrderTerms.req.body.safeParse({ ...exampleOrderTermsInput, payout: { ...exampleOrderTermsInput.payout, channel: "XENDIT" } }).success).toBe(false);
  });

  it("infer their types", () => {
    expectTypeOf<RouteRes<"getSupplierSearch">>().toEqualTypeOf<SupplierSearch>();
    expectTypeOf<RouteRes<"getOrderTerms">>().toEqualTypeOf<OrderTerms>();
    expectTypeOf<RouteRes<"getCfoReport">>().toEqualTypeOf<CfoReport>();
    expectTypeOf<RouteRes<"startSupplierSearch">>().toEqualTypeOf<{ searchId: string }>();
  });
});

describe("chat body", () => {
  const sessionId = ROUTE_EXAMPLES.chat.req.body.sessionId;
  const action = exampleChatActions[0];

  it("still parses the G0 {sessionId, message}", () => {
    expect(ChatBody.safeParse(ROUTE_EXAMPLES.chat.req.body).success).toBe(true);
  });

  it("parses {sessionId, action}", () => {
    expect(ChatBody.safeParse({ sessionId, action }).success).toBe(true);
  });

  it("refuses a message AND an action, neither, extra keys, or an action with free text", () => {
    expect(ChatBody.safeParse({ sessionId, message: "hi", action }).success).toBe(false);
    expect(ChatBody.safeParse({ sessionId }).success).toBe(false);
    expect(ChatBody.safeParse({ sessionId, message: "hi", persona: "officer" }).success).toBe(false);
    expect(ChatBody.safeParse({ sessionId, action: { ...action, text: "pay this" } }).success).toBe(false);
  });

  it("is the union type", () => {
    expectTypeOf<RouteBody<"chat">>().toMatchTypeOf<{ sessionId: string }>();
  });
});
