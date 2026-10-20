/**
 * Every trace reason code has a plain-English label with no banned word (the wording lint's own checker), and the
 * timeline never shows a raw code.
 * Literal codes are read from the trace writers' source (reasonCode: "…", the policy's deny/allow/escalate, sales'
 * ignored(…), the worker's Refusal(…)), so a new literal code fails here until it is labelled. Codes that reach a
 * trace through a variable, a constant or a union type are listed in FLOWS_IN with where they come from.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONSTITUTION_CODES, CONTRACT_ERROR_NAMES } from "@hogee/core";
import { LABELLED_CODES, plainSummary, REASON_LABELS, reasonCopy, reasonLabel, UNKNOWN_PAYOUT_REASON, UNKNOWN_REASON } from "./reason-labels";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Source trees that write trace events, or decide the reason codes that writers copy into them. */
const WRITERS = [
  "packages/api/src",
  "packages/api-mock/src",
  "apps/worker/src",
  "packages/core/src/policy",
  "packages/agent/src/planner",
];
/** Trace fixtures the mock seeds from. */
const FIXTURE_TRACES = ["fixtures/scenario-rina/traces.json", "fixtures/evidence-sample/traces.json"];

const CODE = "([A-Za-z][A-Za-z0-9_]{0,31})";
const PATTERNS = [
  new RegExp(`reasonCode"?:\\s*["']${CODE}["']`, "g"),
  new RegExp(`\\b(?:deny|allow)\\(\\s*["']${CODE}["']`, "g"),
  new RegExp(`\\bescalate\\(\\s*["']NEEDS_[A-Z]+["'],\\s*["']${CODE}["']`, "g"),
  new RegExp(`\\bignored\\(\\s*["']${CODE}["']`, "g"),
  new RegExp(`\\bnew Refusal\\(\\s*["']${CODE}["']`, "g"),
];

