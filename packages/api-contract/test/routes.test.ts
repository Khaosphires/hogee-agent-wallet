import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { API_ERROR_CODES, type Balances, type Payment, type PlanDraft } from "@hogee/core";
import {
  ApiError,
  CHAT_DATA_PART_SCHEMAS,
  CHAT_DATA_PART_TYPES,
  ChatDataPart,
  ROUTE_EXAMPLES,
  ROUTE_NAMES,
  buildPath,
  honoPath,
  httpStatusFor,
  pathParamNames,
  routes,
  type RouteDef,
  type RouteReq,
  type RouteRes,
} from "../src/index";

const all = ROUTE_NAMES.map((n) => [n, routes[n] as RouteDef] as const);

const parse = (schema: z.ZodType | undefined, value: unknown, label: string) => {
  if (!schema) return;
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${label}: ${JSON.stringify(r.error.issues, null, 2)}`);
};

describe("route table", () => {
  it("has every §26.6 route", () => {
    // G2: + getPendingFounderKey, issueEnrolmentCode, rejectFounderKey.
    // VISION-DECISIONS §5: + startSupplierSearch, getSupplierSearch, submitOrderTerms, getOrderTerms, getCfoReport.
    // REG-BRIEF (fisco-proof): + listFiscoPacks, getFiscoFile, getFiscoAnchor.
    expect(ROUTE_NAMES.length).toBe(59);
  });

  it.each(all)("%s: name matches key, path under /api", (name, r) => {
    expect(r.name).toBe(name);
    expect(r.path.startsWith("/api/")).toBe(true);
  });

  it("method + path is unique", () => {
    const keys = all.map(([, r]) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every route's errors are a subset of ApiErrorCode, without duplicates", () => {
    for (const [name, r] of all) {
      for (const code of r.errors) expect(API_ERROR_CODES, `${name}: ${code}`).toContain(code);
      expect(new Set(r.errors).size, name).toBe(r.errors.length);
    }
  });

  it("demo, eval, persona and spend-proposal routes (and only they) are demoOnly and may return NOT_FOUND", () => {
    const extraDemo = new Set(["/api/session/persona", "/api/proposals/spend"]);
    for (const [name, r] of all) {
      const demo = r.path.startsWith("/api/demo/") || r.path.startsWith("/api/eval/") || extraDemo.has(r.path);
      expect(r.demoOnly === true, name).toBe(demo);
      if (demo) expect(r.errors, name).toContain("NOT_FOUND");
    }
  });

  // G0-AUDIT (v-2): the /api guard skips the Origin/Sec-Fetch-Site checks for GET, so a GET must be a read. The
  // contract cannot express "no side effects"; this pins the metadata a mutating route would need (handlers: 1.12).
  // G2: a persona gate on a GET only limits who may read (the officer's pending founder key); FORBIDDEN is then a
  // read error too. Writes stay POST.
  it("GET routes are reads: no body, not demoOnly, only read errors (FORBIDDEN only behind a persona gate)", () => {
    const readErrors = new Set(["VALIDATION", "NOT_FOUND", "UPSTREAM"]);
    for (const [name, r] of all.filter(([, route]) => route.method === "GET")) {
      expect(r.req.body, name).toBeUndefined();
      expect(r.demoOnly, name).toBeUndefined();
      for (const code of r.errors) expect(readErrors.has(code) || (code === "FORBIDDEN" && r.personas !== undefined), `${name}: ${code}`).toBe(true);
    }
    expect(all.filter(([, r]) => r.method === "GET" && r.personas).map(([n]) => n)).toEqual(["getPendingFounderKey"]);
  });

  it("destructive demo routes are officer-only", () => {
    for (const name of ["demoReset", "demoCrashNextBroadcast", "demoAutonomyStart", "demoAutonomyStop"] as const) {
      expect(routes[name].personas).toEqual(["officer"]);
    }
  });

  it("persona-restricted routes may return FORBIDDEN; param routes may return NOT_FOUND", () => {
    for (const [name, r] of all) {
      if (r.personas) expect(r.errors, name).toContain("FORBIDDEN");
      if (pathParamNames(r.path).length > 0) expect(r.errors, name).toContain("NOT_FOUND");
    }
  });

  it("path params match the params schema keys", () => {
    for (const [name, r] of all) {
      const declared = r.req.params ? Object.keys((r.req.params as z.ZodObject).shape) : [];
      expect(declared.sort(), name).toEqual(pathParamNames(r.path).sort());
    }
  });

  it("flags: chat streams, Stripe is raw with 400 on a bad signature, inspection is multipart", () => {
    expect(all.filter(([, r]) => r.stream).map(([n]) => n)).toEqual(["chat"]);
    expect(routes.stripeWebhook.rawBody).toBe(true);
    expect(httpStatusFor(routes.stripeWebhook, "VALIDATION")).toBe(400);
    expect(httpStatusFor(routes.draftPlan, "VALIDATION")).toBe(422);
    expect(httpStatusFor(routes.draftPlan, "COMPILE_FAILED")).toBe(409);
    expect(routes.uploadInspection.multipart).toBe(true);
    expect(routes.getEvidenceFile.fileResponse).toBe(true);
    expect(routes.getFiscoFile.fileResponse).toBe(true);
    expect(routes.getFiscoAnchor.fileResponse).toBe(true);
    expect((routes.listFiscoPacks as RouteDef).fileResponse).toBeUndefined();
  });

  it("static paths are registered before param paths that would shadow them", () => {
    const order = ROUTE_NAMES.indexOf.bind(ROUTE_NAMES);
    expect(order("listEvidenceRuns")).toBeLessThan(order("getEvidenceRun"));
    // /api/evidence/fisco would otherwise be read as the run "fisco" (REG-BRIEF fisco-proof).
    for (const name of ["listFiscoPacks", "getFiscoFile", "getFiscoAnchor"] as const) expect(order(name), name).toBeLessThan(order("getEvidenceRun"));
  });
});

describe("examples", () => {
  it.each(all)("%s: example request and response parse", (name, r) => {
    const ex = ROUTE_EXAMPLES[name] as { req: Record<string, unknown>; res: unknown };
    parse(r.req.params, ex.req.params, `${name} params`);
    parse(r.req.query, ex.req.query, `${name} query`);
    parse(r.req.body, ex.req.body, `${name} body`);
    parse(r.req.headers, ex.req.headers, `${name} headers`);
    for (const part of Object.keys(ex.req)) expect(Object.keys(r.req), name).toContain(part);
    parse(r.res, ex.res, `${name} res`);
  });

  it("error examples declare a code the route may return; all others are success examples", () => {
    const errorExamples = all.filter(([name]) => (ROUTE_EXAMPLES[name] as { expectError?: string }).expectError);
    expect(errorExamples.map(([n]) => n)).toEqual(["stripeWebhook"]);
    for (const [name, r] of errorExamples) {
      expect(r.errors, name).toContain((ROUTE_EXAMPLES[name] as { expectError: string }).expectError);
    }
  });

  it("buildPath substitutes and encodes params", () => {
    expect(buildPath(routes.getPayment, { id: "pay-0001" })).toBe("/api/payments/pay-0001");
    expect(buildPath(routes.getEvidenceFile, { runId: "run-1", path: "receipts/T 1.json" })).toBe("/api/evidence/run-1/files/receipts/T%201.json");
    expect(() => buildPath(routes.getPayment, {})).toThrow();
    expect(honoPath(routes.getSession)).toBe("/session");
  });

  it("rejects bad requests", () => {
    expect(routes.listTraces.req.query.safeParse({ limit: "501" }).success).toBe(false);
    expect(routes.fundFacility.req.body.safeParse({ amountMinor: 100 }).success).toBe(false);
    expect(routes.getEvidenceFile.req.params.safeParse({ runId: "r", path: "../secret" }).success).toBe(false);
    // A FISCO pack id is its folder name (fm- and 16 hex), and a file path is relative with no "..".
    const packId = "fm-c2b22fa376a165da";
    expect(routes.getFiscoFile.req.params.safeParse({ packId, path: "txs/0xab.json" }).success).toBe(true);
    for (const path of ["../ev-74756ea61a72ae7c/manifest.json", "/etc/hosts", "txs/../../x", "a b", ""]) {
      expect(routes.getFiscoFile.req.params.safeParse({ packId, path }).success, path).toBe(false);
    }
    for (const bad of ["fm-C2B22FA376A165DA", "fm-c2b22fa376a165d", "ev-74756ea61a72ae7c", "anchors", "fm-c2b22fa376a165da/..", "fisco"]) {
      expect(routes.getFiscoAnchor.req.params.safeParse({ packId: bad }).success, bad).toBe(false);
      expect(routes.getFiscoFile.req.params.safeParse({ packId: bad, path: "pack.json" }).success, bad).toBe(false);
    }
    expect(routes.evalCase.req.body.safeParse({ arm: "naive", case: {} }).success).toBe(false);
  });

  it("a FISCO pack summary is strict: its id, its export time, at most 400 relative files and whether it is anchored", () => {
    const res = routes.listFiscoPacks.res;
    const pack = { packId: "fm-c2b22fa376a165da", createdAt: "2026-10-19T21:03:15.402Z", files: ["pack.json", "txs/0xab.json"], anchored: false };
    expect(res.safeParse([pack]).success).toBe(true);
    expect(res.safeParse([{ ...pack, extra: 1 }]).success).toBe(false);
    expect(res.safeParse([{ ...pack, anchored: "yes" }]).success).toBe(false);
    expect(res.safeParse([{ ...pack, files: ["../x"] }]).success).toBe(false);
    expect(res.safeParse([{ ...pack, files: Array.from({ length: 401 }, (_, i) => `f${i}.json`) }]).success).toBe(false);
    expect(res.safeParse([{ ...pack, packId: "ev-74756ea61a72ae7c" }]).success).toBe(false);
  });

  it("an ApiError with an undeclared code is still a valid envelope (the contract test checks membership)", () => {
    expect(ApiError.safeParse({ error: { code: "NOT_FOUND", message: "no such payment" } }).success).toBe(true);
    expect(ApiError.safeParse({ error: { code: "TEAPOT", message: "x" } }).success).toBe(false);
  });
});

describe("chat data parts (frozen)", () => {
  it("has the five frozen parts first, then the chat-first parts (VISION-DECISIONS §4)", () => {
    expect(Object.keys(CHAT_DATA_PART_SCHEMAS).map((k) => `data-${k}`)).toEqual([...CHAT_DATA_PART_TYPES]);
    expect(CHAT_DATA_PART_TYPES.slice(0, 5)).toEqual(["data-question", "data-intent", "data-plan-draft", "data-shortlist", "data-redflag"]);
  });

  it("rejects unknown data parts and bad payloads", () => {
    expect(ChatDataPart.safeParse({ type: "data-question", data: { questionId: "q", slot: "mood", text: "?", options: [] } }).success).toBe(false);
    expect(ChatDataPart.safeParse({ type: "data-secret", data: {} }).success).toBe(false);
  });
});

describe("type helpers", () => {
  it("infer request and response types", () => {
    expectTypeOf<RouteRes<"getBalances">>().toEqualTypeOf<Balances>();
    expectTypeOf<RouteRes<"listPayments">>().toEqualTypeOf<Payment[]>();
    expectTypeOf<RouteRes<"draftPlan">>().toEqualTypeOf<PlanDraft>();
    expectTypeOf<RouteReq<"getPayment">["params"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<RouteReq<"getBalances">>().toEqualTypeOf<{}>();
    // G0-AUDIT (v-2): the officer persona needs a token; a founder persona takes none (SG-DECISIONS Q1: either founder).
    expectTypeOf<RouteReq<"setPersona">["body"]>().toEqualTypeOf<
      { persona: "founder:rina" | "founder:mei" } | { persona: "officer"; officerToken: string }
    >();
  });
});
