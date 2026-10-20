/**
 * G2 schema batch (project.md §26.10): POLICY_ESCALATION leaves ExceptionCreate (response kind only), the founder-key
 * enrolment schemas, the 2.0.0 version bump (1.0.0 manifests stay readable) and the corrected reserve example.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ENROLMENT_CODE_BYTES,
  ENROLMENT_CODE_TTL_SECONDS,
  EnrolmentCode,
  Exception,
  ExceptionCreate,
  PendingFounderKey,
  PlanManifest,
  Shortlist,
  READABLE_SCHEMA_VERSIONS,
  SCHEMA_VERSION,
  exampleBalances,
  exampleEnrolmentCode,
  exampleExceptions,
  exampleFailedShortlist,
  examplePendingFounderKey,
  examplePlanManifest,
  exampleShortlist,
  parseMinor,
  shortlistHashOf,
} from "../src/index";

const ok = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(true);
const bad = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(false);

describe("schema version", () => {
  it("is 2.0.0 (a removal is a major change) and new manifests carry it", () => {
    expect(SCHEMA_VERSION).toBe("2.0.0");
    expect(examplePlanManifest.schemaVersion).toBe("2.0.0");
  });

  it("keeps 1.0.0 manifests readable (their hash may already be on-chain) and refuses any other version", () => {
    expect(READABLE_SCHEMA_VERSIONS).toEqual(["1.0.0", "2.0.0"]);
    ok(PlanManifest, { ...examplePlanManifest, schemaVersion: "1.0.0" });
    bad(PlanManifest, { ...examplePlanManifest, schemaVersion: "1.1.0" });
    bad(PlanManifest, { ...examplePlanManifest, schemaVersion: "3.0.0" });
  });
});

describe("POLICY_ESCALATION is a response kind only", () => {
  const escalation = exampleExceptions.find((e) => e.kind === "POLICY_ESCALATION");

  it("ExceptionCreate refuses a caller-built escalation", () => {
    expect(escalation).toBeDefined();
    bad(ExceptionCreate, { kind: "POLICY_ESCALATION", payload: escalation?.payload, reason: "pay me" });
    expect(ExceptionCreate.options.map((o) => o.shape.kind.value)).not.toContain("POLICY_ESCALATION");
  });

  it("an Exception may still be a POLICY_ESCALATION (the server's spend path opens one)", () => {
    ok(Exception, escalation);
  });

  it("every other kind is still requestable", () => {
    expect(ExceptionCreate.options.map((o) => o.shape.kind.value)).toEqual([
      "RAISE_CAP", "ADD_PAYEE", "EXTEND_EXPIRY", "MOVE_POCKETS", "UNPAUSE", "WITHDRAW_RESERVE", "RELEASE_ESCROW_BALANCE", "RELEASE_STAGE", "REPLAN",
    ]);
  });
});

describe("founder-key enrolment", () => {
  it("a code is 18 bytes (144 bits) as 24 base64url characters, valid for 15 minutes", () => {
    expect(ENROLMENT_CODE_BYTES * 8).toBeGreaterThanOrEqual(128);
    expect(Buffer.alloc(ENROLMENT_CODE_BYTES).toString("base64url")).toHaveLength(24);
    expect(ENROLMENT_CODE_TTL_SECONDS).toBe(900);
    ok(EnrolmentCode, exampleEnrolmentCode);
    ok(EnrolmentCode, Buffer.alloc(ENROLMENT_CODE_BYTES, 0xff).toString("base64url"));
  });

  it.each([
    ["too short", "A".repeat(23)],
    ["too long", "A".repeat(25)],
    ["padded", `${"A".repeat(22)}==`],
    ["standard base64", `${"A".repeat(22)}+/`],
    ["whitespace", ` ${"A".repeat(23)}`],
    ["empty", ""],
  ])("refuses a code that is %s", (_label, code) => {
    bad(EnrolmentCode, code);
  });

  it("the pending key is strict: credential, P-256 coordinates and an ISO registration time", () => {
    ok(PendingFounderKey, examplePendingFounderKey);
    bad(PendingFounderKey, { ...examplePendingFounderKey, onchain: "PENDING_LENDER" });
    bad(PendingFounderKey, { ...examplePendingFounderKey, createdAt: "1792108800" });
    bad(PendingFounderKey, { ...examplePendingFounderKey, qx: "0x1234" });
  });
});

describe("examples", () => {
  it("the reserve withdrawal asks for no more than the example reserve, and its title says so", () => {
    const w = exampleExceptions.find((e) => e.exceptionId === "exc-withdraw-reserve");
    expect(w?.kind).toBe("WITHDRAW_RESERVE");
    if (w?.kind !== "WITHDRAW_RESERVE") return;
    expect(parseMinor(w.payload.amountMinor)).toBeLessThanOrEqual(parseMinor(exampleBalances.reserveMinor));
    expect(w.blastRadiusMinor).toBe(w.payload.amountMinor);
    expect(w.title).toBe("Withdraw 20 BU from the reserve to lhdn-tax");
  });
});

describe("Shortlist.failureReason (P2 PR #10)", () => {
  it("is optional on input and null once parsed: a shortlist written before the field still parses", () => {
    const { failureReason: _drop, ...legacy } = exampleShortlist;
    const parsed = Shortlist.parse(legacy);
    expect(parsed.failureReason).toBeNull();
    expect(Shortlist.parse({ ...exampleFailedShortlist, failureReason: undefined }).failureReason).toBeNull();
  });

  it("carries a reason only when the shortlist FAILED", () => {
    ok(Shortlist, exampleFailedShortlist);
    ok(Shortlist, { ...exampleFailedShortlist, failureReason: null });
    bad(Shortlist, { ...exampleShortlist, failureReason: "stale" });
    bad(Shortlist, { ...exampleFailedShortlist, status: "PENDING" });
    bad(Shortlist, { ...exampleFailedShortlist, failureReason: "" });
    bad(Shortlist, { ...exampleFailedShortlist, failureReason: "x".repeat(301) });
  });

  it("stays out of shortlistHash, so no existing hash changes", () => {
    const { failureReason: _drop, ...legacy } = exampleShortlist;
    expect(shortlistHashOf({ ...exampleShortlist, failureReason: "anything" } as never)).toBe(shortlistHashOf(legacy));
  });
});
