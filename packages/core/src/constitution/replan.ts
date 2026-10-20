/**
 * Replan rules of PlanRegistry.commitPlan (G0-AUDIT v-1; IPlanRegistry.commitPlan NatSpec, project.md §8.3).
 *
 * 1. Sequencing → StalePlan: version == planVersion() + 1 with the same planId and prevPlanHash == the stored
 *    planHash. With no plan yet (planVersion() == 0): version 1 and prevPlanHash 0, any planId.
 * 2. Code 14 REPLAN_LOOSENS: once a plan exists (stored planVersion() > 0, not the signed number) only the founder
 *    has signed, so a re-commit may only TIGHTEN the current on-chain state:
 *    - the same set of lineIds; every amountMinor equals the line's current allocation (after MOVE_POCKETS);
 *      stages, totalMinor and countryPackHash identical;
 *    - per line: perTxCap, windowCap and validUntil ≤ current; windowSeconds ≥ current; pacing ≤ current and
 *      zero only if zero now (never switched to or from 0); escrowOnly never cleared; payeeIds within the line's
 *      current payees (its payeeIds plus payees bound to it since);
 *    - reserveBps ≥ current; same agent; agentExpiry ≤ current.
 *    Anything else is a loosening and needs a lender-co-signed LOOSEN_* kind (compiler/replan.ts routes them).
 *
 * Pure and integer-only. Unreadable values fail closed (an UNREADABLE loosening).
 */
import type { LineKey } from "../schemas/enums";
import type { PlanManifest, PlanStage } from "../schemas/plan";
import { ZERO_HEX32, type Hex32 } from "../schemas/primitives";
import { tryParseMinor } from "../money/index";
import type { CommittedLine, CommittedPlan } from "./types";

export const REPLAN_LOOSENING_RULES = [
  "UNREADABLE",
  "TOTAL_CHANGED",
  "COUNTRY_PACK_CHANGED",
  "STAGES_CHANGED",
  "RESERVE_LOWERED",
  "AGENT_CHANGED",
  "AGENT_EXPIRY_EXTENDED",
  "LINE_SET_CHANGED",
  "AMOUNT_CHANGED",
  "PER_TX_CAP_RAISED",
  "WINDOW_CAP_RAISED",
  "VALID_UNTIL_EXTENDED",
  "WINDOW_SHORTENED",
  "PACING_RAISED",
  "PACING_SWITCHED",
  "ESCROW_CLEARED",
  "PAYEE_ADDED",
] as const;
export type ReplanLooseningRule = (typeof REPLAN_LOOSENING_RULES)[number];

/** One way a re-commit loosens the current state. Values are digit strings, ids, bps or booleans; null = absent. */
export interface ReplanLoosening {
  readonly rule: ReplanLooseningRule;
  readonly lineKey?: LineKey;
  readonly payeeId?: string;
  readonly stageId?: string;
  /** UNREADABLE only: the field that could not be read. */
  readonly field?: string;
  readonly current: string | number | boolean | null;
  readonly proposed: string | number | boolean | null;
}

type Line = PlanManifest["lines"][number];

const big = (v: unknown): bigint | null => (typeof v === "bigint" ? (v >= 0n ? v : null) : tryParseMinor(v));

/** A plan exists on-chain (stored planVersion() > 0). */
export function hasCommittedPlan(current: CommittedPlan | null | undefined): current is CommittedPlan {
  return current !== null && current !== undefined && current.version > 0;
}

/** On-chain state right after committing `manifest` (nothing tightened, loosened or bound since). */
export function committedPlanOf(manifest: PlanManifest, planHash: Hex32): CommittedPlan {
  return {
    planId: manifest.planId,
    version: manifest.version,
    planHash,
    countryPackHash: manifest.countryPackHash,
    totalMinor: manifest.totalMinor,
    reserveBps: manifest.reserveBps,
    agent: { address: manifest.agent.address, expiresAt: manifest.agent.expiresAt },
    stages: manifest.stages,
    lines: manifest.lines.map((l) => ({
      lineKey: l.lineKey,
      amountMinor: l.amountMinor,
      perTxCapMinor: l.perTxCapMinor,
      windowCapMinor: l.windowCapMinor,
      windowSeconds: l.windowSeconds,
      validUntil: l.validUntil,
      pacingMinor: l.pacing?.amountMinor ?? "0",
      escrowOnly: l.escrowOnly,
      payeeIds: l.payeeIds,
    })),
  };
}

