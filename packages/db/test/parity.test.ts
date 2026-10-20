import * as core from "@hogee/core";
import { describe, expect, it } from "vitest";
import * as db from "../src/schema/enums";
import * as payments from "../src/schema/payments";

// Postgres enums must stay identical to the frozen zod enums in @hogee/core (project.md §26.4–26.5).
// If this fails after a schema change, update packages/db/src/schema/enums.ts and regenerate the migration.
const pairs: ReadonlyArray<readonly [string, readonly string[], readonly string[]]> = [
  ["countryCode", db.countryCodeValues, core.COUNTRY_CODES],
  ["residency", db.residencyValues, core.RESIDENCIES],
  ["lineKey", db.lineKeyValues, core.LINE_KEYS],
  ["evidenceTier", db.evidenceTierValues, core.EVIDENCE_TIERS],
  ["sourceType", db.sourceTypeValues, core.SOURCE_TYPES],
  ["taintTrust", db.taintTrustValues, core.TRUST_LEVELS],
  ["taintSensitivity", db.taintSensitivityValues, core.SENSITIVITIES],
  ["paymentKind", db.paymentKindValues, core.PAYMENT_KINDS],
  ["paymentState", db.paymentStateValues, core.PAYMENT_STATES],
  ["payoutStatus", db.payoutStatusValues, core.PAYOUT_STATUSES],
  ["exceptionKind", db.exceptionKindValues, core.EXCEPTION_KINDS],
  ["exceptionStatus", db.exceptionStatusValues, core.EXCEPTION_STATUSES],
  ["traceActor", db.traceActorValues, core.TRACE_ACTORS],
  ["traceKind", db.traceKindValues, core.TRACE_KINDS],
  ["policyVerdict", db.policyVerdictValues, core.POLICY_VERDICTS],
  ["chainActionState", db.chainActionStateValues, core.CHAIN_ACTION_STATES],
  ["shortlistStatus", db.shortlistStatusValues, core.SHORTLIST_STATUSES],
  ["signatureKind", db.signatureKindValues, core.SIGNATURE_KINDS],
  ["signatureMethod", db.signatureMethodValues, core.SIGN_METHODS],
  ["founderKeyStatus", db.founderKeyStatusValues, core.PASSKEY_ONCHAIN_STATUSES],
  ["planStatus", db.planStatusValues, core.PLAN_STATUSES],
  // VISION-DECISIONS §6 (0004_chat_first): text + CHECK columns, same values as core.
  ["shortlistSource", db.shortlistSourceValues, core.SUPPLIER_ORIGINS],
  ["supplierTermsStatus", db.supplierTermsStatusValues, core.TERMS_STATUSES],
];

describe("db enums match @hogee/core enums", () => {
  it.each(pairs)("%s", (_name, dbValues, coreValues) => {
    expect([...dbValues]).toEqual([...coreValues]);
  });
});

// G0-REVIEW (H4): the CHECK `payments_decision_iff_agent_kind` uses this list; core's zod refinement uses its own.
describe("db non-agent payment kinds match @hogee/core", () => {
  it("NON_AGENT_PAYMENT_KINDS", () => {
    expect([...payments.NON_AGENT_PAYMENT_KINDS]).toEqual([...core.NON_AGENT_PAYMENT_KINDS]);
  });
});
