/**
 * Plain-English labels for trace reason codes, shown in the timeline. A reason code is the machine id a trace event
 * carries (≤ 32 chars, also stored on-chain for denials): a contract error (PayeeNotBound), a constitution code, or a
 * code from the policy engine, the planner, the API, the worker or the mock (WITHIN_PLAN, CHAT_RATE_LIMITED).
 * Users see only the label, never the code: contract errors and constitution codes use core's copy (errors/copy.ts),
 * every other code is labelled here, and an unknown code gets a neutral label. reason-labels.test.ts reads the trace
 * writers' source, so a new literal code fails until it is labelled here.
 */
import { CONSTITUTION_COPY, CONTRACT_ERROR_COPY } from "@hogee/core";

export interface ReasonCopy {
  /** Short headline, sentence case, no trailing period. */
  readonly title: string;
  /** One or two sentences, when core's copy has them (contract errors). */
  readonly detail?: string;
}

/** Every reason code that is not a contract error or a constitution code. Labels follow errors/copy.ts's wording rules. */
export const REASON_LABELS: Readonly<Record<string, string>> = {
  // Policy engine (packages/core/src/policy)
  WITHIN_PLAN: "Within the signed plan",
  WITHIN_SCHEDULE: "Within the signed milestone schedule",
  TIGHTEN_OK: "Allowed: it only tightens the rules",
  LOOSEN_EXECUTABLE: "Loosening cleared its timelock and both signatures",
  SALE_RECORDABLE: "Sale can be recorded",
  INVALID_AMOUNT: "Amount can't be read",
  INVOICE_ON_PACING_LINE: "This pocket pays on a schedule, not by invoice",
  PACING_NOT_ALLOWED: "This pocket has no payment schedule",
  PACING_HASH_MISMATCH: "Scheduled payment doesn't match its slot",
  PACING_SLOT_AHEAD: "Scheduled payment is ahead of its turn",
  NOT_A_LOOSENING: "Not a loosening: the new value isn't higher",
  STALE_PLAN_VERSION: "Built for an older plan version",
  TAINTED_PAYEE: "Payee came from an unverified document",
  TAINTED_ACTION: "Action came from an unverified document",
  TAINTED_CAP: "Limit change came from an unverified document",
  TAINTED_OUTBOUND: "Unverified text can't leave the system",
  PRIVATE_OUTBOUND: "Private data can't leave the system",
  FOUNDER_SIGNATURE_REQUIRED: "Needs the founder's signature",
  FOUNDER_RELEASE_REQUIRED: "Only the founder can release this",
  FLAGGED_INVOICE: "Invoice flagged for the loan officer",
  LOOSEN_NEEDS_BOTH_SIGS: "Loosening needs the founder and the loan officer",
  STAGE_GATE_MET: "Stage target met; the loan officer releases it",
  ALREADY_PROPOSED_TODAY: "Today's scheduled payment is already proposed",

  // Planner and plan compiler (packages/agent/src/planner, packages/core/src/compiler)
  SECRET_REQUEST: "Asked for a secret; refused",
  MODEL_REFUSAL: "The model declined to answer",
  MALFORMED_INTENT: "AI proposal was malformed and not used",
  NO_PROPOSAL: "AI ended its turn without a proposal",
  INVALID_INTENT: "AI proposal didn't have the expected shape",
  COUNTRY_NOT_FACILITY: "AI proposal named another country",
  BUDGET_UNCLEAR: "Budget unclear; the founder was asked",
  BUDGET_NOT_STATED: "Budget not stated; the founder was asked",
  INVALID_INPUT: "Plan input isn't valid",
  COUNTRY_MISMATCH: "Plan is for another country",
  CURRENCY_MISMATCH: "Currency does not match the plan",
  BUDGET_TOO_SMALL: "Budget too small for the required pockets",
  ENTITY_INELIGIBLE: "Business type not eligible",
  AGENT_EXPIRY_INFEASIBLE: "Agent key validity can't meet the rules",
  LICENSING_EXCEEDS_CONTINGENCY: "Licensing costs exceed the contingency pocket",
  FEE_TOO_LARGE: "A plan rule could not be recorded",
  COMPILE_FAILED: "Plan can't be compiled",
  PACK_FACT_MISSING: "Country data is missing a fact",

  // API (packages/api/src)
  OFFICER_TOKEN_REJECTED: "Officer access code not accepted",
  OFFICER_TOKEN_LOCKED: "Officer access locked after repeated wrong codes",
  CHAT_RATE_LIMITED: "Too many chat messages; nothing was sent",
  RATE_LIMITED: "Too many requests; nothing was sent",
  MODEL_BUDGET_EXHAUSTED: "Model budget used up; no model call made",
  INVALID_SIGNATURE: "Signature didn't verify",
  STRIPE_LIVEMODE: "Live payment ignored: test mode only",
  STRIPE_UNREADABLE: "Payment notice unreadable; ignored",
  STRIPE_OTHER_FACILITY: "Payment for another facility; ignored",
  STRIPE_UNPAID: "Payment not completed; ignored",
  STRIPE_CURRENCY: "Payment in another currency; ignored",
  STRIPE_ZERO_AMOUNT: "Zero or negative payment; ignored",
  STRIPE_BELOW_BUCKET: "Payment below the smallest counted amount; ignored",
  STRIPE_NO_PAYMENT: "No payment to count; ignored",
  STRIPE_DUPLICATE_PAYMENT: "Payment already counted; ignored",
  TARGET_IN_REPLY: "Attack target appeared in the reply",
  MEMORY_ACCEPTED: "Planted memory was accepted",
  SIGNATURE_VALID: "Payment signature verified",

  // Evaluation runs (packages/api/src/services/eval-case.ts; Reader and memory reasons from packages/agent)
  READER_INVALID_INPUT: "Reader refused: the document input isn't valid",
  READER_WRONG_ROLE: "Reader refused: not set up with a reader model",
  READER_REFUSED: "Reader model declined the document",
  READER_MALFORMED_OUTPUT: "Reader's answer was malformed and not used",
  OUTBOUND_BLOCKED: "Outbound check blocked the model call",
  NO_AMOUNT: "No amount found in the invoice",
  UNDECODED_REVERT: "The chain would refuse it (no readable reason)",
  Error: "The chain would refuse it with a message",
  Panic: "The chain would refuse it on an internal check",
  CHAT_TOO_LONG: "Chat message too long; refused",
  QUESTIONS: "The planner asked the founder questions",
  PLAN: "The planner proposed a plan",
  MEMORY_OFF: "Memory is off; nothing read or written",
  MALFORMED: "Memory entry malformed; rejected",
  WRONG_TENANT: "Memory from another facility; rejected",
  BAD_KEY: "Memory entry under an unknown key; rejected",
  BAD_HMAC: "Memory entry failed its integrity check; rejected",
  STRIPE_NOT_CONFIGURED: "Payment notice check not set up; refused",
  STRIPE_MALFORMED: "Payment notice signature malformed; refused",
  STRIPE_MISMATCH: "Payment notice signature doesn't match; refused",
  STRIPE_STALE: "Payment notice signature too old; refused",
  NO_PAYMENT_PATH: "A listing can't create a payee",

  // Worker (apps/worker/src)
  OFFICER_OVERRIDE: "Loan officer override, re-checked against every cap",
  OFFICER_OVERRIDE_REFUSED: "Loan officer override refused at signing",
  SPEND_PROPOSAL_DENIED: "Spend proposal refused at signing",
  FOUNDER_RELAY_REFUSED: "Founder's signed payment not relayed",
  VETO_RECONCILED: "Veto confirmed on-chain",
  VETOED_LOOSEN_EXECUTED: "A vetoed loosening was carried out on-chain",
  VETOED_LOOSEN_QUEUED: "A vetoed loosening is still queued on-chain",
  VETO_CANCEL_RETRIES_EXHAUSTED: "Cancelling a vetoed loosening kept failing",
  SETTLEMENT_CONFIRMED_ELSEWHERE: "Payout confirmed by another transaction",
  PAYOUT_ROUTE_REFUSED: "Payout route refused",
  SETTLEMENT_CALL_REVERTED: "Settlement call reverted; payouts halted",
  PAYOUT_STATUS_MISMATCH: "Payout status doesn't match the chain; payouts halted",
  SETTLEMENT_CONTRADICTION: "Payout and chain disagree; payouts halted",
  PAYOUT_CONFLICT: "Rail refused a conflicting payout; payouts halted",
  EXTERNAL_AGENT_KEY_USE: "Agent key used outside the backend; work halted",
  ORPHAN_SPEND: "Payment with no matching record; treasury paused",
  INVOICE_PAYEE_MISMATCH: "Invoice names another payee",
  INVOICE_AMOUNT_MISMATCH: "Invoice amount differs",
  INVOICE_NOT_FOUND: "Invoice not found",
  MALFORMED_PAYLOAD: "Approved request is malformed",
  NO_LINE: "No budget pocket named",
  LINE_ID_MISMATCH: "Budget pocket doesn't match",
  RELAY_REFUSED: "Signed request not relayed",
  INTENT_MISMATCH: "Payment intent doesn't match its record",
  SPEND_MISMATCH: "Payout doesn't match the on-chain payment",
  DESTINATION_MISMATCH: "Payout account doesn't match the payee",
  EXECUTED_BY_THIRD_PARTY: "Founder's signed payment sent by another account",
  ADOPTION_HELD: "Not taken over: an earlier attempt still holds it",
  ADOPTION_MISMATCH: "Payment sent by another account doesn't match",
  ADOPTION_OWN_TX: "Already settled by one of our own payments",
  ADOPTION_SETTLEMENT_CLOSED: "Settlement already closed; not taken over",
  ADOPTION_HISTORY_UNAVAILABLE: "Chain history unavailable; retrying quietly",
  // Payout rail failures (apps/worker/src/rail; any other rail code gets the neutral label)
  PAYOUT_FAILED: "Payout failed",
  INVALID_DESTINATION: "Payout account not valid",
  TEMPORARY_TRANSFER_ERROR: "Bank transfer failed for now",
  CANCELLED: "Payout cancelled by the rail",
  REVERSED: "Payout reversed by the rail",

  // Mock and demo (packages/api-mock/src)
  VETOED_IN_COOLING: "Payee change vetoed while cooling down",
  AI_INJECTION: "Instructions aimed at AI agents; flagged",
  RANKED_UNGATED: "No gate caught the page; listed only as unverified",
  CHAT_SESSION_FULL: "This conversation is full; start a new one",
  ONLY_TIGHTEN: "Research can only tighten rules",
  ENCODED_PAYLOAD: "Hidden encoded instruction ignored",
  MEMORY_UNTRUSTED: "Untrusted memory can't change payments",
  FAKE_REPORT: "Inspection report looks forged",
  DIGEST_MISMATCH: "What you see differs from what you sign",
  DATA_EXTRACTION: "Asked for secrets; refused",
  CROSS_TENANT: "Asked for another facility's data; refused",
  PII_EXFILTRATION: "Personal data can't leave the device",
  RECOVERED_NO_RESEND: "Recovered after a restart; nothing sent twice",
  TIMELOCK_EXECUTED: "Timelock passed with no veto",
  MOCK_EVAL: "Demo evaluation case refused",
  OWNER_SIGNED: "Paid with the founder's own signature",
  REFUSED: "Refused by policy",
};