/** StalePlan unless `manifest` is the next compare-and-swap step after `current` (null = no plan yet). */
export function checkPlanSequence(manifest: PlanManifest, current: CommittedPlan | null | undefined): "StalePlan" | null {
  if (!hasCommittedPlan(current)) return manifest.version === 1 && manifest.prevPlanHash === ZERO_HEX32 ? null : "StalePlan";
  const next = manifest.version === current.version + 1 && manifest.planId === current.planId && manifest.prevPlanHash === current.planHash;
  return next ? null : "StalePlan";
}

class Findings {
  readonly out: ReplanLoosening[] = [];

  push(rule: ReplanLooseningRule, current: ReplanLoosening["current"], proposed: ReplanLoosening["proposed"], at: Partial<ReplanLoosening> = {}): void {
    this.out.push({ rule, ...at, current, proposed });
  }

  unreadable(field: string, lineKey?: LineKey): void {
    this.push("UNREADABLE", null, null, { field, ...(lineKey ? { lineKey } : {}) });
  }

  /** Numeric rule: push `rule` when `loosens(proposed, current)`; unreadable values fail closed. */
  number(rule: ReplanLooseningRule, field: string, current: unknown, proposed: unknown, loosens: (p: bigint, c: bigint) => boolean, lineKey?: LineKey): void {
    const c = big(current);
    const p = big(proposed);
    if (c === null || p === null) return this.unreadable(field, lineKey);
    if (loosens(p, c)) this.push(rule, c.toString(), p.toString(), lineKey ? { lineKey } : {});
  }
}

/** Canonical form of a stage (numbers normalised), or null when unreadable. */
function stageKey(s: unknown): string | null {
  if (typeof s !== "object" || s === null) return null;
  const st = s as PlanStage;
  const release = big(st.releaseMinor);
  if (typeof st.stageId !== "string" || release === null) return null;
  if (st.gate === null) return JSON.stringify([st.stageId, release.toString(), null]);
  const target = big(st.gate?.target);
  const deadline = big(st.gate?.deadline);
  if (target === null || deadline === null) return null;
  return JSON.stringify([st.stageId, release.toString(), st.gate.metric, target.toString(), deadline.toString()]);
}

function checkStages(proposed: unknown, current: readonly PlanStage[], f: Findings): void {
  if (!Array.isArray(proposed)) return f.unreadable("stages");
  const n = Math.max(proposed.length, current.length);
  for (let i = 0; i < n; i += 1) {
    const p = i < proposed.length ? stageKey(proposed[i]) : null;
    const c = i < current.length ? stageKey(current[i]) : null;
    if ((i < proposed.length && p === null) || (i < current.length && c === null)) {
      f.unreadable(`stages/${i}`);
    } else if (p !== c) {
      const stageId = (proposed[i] as PlanStage | undefined)?.stageId ?? current[i]?.stageId;
      f.push("STAGES_CHANGED", c, p, stageId ? { stageId } : {});
    }
  }
}

function checkPlanLevel(m: PlanManifest, c: CommittedPlan, f: Findings): void {
  f.number("TOTAL_CHANGED", "totalMinor", c.totalMinor, m.totalMinor, (p, cur) => p !== cur);
  if (m.countryPackHash !== c.countryPackHash) f.push("COUNTRY_PACK_CHANGED", c.countryPackHash, m.countryPackHash ?? null);
  checkStages(m.stages, c.stages, f);
  if (!Number.isInteger(m.reserveBps) || !Number.isInteger(c.reserveBps)) f.unreadable("reserveBps");
  else if (m.reserveBps < c.reserveBps) f.push("RESERVE_LOWERED", c.reserveBps, m.reserveBps);
  const address = m.agent?.address;
  if (typeof address !== "string" || address.toLowerCase() !== c.agent.address.toLowerCase()) {
    f.push("AGENT_CHANGED", c.agent.address, typeof address === "string" ? address : null);
  }
  f.number("AGENT_EXPIRY_EXTENDED", "agent/expiresAt", c.agent.expiresAt, m.agent?.expiresAt, (p, cur) => p > cur);
}