/** Codes that reach a trace through a variable, a constant or a union (not caught by PATTERNS). */
const FLOWS_IN: Readonly<Record<string, readonly string[]>> = {
  "api routes/session.ts recordRejected": ["OFFICER_TOKEN_REJECTED", "OFFICER_TOKEN_LOCKED"],
  "api services/refusals.ts": ["CHAT_RATE_LIMITED", "MODEL_BUDGET_EXHAUSTED"],
  "api signing/request-bounds.ts REFUSAL_REASON": ["INVALID_SIGNATURE"],
  "agent planner refused / rejected reasons": ["SECRET_REQUEST", "MODEL_REFUSAL", "MALFORMED_INTENT", "NO_PROPOSAL", "COMPILE_FAILED"],
  "agent planner/grounding.ts reasons": ["INVALID_INTENT", "COUNTRY_NOT_FACILITY", "BUDGET_UNCLEAR", "BUDGET_NOT_STATED"],
  "core compiler/errors.ts CompileErrorCode": [
    "INVALID_INPUT",
    "COUNTRY_MISMATCH",
    "CURRENCY_MISMATCH",
    "BUDGET_TOO_SMALL",
    "ENTITY_INELIGIBLE",
    "AGENT_EXPIRY_INFEASIBLE",
    "LICENSING_EXCEEDS_CONTINGENCY",
    "FEE_TOO_LARGE",
    "COMPILE_FAILED",
  ],
  "core taint/labels.ts TAINT_REASON": ["TAINTED_PAYEE", "TAINTED_ACTION", "TAINTED_CAP", "TAINTED_OUTBOUND", "PRIVATE_OUTBOUND"],
  "core policy/owner-spend.ts and policy/state.ts": ["FOUNDER_SIGNATURE_REQUIRED", "WITHIN_PLAN"],
  "api services/spend-proposal.ts": ["ALREADY_PROPOSED_TODAY"],
  "worker jobs/agent-actions-ids.ts REASON": [
    "WITHIN_PLAN",
    "OFFICER_OVERRIDE",
    "OFFICER_OVERRIDE_REFUSED",
    "SPEND_PROPOSAL_DENIED",
    "FOUNDER_RELAY_REFUSED",
    "ALREADY_PROPOSED_TODAY",
  ],
  "worker jobs/sync-veto.ts": ["VETO_RECONCILED", "VETOED_LOOSEN_EXECUTED", "VETOED_LOOSEN_QUEUED", "VETO_CANCEL_RETRIES_EXHAUSTED"],
  "worker jobs/settle.ts": ["SETTLEMENT_CONFIRMED_ELSEWHERE", "PAYOUT_ROUTE_REFUSED", "PAYOUT_CONFLICT"],
  "worker jobs/settle-decide.ts BlockReason (BindingVerdict without OK and PAYEE_COOLING)": [
    "INTENT_MISMATCH",
    "SPEND_MISMATCH",
    "DESTINATION_MISMATCH",
    "SETTLEMENT_CALL_REVERTED",
    "PAYOUT_STATUS_MISMATCH",
    "SETTLEMENT_CONTRADICTION",
  ],
  "worker jobs/settle-adopt-founder.ts ADOPT_ALERT": [
    "EXECUTED_BY_THIRD_PARTY",
    "ADOPTION_HELD",
    "ADOPTION_MISMATCH",
    "ADOPTION_OWN_TX",
    "ADOPTION_SETTLEMENT_CLOSED",
    "ADOPTION_HISTORY_UNAVAILABLE",
  ],
  "worker rail failure codes named in the repo (rail/mock-rail.ts, rail/xendit-rail.ts, settle-decide.ts)": [
    "PAYOUT_FAILED",
    "INVALID_DESTINATION",
    "TEMPORARY_TRANSFER_ERROR",
    "CANCELLED",
    "REVERSED",
  ],
  "worker jobs/relay.ts": ["RELAY_REFUSED"],
  "api eval-case.ts READER_ + agent reader ReaderRejectReason": ["READER_INVALID_INPUT", "READER_WRONG_ROLE", "READER_REFUSED", "READER_MALFORMED_OUTPUT"],
  "api eval-case.ts refusals": ["OUTBOUND_BLOCKED", "UNDECODED_REVERT", "CHAT_TOO_LONG", "MEMORY_OFF", "NO_PAYMENT_PATH"],
  "api eval-case.ts decoded revert names (Solidity's built-in errors)": ["Error", "Panic"],
  "api eval-case.ts planner outcome kinds without a reason code": ["QUESTIONS", "PLAN"],
  "agent reader/invoice-binding.ts reasons": ["NO_AMOUNT", "CURRENCY_MISMATCH"],
  "agent memory/memory.ts MemoryRejectReason": ["MALFORMED", "WRONG_TENANT", "BAD_KEY", "BAD_HMAC"],
  "api eval-case.ts STRIPE_ + webhooks.ts verifyStripeSignature reasons": ["STRIPE_NOT_CONFIGURED", "STRIPE_MALFORMED", "STRIPE_MISMATCH", "STRIPE_STALE"],
  "mock handlers-ops.ts demo attack default": ["REFUSED"],
  "worker jobs/halt-rules.ts": ["EXTERNAL_AGENT_KEY_USE"],
};

/** The wording lint's checker (scripts/lint-wording): the team's banned words, matched as whole words in any case. */
interface WordingFinding {
  readonly term: string;
}
const LINT = join(ROOT, "scripts/lint-wording/index.mjs");
const { checkText } = (await import(LINT)) as { checkText: (text: string) => readonly WordingFinding[] };
const bannedIn = (text: string): string[] => checkText(text).map((f) => f.term);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sourceFiles(full);
    return /\.(ts|mts|tsx)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name) ? [full] : [];
  });
}

function writtenCodes(): Set<string> {
  const codes = new Set<string>();
  const texts = [
    ...WRITERS.flatMap((d) => sourceFiles(join(ROOT, d))).map((f) => readFileSync(f, "utf8")),
    ...FIXTURE_TRACES.map((f) => readFileSync(join(ROOT, f), "utf8")),
  ];
  for (const text of texts) for (const p of PATTERNS) for (const m of text.matchAll(p)) codes.add(m[1] as string);
  return codes;
}

function knownCodes(): string[] {
  return [...new Set([...writtenCodes(), ...Object.values(FLOWS_IN).flat(), ...CONTRACT_ERROR_NAMES, ...CONSTITUTION_CODES])].sort();
}