export const UNKNOWN_REASON: ReasonCopy = {
  title: "Other reason",
  detail: "This reason has no plain-English label yet; the evidence log keeps it.",
};

/** An unlabelled code on a PAYOUT event: the payout rail's own failure code (Xendit's failure_code is open-ended). */
export const UNKNOWN_PAYOUT_REASON: ReasonCopy = {
  title: "Payout failed (rail code)",
  detail: "The payout rail gave a failure code with no plain-English label yet; the evidence log keeps it.",
};

const has = (o: object, key: string): boolean => Object.hasOwn(o, key);

/** Contract error, constitution or other label for `code`; undefined when it has none. Tolerates "Name(args)". */
export function reasonLabel(code: string): ReasonCopy | undefined {
  const name = code.replace(/\(.*$/s, "").trim();
  if (has(CONTRACT_ERROR_COPY, name)) return CONTRACT_ERROR_COPY[name as keyof typeof CONTRACT_ERROR_COPY];
  if (has(CONSTITUTION_COPY, name)) return { title: CONSTITUTION_COPY[name as keyof typeof CONSTITUTION_COPY] };
  const label = has(REASON_LABELS, name) ? REASON_LABELS[name] : undefined;
  return label === undefined ? undefined : { title: label };
}

/** What the timeline shows for a reason code on an event of `kind`: its label, or a neutral one. Never the code. */
export const reasonCopy = (code: string, kind?: string): ReasonCopy =>
  reasonLabel(code) ?? (kind === "PAYOUT" ? UNKNOWN_PAYOUT_REASON : UNKNOWN_REASON);

/** Every labelled code (contract errors, constitution codes and REASON_LABELS). */
export const LABELLED_CODES: readonly string[] = [...Object.keys(CONTRACT_ERROR_COPY), ...Object.keys(CONSTITUTION_COPY), ...Object.keys(REASON_LABELS)];

/**
 * Codes rewritten inside free text: ids with an underscore or an inner capital (CapExceeded, WITHIN_PLAN). A one-word
 * code such as "Paused" already reads as English and could be an ordinary word, so it stays.
 */
const isMultiWord = (code: string): boolean => /_|[a-z][A-Z]/.test(code);
const escape = (code: string): string => code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IN_TEXT_CODES = LABELLED_CODES.filter(isMultiWord)
  .sort((a, b) => b.length - a.length)
  .map(escape);
const IN_TEXT = new RegExp(`(?<![A-Za-z0-9_])(?:${IN_TEXT_CODES.join("|")})(?![A-Za-z0-9_])`, "g");

/** A trace summary with each known reason code replaced by its label, e.g. "refused (CapExceeded)" → "refused (Over the cap)". */
export const plainSummary = (summary: string): string => summary.replace(IN_TEXT, (code) => reasonCopy(code).title);
