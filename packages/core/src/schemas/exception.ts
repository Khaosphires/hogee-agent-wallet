/**
 * Exception (project.md §4, §26.5): a discriminated union on `kind`; each kind has its own payload.
 * Timelock kinds resolve via queueLoosen → executeLoosen; RELEASE_ESCROW_BALANCE, RELEASE_STAGE and
 * REPLAN resolve via direct calls; POLICY_ESCALATION is decided by the officer.
 * G2: POLICY_ESCALATION is a response kind only. The server's spend path opens it (api proposals.ts), so
 * ExceptionCreate no longer offers it and schema validation refuses a caller-built one (422) before any handler runs.
 * G0-AUDIT (v-1): REPLAN is founder-only, so the new version may only tighten the current on-chain state (else
 * commitPlan reverts PlanInvariantViolated(REPLAN_LOOSENS)). A replan that loosens is split into LOOSEN_* kinds
 * (e.g. MOVE_POCKETS), which need the lender's co-signature and the timelock.
 */
import { z } from "zod";
import { CapKind, ExceptionKind, ExceptionRequester, ExceptionStatus, LineKey } from "./enums";
import { Hex32, Id, Minor, OrderId, PayeeId, StageId, Uint8, UnixSeconds } from "./primitives";
import { DerivedSpendProposal } from "./payment";

// Payloads below follow the coordinator's chain-freeze note (HogeeKinds.sol LOOSEN_* kinds).
export const ExceptionPayloads = {
  // G0-DECISION (coordinator note 2): {lineKey, cap, newCapMinor}; cap perTx → LOOSEN_RAISE_PER_TX_CAP,
  // window → LOOSEN_RAISE_WINDOW_CAP.
  RAISE_CAP: z.strictObject({ lineKey: LineKey, cap: CapKind, newCapMinor: Minor }),
  // G0-DECISION (coordinator note 2): one signed LoosenRequest per line, so a single lineKey (was lineKeys[]).
  ADD_PAYEE: z.strictObject({ payeeId: PayeeId, lineKey: LineKey }),
  // G0-DECISION (coordinator note 2): nested union on target; lineKey is required for target "line" and
  // rejected for target "agent" (LOOSEN_EXTEND_AGENT_EXPIRY / LOOSEN_EXTEND_LINE_EXPIRY).
  EXTEND_EXPIRY: z.discriminatedUnion("target", [
    z.strictObject({ target: z.literal("agent"), newExpiresAt: UnixSeconds }),
    z.strictObject({ target: z.literal("line"), lineKey: LineKey, newExpiresAt: UnixSeconds }),
  ]),
  MOVE_POCKETS: z.strictObject({ fromLineKey: LineKey, toLineKey: LineKey, amountMinor: Minor }),
  // G0-DECISION (coordinator note 2): lineKey absent = whole treasury; present = that line (also closes its circuit).
  UNPAUSE: z.strictObject({ lineKey: LineKey.optional() }),
  WITHDRAW_RESERVE: z.strictObject({ amountMinor: Minor, taxPayeeId: PayeeId }),
  RELEASE_ESCROW_BALANCE: z.strictObject({ orderId: OrderId, idx: Uint8, evidenceHash: Hex32 }),
  RELEASE_STAGE: z.strictObject({ stageId: StageId }),
  REPLAN: z.strictObject({ draftId: Id }),
  // G0-REVIEW (D6/H1): `proposal` holds the SERVER-DERIVED spend {lineKey, payeeId, amountMinor, invoiceId?,
  // pacingSlot?}. payeeId and amountMinor come from the bound invoice or the manifest's pacing, never the caller.
  POLICY_ESCALATION: z.strictObject({ proposal: DerivedSpendProposal }),
} as const satisfies { readonly [K in ExceptionKind]: z.ZodType };

/** Kinds that resolve through the loosening timelock (queueLoosen → executeLoosen). */
export const TIMELOCK_EXCEPTION_KINDS = [
  "RAISE_CAP",
  "ADD_PAYEE",
  "EXTEND_EXPIRY",
  "MOVE_POCKETS",
  "UNPAUSE",
  "WITHDRAW_RESERVE",
] as const satisfies readonly ExceptionKind[];

const ExceptionBase = z.strictObject({
  exceptionId: Id,
  title: z.string().min(1).max(200),
  requestedBy: ExceptionRequester,
  requires: z.strictObject({ founder: z.boolean(), lender: z.boolean() }),
  status: ExceptionStatus,
  // G0-DECISION: timelock is null until queued, and always null for direct kinds.
  timelock: z.strictObject({ queuedAt: UnixSeconds, executableAt: UnixSeconds }).nullable(),
  txs: z.strictObject({ queue: Hex32.optional(), execute: Hex32.optional() }),
  blastRadiusMinor: Minor,
  traceId: Id,
});

const variant = <K extends ExceptionKind>(kind: K) =>
  ExceptionBase.extend({ kind: z.literal(kind), payload: ExceptionPayloads[kind] });

export const Exception = z.discriminatedUnion("kind", [
  variant("RAISE_CAP"),
  variant("ADD_PAYEE"),
  variant("EXTEND_EXPIRY"),
  variant("MOVE_POCKETS"),
  variant("UNPAUSE"),
  variant("WITHDRAW_RESERVE"),
  variant("RELEASE_ESCROW_BALANCE"),
  variant("RELEASE_STAGE"),
  variant("REPLAN"),
  variant("POLICY_ESCALATION"),
]);
export type Exception = z.infer<typeof Exception>;
export type ExceptionOf<K extends ExceptionKind> = Extract<Exception, { kind: K }>;

const requestVariant = <K extends ExceptionKind>(kind: K) =>
  z.strictObject({ kind: z.literal(kind), payload: ExceptionPayloads[kind], reason: z.string().min(1).max(500) });

/** POST /api/exceptions (founder) body: {kind, payload, reason}. Every kind but POLICY_ESCALATION (G2). */
export const ExceptionCreate = z.discriminatedUnion("kind", [
  requestVariant("RAISE_CAP"),
  requestVariant("ADD_PAYEE"),
  requestVariant("EXTEND_EXPIRY"),
  requestVariant("MOVE_POCKETS"),
  requestVariant("UNPAUSE"),
  requestVariant("WITHDRAW_RESERVE"),
  requestVariant("RELEASE_ESCROW_BALANCE"),
  requestVariant("RELEASE_STAGE"),
  requestVariant("REPLAN"),
]);
export type ExceptionCreate = z.infer<typeof ExceptionCreate>;
