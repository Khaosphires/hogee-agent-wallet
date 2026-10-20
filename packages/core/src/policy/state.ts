/** Small helpers shared by the policy evaluators, and the context of a freshly committed plan. */
import { CONTRACT_ERROR_NAMES, type ExceptionKind, type LineKey, type PolicyVerdict } from "../schemas/enums";
import type { PlanManifest } from "../schemas/plan";
import type { Hex32 } from "../schemas/primitives";
import { parseMinor } from "../money/index";
import { registryEntryFor } from "../constitution/check";
import type { CommittedLine, CommittedPlan, ConstitutionFacility } from "../constitution/types";
import type { PolicyContext, PolicyDecision, PolicyLineState, PolicyPayeeState } from "./types";

const CONTRACT_ERRORS: ReadonlySet<string> = new Set(CONTRACT_ERROR_NAMES);

export function allow(reasonCode = "WITHIN_PLAN"): PolicyDecision {
  return { verdict: "AUTO", reasonCode, mirrorsRevert: false };
}

export function deny(reasonCode: string, extra: Omit<Partial<PolicyDecision>, "verdict" | "reasonCode" | "mirrorsRevert"> = {}): PolicyDecision {
  return { verdict: "DENY", reasonCode, mirrorsRevert: CONTRACT_ERRORS.has(reasonCode), ...extra };
}

export function escalate(verdict: Exclude<PolicyVerdict, "AUTO" | "DENY">, reasonCode: string, exceptionKind: ExceptionKind): PolicyDecision {
  return { verdict, reasonCode, mirrorsRevert: false, exceptionKind };
}

export function nowOf(ctx: PolicyContext): bigint {
  return typeof ctx.now === "bigint" ? ctx.now : parseMinor(ctx.now, "now");
}

/** §8.4 first line: caller is a live agent and the treasury is not paused (NotAgent → Paused → AgentExpired). */
export function agentGate(ctx: PolicyContext, allowWhilePaused = false): PolicyDecision | null {
  if (ctx.agent.revoked) return deny("NotAgent");
  if (ctx.paused && !allowWhilePaused) return deny("Paused");
  if (nowOf(ctx) > parseMinor(ctx.agent.expiresAt, "agent expiresAt")) return deny("AgentExpired");
  return null;
}

/** The payee's cooling (veto) period has not ended: Treasury reverts PayeeCooling while now < coolingUntil. */
export function isCooling(ctx: PolicyContext, payee: PolicyPayeeState): boolean {
  return payee.coolingUntil !== undefined && nowOf(ctx) < parseMinor(payee.coolingUntil, "coolingUntil");
}

/** A static platform payee (Treasury._platformPayout, fixed at deployment), on any line or none. */
export function isPlatformPayee(ctx: PolicyContext, payeeId: string): boolean {
  return ctx.payees.some((p) => p.payeeId === payeeId && p.source === "platform");
}

export function planLine(ctx: PolicyContext, lineKey: LineKey): PlanManifest["lines"][number] | undefined {
  return ctx.plan.lines.find((l) => l.lineKey === lineKey);
}

/** The mirrored state of a line; only the context's own keys count ('constructor' or '__proto__' is not a line). */
export function lineState(ctx: PolicyContext, lineKey: LineKey): PolicyLineState | undefined {
  return Object.hasOwn(ctx.lines, lineKey) ? ctx.lines[lineKey] : undefined;
}

/** The payee's binding to a line (bound payee or platform registry entry), if any. */
export function payeeState(ctx: PolicyContext, payeeId: string, lineKey: LineKey): PolicyPayeeState | undefined {
  return registryEntryFor(ctx.payees, payeeId, lineKey) as PolicyPayeeState | undefined;
}

/** Payees listed on the line in the current plan version (the mirrored on-chain list, else the manifest's). */
export function listedPayeeIds(ctx: PolicyContext, lineKey: LineKey): readonly string[] {
  return lineState(ctx, lineKey)?.payeeIds ?? planLine(ctx, lineKey)?.payeeIds ?? [];
}