function checkLine(p: Line, c: CommittedLine, f: Findings): void {
  const k = c.lineKey;
  f.number("AMOUNT_CHANGED", "amountMinor", c.amountMinor, p.amountMinor, (a, b) => a !== b, k);
  f.number("PER_TX_CAP_RAISED", "perTxCapMinor", c.perTxCapMinor, p.perTxCapMinor, (a, b) => a > b, k);
  f.number("WINDOW_CAP_RAISED", "windowCapMinor", c.windowCapMinor, p.windowCapMinor, (a, b) => a > b, k);
  f.number("VALID_UNTIL_EXTENDED", "validUntil", c.validUntil, p.validUntil, (a, b) => a > b, k);
  f.number("WINDOW_SHORTENED", "windowSeconds", c.windowSeconds, p.windowSeconds, (a, b) => a < b, k);
  const pacing = p.pacing === undefined ? "0" : p.pacing?.amountMinor;
  const pc = big(pacing);
  const cc = big(c.pacingMinor);
  if (pc === null || cc === null) f.unreadable("pacing", k);
  else if ((pc === 0n) !== (cc === 0n)) f.push("PACING_SWITCHED", cc.toString(), pc.toString(), { lineKey: k });
  else if (pc > cc) f.push("PACING_RAISED", cc.toString(), pc.toString(), { lineKey: k });
  if (c.escrowOnly && p.escrowOnly !== true) f.push("ESCROW_CLEARED", true, p.escrowOnly === false ? false : null, { lineKey: k });
  if (!Array.isArray(p.payeeIds)) return f.unreadable("payeeIds", k);
  const allowed = new Set(c.payeeIds);
  for (const payeeId of p.payeeIds) if (!allowed.has(payeeId)) f.push("PAYEE_ADDED", null, String(payeeId), { lineKey: k, payeeId: String(payeeId) });
}

function checkLines(m: PlanManifest, c: CommittedPlan, f: Findings): void {
  if (!Array.isArray(m.lines)) return f.unreadable("lines");
  const proposed = new Map<string, Line>();
  for (const l of m.lines as Line[]) {
    if (proposed.has(l?.lineKey)) f.push("LINE_SET_CHANGED", null, String(l.lineKey), { lineKey: l.lineKey });
    proposed.set(l?.lineKey, l);
  }
  const currentKeys = new Set<string>(c.lines.map((l) => l.lineKey));
  for (const l of m.lines as Line[]) if (!currentKeys.has(l?.lineKey)) f.push("LINE_SET_CHANGED", null, String(l?.lineKey), { lineKey: l?.lineKey });
  for (const cl of c.lines) {
    const pl = proposed.get(cl.lineKey);
    if (pl === undefined) f.push("LINE_SET_CHANGED", cl.lineKey, null, { lineKey: cl.lineKey });
    else checkLine(pl, cl, f);
  }
}

/**
 * Every way `manifest` loosens `current` (empty = tighten-only, code 14 passes). No plan yet → empty (only the
 * first commit releases stage 0, and codes 1-13 alone apply). Deterministic order: plan-level fields, then the
 * lines in stored order.
 */
export function replanLoosenings(manifest: PlanManifest, current: CommittedPlan | null | undefined): ReplanLoosening[] {
  if (!hasCommittedPlan(current)) return [];
  const f = new Findings();
  checkPlanLevel(manifest, current, f);
  checkLines(manifest, current, f);
  return f.out;
}