describe("trace reason labels", () => {
  it("finds the writers' literal codes in their source", () => {
    const codes = writtenCodes();
    expect(codes.size).toBeGreaterThanOrEqual(60);
    for (const c of ["WITHIN_PLAN", "PayeeNotBound", "INVOICE_ON_PACING_LINE", "STRIPE_LIVEMODE", "VETOED_IN_COOLING", "ORPHAN_SPEND"]) expect(codes).toContain(c);
  });

  it("labels every known reason code", () => {
    const missing = knownCodes().filter((c) => reasonLabel(c) === undefined);
    expect(missing).toEqual([]);
  });

  it("uses plain English: no banned word, no raw code, sentence case and no trailing period", () => {
    for (const code of LABELLED_CODES) {
      const { title, detail } = reasonCopy(code);
      const text = `${title} ${detail ?? ""}`;
      expect(bannedIn(text), code).toEqual([]);
      expect(LABELLED_CODES.filter((c) => /_|[a-z][A-Z]/.test(c) && text.includes(c)), code).toEqual([]);
      expect(title, code).toMatch(/^[A-Z][^]*[^.]$/);
      expect(title.length, code).toBeLessThanOrEqual(60);
    }
    for (const copy of [UNKNOWN_REASON, UNKNOWN_PAYOUT_REASON]) expect(bannedIn(`${copy.title} ${copy.detail ?? ""}`)).toEqual([]);
  });

  it("would catch the raw officer code read as words (the checker is live)", () => {
    expect(bannedIn("OFFICER_TOKEN_REJECTED".toLowerCase().replaceAll("_", " ")).length).toBe(1);
  });

  it("labels the officer access refusals without the banned word", () => {
    expect(reasonCopy("OFFICER_TOKEN_REJECTED").title).toBe("Officer access code not accepted");
    expect(reasonCopy("OFFICER_TOKEN_LOCKED").title).toBe("Officer access locked after repeated wrong codes");
  });

  it("keeps one label per code: REASON_LABELS repeats no contract error or constitution code", () => {
    const core = new Set<string>([...CONTRACT_ERROR_NAMES, ...CONSTITUTION_CODES]);
    expect(Object.keys(REASON_LABELS).filter((c) => core.has(c))).toEqual([]);
  });

  it("gives an unknown code the neutral label, never the code, and ignores inherited keys", () => {
    for (const code of ["SOMETHING_NEW", "toString", "constructor", "__proto__"]) {
      expect(reasonCopy(code)).toBe(UNKNOWN_REASON);
    }
    // Plain error titles (REWRITES C6.3): the contract error PayeeNotBound reads "Not approved to be paid".
    expect(reasonCopy("PayeeNotBound(0xabc)").title).toBe("Not approved to be paid");
    expect(reasonCopy("SOMETHING_NEW", "DENIAL")).toBe(UNKNOWN_REASON);
    expect(reasonCopy("PER_TX_CAP_OVER_25PCT").title).toBe("A per-payment cap is above 25% of its line");
  });
});

describe("payout rail codes", () => {
  it("labels a known rail code on a payout event, and an unknown one as a rail failure without the code", () => {
    expect(reasonCopy("INVALID_DESTINATION", "PAYOUT").title).toBe("Payout account not valid");
    const unknown = reasonCopy("INSUFFICIENT_BALANCE", "PAYOUT");
    expect(unknown).toBe(UNKNOWN_PAYOUT_REASON);
    expect(`${unknown.title} ${unknown.detail ?? ""}`).not.toContain("INSUFFICIENT_BALANCE");
  });
});

describe("plainSummary", () => {
  it("replaces each known code in a summary with its label", () => {
    expect(plainSummary("Planner turn refused (SECRET_REQUEST)")).toBe("Planner turn refused (Asked for a secret; refused)");
    expect(plainSummary("Spend proposal inv-1 → DENY (CapExceeded)")).toBe("Spend proposal inv-1 → DENY (Over the limit)");
    expect(plainSummary("Red-team T1 (x): refused by policy, PayeeNotBound; nothing signed")).toBe(
      "Red-team T1 (x): refused by policy, Not approved to be paid; nothing signed",
    );
  });

  it("leaves plain words, unknown ids and codes inside longer ids alone", () => {
    expect(plainSummary("Paused: spending stops")).toBe("Paused: spending stops");
    expect(plainSummary("marked POLICY_DENIED (not recorded)")).toBe("marked POLICY_DENIED (not recorded)");
    expect(plainSummary("X_WITHIN_PLAN and WITHIN_PLAN_2 stay")).toBe("X_WITHIN_PLAN and WITHIN_PLAN_2 stay");
  });

  it("leaves no labelled multi-word code in any summary built from codes", () => {
    for (const code of LABELLED_CODES.filter((c) => /_|[a-z][A-Z]/.test(c))) {
      expect(plainSummary(`refused (${code}): ${code}`)).not.toContain(code);
    }
  });
});
