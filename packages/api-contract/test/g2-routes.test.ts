/**
 * G2 schema batch (project.md §26.10): founder-key enrolment routes (closes security-audit run-4 lead 5), the
 * supplier's escrow order id, POLICY_ESCALATION out of ExceptionCreate, and the error codes the live API returns.
 */
import { describe, expect, it } from "vitest";
import { MEI_IDS, RINA_IDS, exampleEnrolmentCode, exampleExceptions, examplePendingFounderKey, exampleSupplierWithEvidence } from "@hogee/core";
import {
  EnrolmentCodeResult,
  PasskeyRegisterOptionsBody,
  ROUTE_EXAMPLES,
  ROUTE_NAMES,
  RejectFounderKeyBody,
  RejectFounderKeyResult,
  SupplierWithOrder,
  routes,
  type RouteDef,
} from "../src/index";

describe("founder-key enrolment routes", () => {
  it("are officer-only, under /api/officer/founder-key, after the approval route", () => {
    expect(routes.getPendingFounderKey).toMatchObject({ method: "GET", path: "/api/officer/founder-key/pending", personas: ["officer"] });
    expect(routes.issueEnrolmentCode).toMatchObject({ method: "POST", path: "/api/officer/founder-key/enrolment-code", personas: ["officer"] });
    expect(routes.rejectFounderKey).toMatchObject({ method: "POST", path: "/api/officer/founder-key/reject", personas: ["officer"] });
    const at = (n: (typeof ROUTE_NAMES)[number]) => ROUTE_NAMES.indexOf(n);
    expect([at("approveFounderKey") + 1, at("approveFounderKey") + 2, at("approveFounderKey") + 3]).toEqual([
      at("getPendingFounderKey"), at("issueEnrolmentCode"), at("rejectFounderKey"),
    ]);
  });

  it("registration options need the enrolment code (strict body)", () => {
    expect(routes.passkeyRegisterOptions.req.body).toBe(PasskeyRegisterOptionsBody);
    expect(PasskeyRegisterOptionsBody.safeParse({ enrolmentCode: exampleEnrolmentCode }).success).toBe(true);
    expect(PasskeyRegisterOptionsBody.safeParse({}).success).toBe(false);
    expect(PasskeyRegisterOptionsBody.safeParse({ enrolmentCode: "short" }).success).toBe(false);
    expect(PasskeyRegisterOptionsBody.safeParse({ enrolmentCode: exampleEnrolmentCode, founderId: "x" }).success).toBe(false);
  });

  it("a wrong, used or expired code is FORBIDDEN on options and verify; a second key is FounderKeyAlreadySet", () => {
    expect(routes.passkeyRegisterOptions.errors).toEqual(["VALIDATION", "FORBIDDEN", "CONFLICT"]);
    expect(routes.passkeyRegisterVerify.errors).toEqual(["VALIDATION", "FORBIDDEN", "CONFLICT", "FounderKeyAlreadySet"]);
  });

  it("the pending key is the core PendingFounderKey or null", () => {
    const res = routes.getPendingFounderKey.res;
    expect(res.safeParse(null).success).toBe(true);
    expect(res.safeParse(examplePendingFounderKey).success).toBe(true);
    expect(res.safeParse({ ...examplePendingFounderKey, founderId: RINA_IDS.founderId }).success).toBe(false);
    expect(routes.getPendingFounderKey.errors).toEqual(["FORBIDDEN"]);
  });

  it("issuing returns the code once with its ISO expiry", () => {
    expect(EnrolmentCodeResult.safeParse(ROUTE_EXAMPLES.issueEnrolmentCode.res).success).toBe(true);
    expect(EnrolmentCodeResult.safeParse({ code: exampleEnrolmentCode, expiresAt: "1792108800" }).success).toBe(false);
    expect(routes.issueEnrolmentCode.req).toEqual({});
  });

  it("reject names one credential and never a registered key", () => {
    expect(RejectFounderKeyBody.safeParse({ credentialId: examplePendingFounderKey.credentialId }).success).toBe(true);
    expect(RejectFounderKeyBody.safeParse({ credentialId: examplePendingFounderKey.credentialId, qx: examplePendingFounderKey.qx }).success).toBe(false);
    expect(RejectFounderKeyResult.safeParse({ credentialId: examplePendingFounderKey.credentialId, status: "REJECTED" }).success).toBe(true);
    expect(routes.rejectFounderKey.errors).toContain("FounderKeyAlreadySet");
    expect(routes.rejectFounderKey.errors).toContain("NOT_FOUND");
  });
});