/**
 * The binding Treasury.spend pays through: the payee must be bound to the line AND listed on it in the current plan
 * version (a re-commit that drops a payee de-authorises it; the binding stays). Escrow funding does not use this.
 */
export function spendablePayeeState(ctx: PolicyContext, payeeId: string, lineKey: LineKey): PolicyPayeeState | undefined {
  return listedPayeeIds(ctx, lineKey).includes(payeeId) ? payeeState(ctx, payeeId, lineKey) : undefined;
}

/**
 * The on-chain plan a REPLAN must tighten (G0-AUDIT v-1): the committed manifest with the mirrored runtime values
 * (current allocations and caps, extended expiries, raised reserve) and, per line, its payeeIds plus the payees
 * bound to it since. A line without mirrored state is left out, so a re-commit naming it fails closed
 * (REPLAN_LOOSENS: the line set differs).
 */
export function committedPlanFromContext(ctx: PolicyContext): CommittedPlan {
  const lines: CommittedLine[] = [];
  for (const l of ctx.plan.lines) {
    const s = lineState(ctx, l.lineKey);
    if (!s) continue;
    const bound = ctx.payees.filter((p) => p.source === "bound" && (p.lineKeys as readonly string[]).includes(l.lineKey)).map((p) => p.payeeId);
    lines.push({
      lineKey: l.lineKey,
      amountMinor: s.allocatedMinor,
      perTxCapMinor: s.perTxCapMinor,
      windowCapMinor: s.windowCapMinor,
      windowSeconds: l.windowSeconds,
      validUntil: s.validUntil,
      pacingMinor: l.pacing?.amountMinor ?? "0",
      escrowOnly: l.escrowOnly,
      payeeIds: [...new Set([...l.payeeIds, ...bound])],
    });
  }
  return {
    planId: ctx.plan.planId,
    version: ctx.planVersion,
    planHash: ctx.planHash,
    countryPackHash: ctx.plan.countryPackHash,
    totalMinor: ctx.plan.totalMinor,
    reserveBps: ctx.reserveBps,
    agent: { address: ctx.plan.agent.address, expiresAt: ctx.agent.expiresAt },
    stages: ctx.plan.stages,
    lines,
  };
}

/** Context right after commitPlan: stage 1 released, nothing spent, every line live. */
export function initialPolicyContext(plan: PlanManifest, planHash: Hex32, facility: ConstitutionFacility, now: bigint): PolicyContext {
  const lines: Partial<Record<LineKey, PolicyLineState>> = {};
  for (const l of plan.lines) {
    lines[l.lineKey] = {
      allocatedMinor: l.amountMinor,
      spentMinor: "0",
      escrowedMinor: "0",
      perTxCapMinor: l.perTxCapMinor,
      windowCapMinor: l.windowCapMinor,
      windowSpentMinor: "0",
      windowLiveSpends: 0,
      validUntil: l.validUntil,
      paused: false,
      circuitOpen: false,
      // Mirrors Treasury.lineSequence: a pacing line's first slot is 1 (slot 0 reverts DuplicateInvoice); 0 otherwise.
      nextSequence: l.pacing ? 1 : 0,
    };
  }
  return {
    now,
    plan,
    planHash,
    planVersion: plan.version,
    paused: false,
    agent: { revoked: false, expiresAt: plan.agent.expiresAt },
    releasedMinor: plan.stages[0]?.releaseMinor ?? "0",
    totalSpentMinor: "0",
    totalEscrowedMinor: "0",
    reserveMinor: "0",
    reserveBps: plan.reserveBps,
    lines,
    payees: facility.payees.map((p) => ({ ...p, paidMinor: "0" })),
    usedIntents: new Set(),
    paidInvoices: new Set(),
    escrowOrders: [],
    stages: plan.stages.map((s, i) => ({ stageId: s.stageId, released: i === 0 })),
    facility,
  };
}
