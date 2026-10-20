/**
 * Replan routing (G0-AUDIT v-1). A founder-only re-commit (REPLAN) may only tighten the current on-chain plan
 * (constitution code 14). routeReplan splits a draft into:
 *   - nothing to do but the founder's signature (`tightenOnly`), or
 *   - the lender-co-signed LOOSEN_* exceptions that make each loosening (founder + lender + timelock), in
 *     execution order: pocket moves first (executeLoosen bounds a cap raise by the line's new amount), then cap
 *     raises, expiry extensions and payee additions in the order the rule found them;
 *   - loosenings no LOOSEN_* kind can make (`unsupported`: a new agent, a stage rewrite, a lower reserve, a
 *     shorter window, a pacing change, cleared escrow, a different total or line set, an unreadable value). They
 *     need a new additive kind or a new deployment (G0 decision §1 #6).
 * After every routed request executes, re-checking the draft leaves exactly `unsupported`. Tightenings in the
 * draft are not routed: commit them first (a tighten-only REPLAN or the agent's TIGHTEN_* calls), because a
 * MOVE_POCKETS out of a line is bounded by that line's caps.
 */
import type { ExceptionOf } from "../schemas/exception";
import type { LineKey } from "../schemas/enums";
import type { PlanManifest } from "../schemas/plan";
import { replanLoosenings, type ReplanLoosening } from "../constitution/replan";
import type { CommittedPlan } from "../constitution/types";

type RoutedKind = "RAISE_CAP" | "ADD_PAYEE" | "EXTEND_EXPIRY" | "MOVE_POCKETS";
/** One lender-co-signed exception request (POST /api/exceptions body without `reason`). */
export type ReplanLoosenRequest = { [K in RoutedKind]: { readonly kind: K; readonly payload: ExceptionOf<K>["payload"] } }[RoutedKind];

export interface ReplanRoute {
  /** The founder may sign the draft alone: commitPlan accepts it (code 14 passes). */
  readonly tightenOnly: boolean;
  /** Lender-co-signed LOOSEN_* requests, in execution order. */
  readonly loosens: readonly ReplanLoosenRequest[];
  /** Loosenings no LOOSEN_* kind can make. */
  readonly unsupported: readonly ReplanLoosening[];
}

function single(l: ReplanLoosening): ReplanLoosenRequest | null {
  const lineKey = l.lineKey;
  const value = typeof l.proposed === "string" ? l.proposed : null;
  if (value === null) return null;
  switch (l.rule) {
    case "PER_TX_CAP_RAISED":
      return lineKey ? { kind: "RAISE_CAP", payload: { lineKey, cap: "perTx", newCapMinor: value } } : null;
    case "WINDOW_CAP_RAISED":
      return lineKey ? { kind: "RAISE_CAP", payload: { lineKey, cap: "window", newCapMinor: value } } : null;
    case "VALID_UNTIL_EXTENDED":
      return lineKey ? { kind: "EXTEND_EXPIRY", payload: { target: "line", lineKey, newExpiresAt: value } } : null;
    case "AGENT_EXPIRY_EXTENDED":
      return { kind: "EXTEND_EXPIRY", payload: { target: "agent", newExpiresAt: value } };
    case "PAYEE_ADDED":
      return lineKey && l.payeeId ? { kind: "ADD_PAYEE", payload: { payeeId: l.payeeId, lineKey } } : null;
    default:
      return null;
  }
}

interface Pocket {
  readonly lineKey: LineKey;
  readonly current: bigint;
  readonly proposed: bigint;
  /** Signed amount still to move: > 0 needs funds in, < 0 has funds to give. */
  left: bigint;
}

/** Pair decreases with increases greedily, in stored line order. Mutates only the local `left` counters. */
function pairPockets(pockets: Pocket[]): ReplanLoosenRequest[] {
  const moves: ReplanLoosenRequest[] = [];
  const from = pockets.filter((p) => p.left < 0n);
  const to = pockets.filter((p) => p.left > 0n);
  let i = 0;
  let j = 0;
  while (i < from.length && j < to.length) {
    const a = from[i]!;
    const b = to[j]!;
    const amount = -a.left < b.left ? -a.left : b.left;
    moves.push({ kind: "MOVE_POCKETS", payload: { fromLineKey: a.lineKey, toLineKey: b.lineKey, amountMinor: amount.toString() } });
    a.left += amount;
    b.left -= amount;
    if (a.left === 0n) i += 1;
    if (b.left === 0n) j += 1;
  }
  return moves;
}

/** Split a draft into what the founder signs alone and the LOOSEN_* requests it needs (see module doc). */
export function routeReplan(manifest: PlanManifest, current: CommittedPlan): ReplanRoute {
  const loosenings = replanLoosenings(manifest, current);
  const pockets = new Map<ReplanLoosening, Pocket>();
  for (const l of loosenings) {
    if (l.rule !== "AMOUNT_CHANGED" || !l.lineKey || typeof l.current !== "string" || typeof l.proposed !== "string") continue;
    const c = BigInt(l.current);
    const p = BigInt(l.proposed);
    pockets.set(l, { lineKey: l.lineKey, current: c, proposed: p, left: p - c });
  }
  const moves = pairPockets([...pockets.values()]);
  const others: ReplanLoosenRequest[] = [];
  const unsupported: ReplanLoosening[] = [];
  for (const l of loosenings) {
    const pocket = pockets.get(l);
    if (pocket) {
      // Whatever the moves could not balance stays a loosening, against the post-move allocation.
      if (pocket.left !== 0n) unsupported.push({ ...l, current: (pocket.proposed - pocket.left).toString() });
      continue;
    }
    const request = single(l);
    if (request) others.push(request);
    else unsupported.push(l);
  }
  const loosens = [...moves, ...others];
  return { tightenOnly: loosens.length === 0 && unsupported.length === 0, loosens, unsupported };
}
