/**
 * A country pack that lacks a fact the plan needs: the compile fails closed, and the API surfaces it as the route's
 * declared 409 COMPILE_FAILED naming the missing pack leaf (never 422, never 502). Without a database or chain, the
 * compiling routes (draftPlan, previewCountry, evalPlan) get a handler that runs the REAL compileDraft (the same call
 * their handlers make once the session, facility and chain reads are done) under the real central route rules. The
 * chat route never throws a compile failure: the planner turns it into a templated reply, checked through replyFor.
 */
import { describe, expect, it } from "vitest";
import { ROUTE_EXAMPLES } from "@hogee/api-contract";
import type { PlannerOutcome } from "@hogee/agent";
import {
  ApiError,
  JUDGING_WINDOW_END,
  PlanDraft,
  RINA_COMMIT_AT,
  RINA_FACILITY,
  RINA_IDS,
  RINA_PLATFORM_REGISTRY,
  ZERO_ADDRESS,
  examplePlanIntent,
  fakeAddress,
  fakeHex32,
  type CountryPack,
} from "@hogee/core";
import { createApiApp } from "../src/app";
import { toFailure } from "../src/http/problem";
import { replyFor } from "../src/routes/chat";
import { compileDraft, NO_AIGC, type CompileEnv } from "../src/services/compile";
import { TEST_PACK_ID, TEST_PACK_MY } from "./support/catalog";
import { fakeDeps } from "./support/fake-deps";

const { rate: _rate, ...thresholdOnly } = TEST_PACK_MY.indirectTax!;
/** P3-style partial pack: everything but the import sales tax rate (so a CN import has no SST in landed cost). */
const NO_RATE: CountryPack = { ...TEST_PACK_MY, tier: "RESEARCHED", indirectTax: thresholdOnly };

const ENV: CompileEnv = {
  facility: {
    facilityId: RINA_IDS.facilityId,
    countryCode: "MY",
    currency: "MYR",
    capMinor: RINA_FACILITY.capMinor,
    reserveFloorBps: RINA_FACILITY.reserveFloorBps,
    judgingWindowEnd: JUDGING_WINDOW_END,
    payees: RINA_PLATFORM_REGISTRY,
    ownerEOA: ZERO_ADDRESS,
    lender: fakeAddress("lender:final-1"),
    oracle: fakeAddress("oracle:final-1"),
  },
  now: BigInt(RINA_COMMIT_AT),
  agent: fakeAddress("agent:final-1") as `0x${string}`,
  planId: fakeHex32("planId:rina"),
};

const compileWith = (pack: CountryPack) => () => compileDraft({ intent: examplePlanIntent, draftId: "draft-fail-closed", env: ENV, pack, aigc: NO_AIGC });

function app(pack: CountryPack) {
  const f = fakeDeps();
  const handler = compileWith(pack);
  const a = createApiApp(async () => f.deps, {
    draftPlan: handler,
    previewCountry: handler,
    // evalPlan answers an EvalPlanResult; only its compile failure is under test here.
    evalPlan: () => {
      handler();
      throw new Error("expected the compile to fail closed");
    },
  });
  return { a, cookie: f.cookie("founder:rina") };
}

const ROUTES = [
  ["draftPlan", "/api/plans/draft", ROUTE_EXAMPLES.draftPlan.req.body],
  ["previewCountry", "/api/plans/preview-country", ROUTE_EXAMPLES.previewCountry.req.body],
  ["evalPlan", "/api/eval/plan", ROUTE_EXAMPLES.evalPlan.req.body],
] as const;

describe("a fail-closed compile surfaces as the route's declared COMPILE_FAILED", () => {
  it("toFailure: PackFactMissingError → COMPILE_FAILED with the leaf in the message and details", () => {
    let failure: ReturnType<typeof toFailure> | undefined;
    try {
      compileWith(NO_RATE)();
    } catch (e) {
      failure = toFailure(e, () => undefined);
    }
    expect(failure).toMatchObject({ code: "COMPILE_FAILED", details: { reason: "PACK_FACT_MISSING", missingFacts: ["indirectTax.rate"] } });
    expect(failure?.message).toMatch(/PACK_FACT_MISSING:indirectTax\.rate \(MY pack test-2026\.10\.16; sole_prop, drinkware_food_contact, buying from CN\)/);
  });

  it.each(ROUTES)("%s: 409 COMPILE_FAILED naming indirectTax.rate (not 422, not 502)", async (_name, path, body) => {
    const { a, cookie } = app(NO_RATE);
    const res = await a.request(path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    expect(res.status).toBe(409);
    const { error } = ApiError.parse(await res.json());
    expect(error.code).toBe("COMPILE_FAILED");
    expect(error.message).toContain("PACK_FACT_MISSING:indirectTax.rate");
    expect(error.details).toEqual({ reason: "PACK_FACT_MISSING", missingFacts: ["indirectTax.rate"] });
  });

  it("control: the complete pack compiles through the same route (200 PlanDraft)", async () => {
    const { a, cookie } = app(TEST_PACK_MY);
    const res = await a.request("/api/plans/draft", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(ROUTE_EXAMPLES.draftPlan.req.body) });
    expect(res.status).toBe(200);
    expect(PlanDraft.parse(await res.json()).manifest.totalMinor).toBe("1000000");
  });

  it("control: the ID fixture behind the live MY → ID preview carries every fact the demo intent needs", () => {
    const toIdr = (minor: string) => (BigInt(minor) * 3500n).toString(); // FX_MYR_IDR
    const env: CompileEnv = { ...ENV, facility: { ...ENV.facility, countryCode: "ID", currency: "IDR", capMinor: toIdr(ENV.facility.capMinor), payees: [] } };
    const intent = { ...examplePlanIntent, countryCode: "ID" as const, entityType: "perorangan" as const, budgetCeilingMinor: toIdr(examplePlanIntent.budgetCeilingMinor) };
    const draft = compileDraft({ intent, draftId: "draft-id-preview", env, pack: TEST_PACK_ID, aigc: NO_AIGC });
    expect(draft.manifest.countryCode).toBe("ID");
  });

  it("chat: the planner's COMPILE_FAILED with missing facts is a templated reply, and the trace names the leaves", () => {
    const outcome = {
      kind: "rejected",
      reason: "COMPILE_FAILED",
      detail: "COMPILE_FAILED",
      missingFacts: ["indirectTax.rate", "productApprovals.drinkware_food_contact"],
      decision: { rationale: { reasonCode: "COMPILE_FAILED" } },
    } as unknown as PlannerOutcome;
    const reply = replyFor(outcome);
    expect(reply.parts).toEqual([{ type: "text", text: expect.stringMatching(/won't guess/) }]);
    expect(reply.summary).toBe("Planner proposal not used (COMPILE_FAILED: PACK_FACT_MISSING:indirectTax.rate,productApprovals.drinkware_food_contact)");
    expect(reply.reasonCode).toBe("COMPILE_FAILED");
  });
});