describe("supplier → escrow order", () => {
  it("GET /api/suppliers/:id carries the supplier's escrow orderId, null before any order exists", () => {
    expect(routes.getSupplier.res).toBe(SupplierWithOrder);
    expect(SupplierWithOrder.safeParse({ ...exampleSupplierWithEvidence, orderId: null }).success).toBe(true);
    expect(SupplierWithOrder.safeParse({ ...exampleSupplierWithEvidence, orderId: RINA_IDS.supplierAOrderId }).success).toBe(true);
    expect(SupplierWithOrder.safeParse({ ...exampleSupplierWithEvidence, orderId: MEI_IDS.supplierAOrderId }).success).toBe(true);
    expect(SupplierWithOrder.safeParse(exampleSupplierWithEvidence).success).toBe(false);
    // SG-DECISIONS: the example is the main demo's (Mei's order).
    expect(ROUTE_EXAMPLES.getSupplier.res.orderId).toBe(MEI_IDS.supplierAOrderId);
  });
});

describe("POLICY_ESCALATION", () => {
  it("cannot be requested over POST /api/exceptions; the console still lists one", () => {
    const escalation = exampleExceptions.find((e) => e.kind === "POLICY_ESCALATION");
    expect(routes.createException.req.body.safeParse({ kind: "POLICY_ESCALATION", payload: escalation?.payload, reason: "pay me" }).success).toBe(false);
    expect(routes.listExceptions.res.safeParse([escalation]).success).toBe(true);
  });
});

describe("error lists name what the live API returns (no more silent CONFLICT / UPSTREAM rewrites)", () => {
  const has = (name: keyof typeof routes, codes: readonly string[]) => {
    for (const code of codes) expect((routes[name] as RouteDef).errors, `${name}: ${code}`).toContain(code);
  };

  it("approveException: the mirrored loosening, stage-gate and milestone-release refusals", () => {
    has("approveException", ["PayeeNotBound", "CapExceeded", "LineExpired", "PlanInvariantViolated", "PayeeCooling", "MilestoneLocked", "AmountExceedsSchedule", "EvidenceMissing"]);
    // An escalation is approved as an officer override; the worker re-checks when it pays.
    expect(routes.approveException.errors).not.toContain("EscrowOnly");
    expect(routes.approveException.errors).not.toContain("Paused");
  });

  it("signing, exceptions and the planner surface", () => {
    has("requestSignature", ["UPSTREAM", "PlanInvariantViolated", "PayeeCooling", "PayeeNotBound", "CapExceeded", "LineExpired", "DuplicateInvoice", "DuplicateIntent", "EscrowOnly", "AmountExceedsSchedule", "MilestoneLocked", "EvidenceMissing"]);
    has("submitSignature", ["EscrowOnly", "DuplicateIntent"]);
    has("createException", ["UPSTREAM", "PlanInvariantViolated", "PayeeNotBound", "CapExceeded", "LineExpired"]);
    has("chat", ["NOT_FOUND", "CONFLICT"]);
    has("draftPlan", ["CONFLICT"]);
    has("previewCountry", ["CONFLICT", "UPSTREAM"]);
    has("shortlistSuppliers", ["CONFLICT"]);
    has("proposeSpend", ["CONFLICT"]);
    has("demoAttack", ["CONFLICT"]);
    has("getAutonomyStats", ["UPSTREAM"]);
  });
});
