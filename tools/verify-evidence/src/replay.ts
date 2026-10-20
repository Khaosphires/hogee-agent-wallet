/**
 * "event replay": the bundle's event log, in chain order, replayed against the signed plan rules with the checks
 * Treasury and MilestoneEscrow make (§8.4; run-6 v-5 aligned every divergence):
 *   Spent        — by the plan's live, unexpired agent, treasury not paused, decision set, current plan version, on a
 *                  line of that version (not escrow-only, not expired, circuit closed, not paused), to a payee BOUND to
 *                  the line AND listed by the current version (spend row 10) and cooled; spendId = intentId, no repeated
 *                  intent or invoice (pacing: the next slot, at most the pacing amount); per-tx cap, at most 64 live
 *                  window entries, the rolling-window cap, the pocket, the payee's lifetime cap, released and funded;
 *   OwnerSpent   — ownerSpend (TreasuryGovernance): the line active and unexpired, not escrow-only, the payee, intent,
 *                  invoice and amount rules; no agent, no per-tx/window caps and no pause or circuit of any kind (§8.8);
 *   MilestoneFunded — fundMilestone: the live agent, no pause, not expired, decision set, an order a PayeeBound opened,
 *                  its line active (validUntil, circuit, pause), its payee bound and cooled, a non-zero amount,
 *                  cumulative per milestone, and the pocket, released and funded ceilings;
 *   MilestoneReleased — escrowRelease: the order's payee, cooled, within its lifetime cap.
 * PlanCommitted, PayeeBound, tighten, loosen (kinds 1-8), pause, circuit and settlement-failure events update the state
 * exactly as the contracts do; a milestone's schedule comes from the signed bindPayee calldata. Spent /
 * MilestoneFunded that no payment row owns are T29 orphans: they pass only when a treasury pause (TreasuryPaused with
 * lineId 0) follows them.
 * A REVERTED spend or fundMilestone (its signed calldata, at its block) is replayed dry against the state at that
 * point: the rules must refuse it, else the bundle shows a successful call as reverted (run-6 v-6 status flip).
 */
import { spendIntentId, type PlanManifest } from "@hogee/core";
import type { ParsedBundle, PlanEntry } from "./bundle";
import { chainOrder, type ChainEvent, type ChainView } from "./chain";
import { Problems, sameHex, tagToBytes32, type VerifyCheck } from "./util";

const ZERO = `0x${"0".repeat(64)}`;
/** Treasury MAX_LIVE_SPENDS_PER_WINDOW. */
export const MAX_LIVE_WINDOW_ENTRIES = 64;
const TIGHTEN = { PER_TX: 1, WINDOW: 2, REVOKE_AGENT: 4, PAUSE_LINE: 5 } as const;
const LOOSEN = { PER_TX: 1, WINDOW: 2, ADD_PAYEE: 3, AGENT_EXPIRY: 4, LINE_EXPIRY: 5, MOVE_POCKETS: 6 } as const;

interface Line {
  /** The plan version that last synced the line: active iff it is the current version. */
  version: number;
  perTxCap: bigint;
  windowCap: bigint;
  windowSeconds: bigint;
  validUntil: bigint;
  allocated: bigint;
  pacing: bigint;
  escrowOnly: boolean;
  paused: boolean;
  circuitOpen: boolean;
  used: bigint;
  seq: bigint;
  /** Live window entries; spends in one block (same time) merge into one, as RollingWindow.push does. */
  window: { at: bigint; amount: bigint }[];
}

interface Binding {
  coolingUntil: bigint;
  cap: bigint;
  paid: bigint;
}

interface State {
  plan: PlanManifest | null;
  planId: string;
  version: number;
  agent: string;
  agentExpiry: bigint;
  agentRevoked: boolean;
  paused: boolean;
  released: bigint;
  funded: bigint;
  outflow: bigint;
  lines: Map<string, Line>;
  /** `${lineId}|${payeeId}` → binding (PayeeBound); kept across re-binds and re-commits, as Treasury keeps it. */
  bindings: Map<string, Binding>;
  /** `${lineId}|${payeeId}` → the plan version that last listed it (_listedVersion). */
  listed: Map<string, number>;
  /** orderId → its line and payee (the PayeeBound of bindPayee). */
  orders: Map<string, { line: string; payee: string }>;
  /** orderId → the milestone amounts its signed bindPayee carries. */
  schedules: Map<string, readonly bigint[]>;
  intents: Set<string>;
  invoices: Set<string>;
  settlements: Map<string, { line: string; payee: string; amount: bigint }>;
  milestones: Map<string, bigint>;
  loosens: Map<string, { kind: number; target: string; aux: string; newValue: bigint }>;
}

const k = (v: unknown): string => String(v).toLowerCase();
const n = (v: unknown): bigint => BigInt(v as bigint);
const key = (lineId: string, payeeId: string): string => `${lineId}|${payeeId}`;

/** syncPlan: version, agentExpiry and the lines every commit; planId, agent and stage 0 on the first only. */
function applyPlan(s: State, plan: PlanEntry, ev: ChainEvent): void {
  const m = plan.manifest;
  const first = s.plan === null;
  s.plan = m;
  s.version = Number(ev.args.version);
  s.agentExpiry = n(ev.args.agentExpiry);
  if (first) {
    s.planId = k(ev.args.planId);
    s.agent = k(ev.args.agent);
    s.released = n(ev.args.releasedMinor);
  }
  for (const l of m.lines) {
    const id = tagToBytes32(l.lineKey).toLowerCase();
    const prev = s.lines.get(id);
    s.lines.set(id, {
      version: s.version,
      perTxCap: BigInt(l.perTxCapMinor),
      windowCap: BigInt(l.windowCapMinor),
      windowSeconds: BigInt(l.windowSeconds),
      validUntil: BigInt(l.validUntil),
      allocated: BigInt(l.amountMinor),
      pacing: l.pacing ? BigInt(l.pacing.amountMinor) : 0n,
      escrowOnly: l.escrowOnly,
      paused: prev?.paused ?? false,
      circuitOpen: prev?.circuitOpen ?? false,
      used: prev?.used ?? 0n,
      seq: prev?.seq ?? 0n,
      window: prev?.window ?? [],
    });
    for (const p of l.payeeIds) s.listed.set(key(id, tagToBytes32(p).toLowerCase()), s.version);
  }
}

/** _requireSpendingAgent: the agent, not revoked, treasury not paused, not expired. */
function agentChecks(s: State, ev: ChainEvent, now: bigint, where: string, p: Problems): void {
  if (!sameHex(ev.sender, s.agent) || s.agentRevoked) p.add(`${where}: not sent by the plan's live agent`);
  if (s.paused) p.add(`${where}: the treasury is paused`);
  if (now > s.agentExpiry) p.add(`${where}: the agent expired`);
}

/** _isActive + validUntil (spend rows 5-6, checkEscrowLine, ownerSpend's LineExpired). */
function lineLive(s: State, line: Line, now: bigint, where: string, p: Problems): void {
  if (line.version !== s.version) p.add(`${where}: the line is not in plan v${s.version}`);
  else if (now > line.validUntil) p.add(`${where}: the line expired`);
}

/** The circuit and the line pause (spend rows 8-9, checkEscrowLine). ownerSpend makes neither (§8.8). */
function lineOpen(line: Line, where: string, p: Problems): void {
  if (line.circuitOpen) p.add(`${where}: the line's circuit is open`);
  if (line.paused) p.add(`${where}: the line is paused`);
}

/** _requirePayeeReady (spend row 10-11): bound AND listed by the current version, and cooled. */
function payeeChecks(s: State, lineId: string, payee: string, now: bigint, where: string, p: Problems, needListed: boolean): Binding | undefined {
  const binding = s.bindings.get(key(lineId, payee));
  if (!binding) p.add(`${where}: payee ${payee} is not bound to the line`);
  else if (needListed && s.listed.get(key(lineId, payee)) !== s.version) p.add(`${where}: payee ${payee} is not listed by plan v${s.version}`);
  if (binding && now < binding.coolingUntil) p.add(`${where}: payee still cooling`);
  return binding;
}

/** The pocket, payee lifetime cap, released and funded ceilings of an outflow (_requireCaps rows 20-23). */
function ceilingChecks(s: State, line: Line, binding: Binding | undefined, amount: bigint, where: string, p: Problems): void {
  if (line.used + amount > line.allocated) p.add(`${where}: exceeds the line pocket`);
  if (binding && binding.paid + amount > binding.cap) p.add(`${where}: exceeds the payee's lifetime cap`);
  if (s.outflow + amount > s.released) p.add(`${where}: total outflow exceeds the released stages`);
  if (s.outflow + amount > s.funded) p.add(`${where}: total outflow exceeds the funded amount`);
}

/** RollingWindow: prune, at most 64 live entries, the exact sum; then push (merging a same-time entry). */
function windowChecks(line: Line, now: bigint, amount: bigint, where: string, p: Problems): void {
  line.window = line.window.filter((w) => w.at + line.windowSeconds > now);
  if (line.window.length >= MAX_LIVE_WINDOW_ENTRIES) p.add(`${where}: the line already has ${MAX_LIVE_WINDOW_ENTRIES} live window entries`);
  const inWindow = line.window.reduce((a, w) => a + w.amount, 0n);
  if (inWindow + amount > line.windowCap) p.add(`${where}: over the rolling-window cap`);
  const last = line.window[line.window.length - 1];
  if (last && last.at === now) last.amount += amount;
  else line.window.push({ at: now, amount });
}

function checkInvoice(s: State, line: Line, ev: ChainEvent, amount: bigint, where: string, p: Problems): void {
  const invoice = k(ev.args.invoiceHash);
  if (line.pacing === 0n) {
    if (s.invoices.has(invoice)) p.add(`${where}: invoice ${invoice} paid twice`);
    s.invoices.add(invoice);
    return;
  }
  if (BigInt(invoice) !== line.seq + 1n) p.add(`${where}: pacing slot ${BigInt(invoice)} is not the next slot ${line.seq + 1n}`);
  if (amount > line.pacing) p.add(`${where}: over the pacing amount`);
  line.seq += 1n;
}

function intentOf(s: State, ev: ChainEvent, amount: bigint): string {
  return spendIntentId({ planId: s.planId, lineId: k(ev.args.lineId), payeeId: k(ev.args.payeeId), invoiceHash: k(ev.args.invoiceHash), amountMinor: amount });
}

/** _recordOutflow: pocket, total and payee spent, and the settlement record (spendId == settlementId). */
function recordOutflow(s: State, line: Line, binding: Binding | undefined, ev: ChainEvent, amount: bigint): void {
  line.used += amount;
  s.outflow += amount;
  if (binding) binding.paid += amount;
  s.settlements.set(k(ev.args.spendId), { line: k(ev.args.lineId), payee: k(ev.args.payeeId), amount });
}

/**
 * The line of a payment out of a line pocket, its intent and invoice: shared by Spent and OwnerSpent. Only the agent's
 * spend (`agent`) checks the circuit and the line pause; ownerSpend is the founder's fallback for exactly that case.
 */
function outflowLine(s: State, ev: ChainEvent, amount: bigint, now: bigint, where: string, p: Problems, agent: boolean): { line: Line; binding: Binding | undefined } | null {
  const lineId = k(ev.args.lineId);
  const line = s.lines.get(lineId);
  if (Number(ev.args.planVersion) !== s.version) p.add(`${where}: plan v${ev.args.planVersion} is not the current v${s.version}`);
  if (intentOf(s, ev, amount) !== k(ev.args.spendId)) p.add(`${where}: spendId is not the recomputed intentId`);
  if (s.intents.has(k(ev.args.spendId))) p.add(`${where}: intent spent twice`);
  s.intents.add(k(ev.args.spendId));
  if (!line) {
    p.add(`${where}: line ${lineId} is not in the committed plan`);
    return null;
  }
  if (line.escrowOnly) p.add(`${where}: an escrow-only line`);
  lineLive(s, line, now, where, p);
  if (agent) lineOpen(line, where, p);
  const binding = payeeChecks(s, lineId, k(ev.args.payeeId), now, where, p, true);
  checkInvoice(s, line, ev, amount, where, p);
  return { line, binding };
}

function onSpent(s: State, ev: ChainEvent, now: bigint, p: Problems): void {
  const amount = n(ev.args.amountMinor);
  const where = `Spent ${k(ev.args.spendId).slice(0, 10)}… (block ${ev.blockNumber})`;
  if (!s.plan) return p.add(`${where}: before any committed plan`);
  agentChecks(s, ev, now, where, p);
  if (k(ev.args.decisionId) === ZERO || k(ev.args.rationaleHash) === ZERO) p.add(`${where}: missing decision`);
  const out = outflowLine(s, ev, amount, now, where, p, true);
  if (!out) return;
  if (amount === 0n || amount > out.line.perTxCap) p.add(`${where}: over the per-tx cap`);
  windowChecks(out.line, now, amount, where, p);
  ceilingChecks(s, out.line, out.binding, amount, where, p);
  recordOutflow(s, out.line, out.binding, ev, amount);
}

/**
 * ownerSpend (TreasuryGovernance.sol:48-62): active and unexpired, not escrow-only, payee ready, no repeated intent,
 * the invoice, then _requireOwnerAmount (non-zero, pocket, lifetime cap, released and funded). No agent, per-tx or
 * window check, and no pause or circuit of any kind: neither the treasury pause nor the line's.
 */
function onOwnerSpent(s: State, ev: ChainEvent, now: bigint, p: Problems): void {
  const amount = n(ev.args.amountMinor);
  const where = `OwnerSpent ${k(ev.args.spendId).slice(0, 10)}…`;
  if (!s.plan) return p.add(`${where}: before any committed plan`);
  const out = outflowLine(s, ev, amount, now, where, p, false);
  if (!out) return;
  if (amount === 0n) p.add(`${where}: a zero amount`);
  ceilingChecks(s, out.line, out.binding, amount, where, p);
  recordOutflow(s, out.line, out.binding, ev, amount);
}

/** fundMilestone: requireSpendingAgent, the order, checkEscrowLine, amount, schedule (cumulative) and escrowFund. */
function onMilestoneFunded(s: State, ev: ChainEvent, now: bigint, p: Problems): void {
  const amount = n(ev.args.amountMinor);
  const orderId = k(ev.args.orderId);
  const milestone = `${orderId}:${ev.args.idx}`;
  const where = `MilestoneFunded ${milestone.slice(0, 12)}…`;
  agentChecks(s, ev, now, where, p);
  if (k(ev.args.decisionId) === ZERO || k(ev.args.rationaleHash) === ZERO) p.add(`${where}: missing decision`);
  const order = s.orders.get(orderId);
  if (!order) return p.add(`${where}: order ${orderId.slice(0, 12)}… is not bound (no PayeeBound opened it)`);
  const line = s.lines.get(order.line);
  if (!line) return p.add(`${where}: line ${order.line} is not in the committed plan`);
  lineLive(s, line, now, where, p);
  lineOpen(line, where, p);
  payeeChecks(s, order.line, order.payee, now, where, p, false);
  if (amount === 0n) p.add(`${where}: a zero amount`);
  const before = s.milestones.get(milestone) ?? 0n;
  const schedule = s.schedules.get(orderId);
  const idx = Number(ev.args.idx);
  if (schedule && idx >= schedule.length) p.add(`${where}: the order has no milestone ${idx}`);
  else if (schedule && before + amount > (schedule[idx] as bigint)) p.add(`${where}: exceeds the milestone's scheduled amount`);
  if (n(ev.args.fundedTotalMinor) !== before + amount) p.add(`${where}: fundedTotal is not cumulative`);
  s.milestones.set(milestone, before + amount);
  ceilingChecks(s, line, undefined, amount, where, p);
  line.used += amount;
  s.outflow += amount;
}

/** escrowRelease: the order's payee, cooled, within its lifetime cap; opens the milestone settlement. */
function onMilestoneReleased(s: State, ev: ChainEvent, now: bigint, p: Problems): void {
  const amount = n(ev.args.amountMinor);
  const payee = k(ev.args.payeeId);
  const where = `MilestoneReleased ${k(ev.args.orderId).slice(0, 12)}…`;
  const order = s.orders.get(k(ev.args.orderId));
  if (!order) return p.add(`${where}: order is not bound (no PayeeBound opened it)`);
  if (order.payee !== payee) p.add(`${where}: pays ${payee}, not the order's payee`);
  const binding = s.bindings.get(key(order.line, payee));
  if (binding && now < binding.coolingUntil) p.add(`${where}: payee still cooling`);
  if (binding && binding.paid + amount > binding.cap) p.add(`${where}: exceeds the payee's lifetime cap`);
  if (binding) binding.paid += amount;
  s.settlements.set(k(ev.args.settlementId), { line: order.line, payee, amount });
}

function onPayeeBound(s: State, ev: ChainEvent): void {
  const lineId = k(ev.args.lineId);
  const payee = k(ev.args.payeeId);
  const prev = s.bindings.get(key(lineId, payee));
  // A re-bind keeps what was paid (Treasury._bind / _addPayee never reset paidMinor).
  s.bindings.set(key(lineId, payee), { coolingUntil: n(ev.args.coolingUntil), cap: n(ev.args.lifetimeCapMinor), paid: prev?.paid ?? 0n });
  if (k(ev.args.orderId) !== ZERO) s.orders.set(k(ev.args.orderId), { line: lineId, payee });
}

function onLoosenExecuted(s: State, ev: ChainEvent, p: Problems): void {
  const q = s.loosens.get(k(ev.args.loosenId));
  if (!q) return p.add(`LoosenExecuted ${k(ev.args.loosenId).slice(0, 10)}… was never queued`);
  const line = s.lines.get(q.target);
  if (q.kind === LOOSEN.PER_TX && line) line.perTxCap = q.newValue;
  else if (q.kind === LOOSEN.WINDOW && line) line.windowCap = q.newValue;
  else if (q.kind === LOOSEN.ADD_PAYEE) s.listed.set(key(q.aux, q.target), s.version); // target payee, aux line; PayeeBound binds it
  else if (q.kind === LOOSEN.AGENT_EXPIRY) s.agentExpiry = q.newValue;
  else if (q.kind === LOOSEN.LINE_EXPIRY && line) line.validUntil = q.newValue;
  else if (q.kind === LOOSEN.MOVE_POCKETS && line) {
    const to = s.lines.get(q.aux);
    line.allocated -= q.newValue;
    if (to) to.allocated += q.newValue;
  }
  // 7 UNPAUSE and 8 WITHDRAW_RESERVE act through their own Unpaused / ReserveWithdrawn events.
}

/** failSettlement: a spend or milestone returns to its line pocket and the payee's paid total. */
function onSettlementFailed(s: State, ev: ChainEvent): void {
  const r = s.settlements.get(k(ev.args.settlementId));
  if (!r) return;
  const line = s.lines.get(r.line);
  if (line) line.used -= r.amount;
  s.outflow -= r.amount;
  const binding = s.bindings.get(key(r.line, r.payee));
  if (binding) binding.paid -= r.amount;
}

function onTightened(s: State, ev: ChainEvent): void {
  const line = s.lines.get(k(ev.args.target));
  const kind = Number(ev.args.kind);
  if (kind === TIGHTEN.PER_TX && line) line.perTxCap = n(ev.args.newValue);
  else if (kind === TIGHTEN.WINDOW && line) line.windowCap = n(ev.args.newValue);
  else if (kind === TIGHTEN.REVOKE_AGENT) s.agentRevoked = true;
  else if (kind === TIGHTEN.PAUSE_LINE && line) line.paused = true;
}

function setPause(s: State, ev: ChainEvent, paused: boolean): void {
  const lineId = k(ev.args.lineId);
  if (lineId === ZERO) {
    s.paused = paused;
    return;
  }
  const line = s.lines.get(lineId);
  if (!line) return;
  line.paused = paused;
  if (!paused) line.circuitOpen = false; // UNPAUSE of a line also closes its circuit
}

/** A reverted call must be refused by the rules at its point in the log (dry run on a copy of the state). */
function dryRun(s: State, ev: ChainEvent, now: bigint, p: Problems, run: (c: State, e: ChainEvent, t: bigint, q: Problems) => void): void {
  const dry = new Problems("dry run");
  run(structuredClone(s), ev, now, dry);
  if (dry.count === 0) p.add(`${ev.name} attempt in ${ev.txHash.slice(0, 12)}…: the tx reverted, but the plan rules accept the call (a successful tx shown as reverted?)`);
}

function step(s: State, b: ParsedBundle, ev: ChainEvent, p: Problems): void {
  const now = ev.timestamp ?? 0n;
  const a = ev.args;
  switch (ev.name) {
    case "SpendAttempt":
      return dryRun(s, { ...ev, name: "Spent", args: { ...a, spendId: intentOf(s, ev, n(a.amountMinor)) } }, now, p, onSpent);
    case "FundAttempt": {
      const total = (s.milestones.get(`${k(a.orderId)}:${a.idx}`) ?? 0n) + n(a.amountMinor);
      return dryRun(s, { ...ev, name: "MilestoneFunded", args: { ...a, fundedTotalMinor: total } }, now, p, onMilestoneFunded);
    }
    case "PlanCommitted": {
      const plan = b.plans.find((x) => x.version === Number(a.version) && sameHex(x.planHash, a.planHash as string));
      if (!plan) return p.add(`PlanCommitted v${a.version}: its manifest is not in plans.json`);
      return applyPlan(s, plan, ev);
    }
    case "Funded":
      s.funded = n(a.fundedTotalMinor);
      return;
    case "StageReleased":
      if (n(a.releasedTotalMinor) < s.released) p.add("StageReleased lowers the released total");
      s.released = n(a.releasedTotalMinor);
      return;
    case "PayeeBound":
      return onPayeeBound(s, ev);
    case "Spent":
      return onSpent(s, ev, now, p);
    case "OwnerSpent":
      return onOwnerSpent(s, ev, now, p);
    case "MilestoneFunded":
      return onMilestoneFunded(s, ev, now, p);
    case "MilestoneReleased":
      return onMilestoneReleased(s, ev, now, p);
    case "SettlementFailed":
      return onSettlementFailed(s, ev);
    case "Tightened":
      return onTightened(s, ev);
    case "LoosenQueued":
      s.loosens.set(k(a.loosenId), { kind: Number(a.kind), target: k(a.target), aux: k(a.aux), newValue: n(a.newValue) });
      return;
    case "LoosenExecuted":
      return onLoosenExecuted(s, ev, p);
    case "TreasuryPaused":
      return setPause(s, ev, true);
    case "CircuitTripped": {
      const line = s.lines.get(k(a.lineId));
      if (line) line.circuitOpen = true;
      return;
    }
    case "Unpaused":
      return setPause(s, ev, false);
    default:
      return;
  }
}

/** Spent / MilestoneFunded that no payment row owns: orphans (T29) pass only when the treasury pause follows them. */
function checkOrphans(b: ParsedBundle, events: readonly ChainEvent[], p: Problems): number {
  let orphans = 0;
  events.forEach((ev, i) => {
    if (ev.name !== "Spent" && ev.name !== "MilestoneFunded") return;
    if (b.payments.some((x) => sameHex(x.payment.txHash, ev.txHash))) return;
    orphans += 1;
    const paused = events.slice(i + 1).some((e) => e.name === "TreasuryPaused" && k(e.args.lineId) === ZERO);
    if (!paused) p.add(`${ev.name} in ${ev.txHash.slice(0, 10)}… has no payment row and no treasury pause follows it`);
  });
  return orphans;
}

const TIMED = new Set(["Spent", "OwnerSpent", "MilestoneFunded", "MilestoneReleased", "SpendAttempt", "FundAttempt"]);

const ATTEMPT_ARGS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  spend: ["SpendAttempt", ["lineId", "payeeId", "amountMinor", "invoiceHash", "planVersion", "decisionId", "rationaleHash"]],
  fundMilestone: ["FundAttempt", ["orderId", "idx", "amountMinor", "decisionId", "rationaleHash"]],
};

/** Reverted agent calls, as pseudo-events at their place in the chain (no logs: ordered by block and tx index). */
function attemptsOf(chain: ChainView): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const t of chain.txs.values()) {
    const spec = t.call ? ATTEMPT_ARGS[t.call.name] : undefined;
    if (!spec || !t.call || !t.tx || !t.contract || t.receipt?.status !== "0x0") continue;
    const blockNumber = BigInt(t.receipt.blockNumber);
    const args = Object.fromEntries(spec[1].map((name, i) => [name, t.call?.args[i]]));
    out.push({ name: spec[0], args, contract: t.contract, txHash: t.hash, blockNumber, txIndex: Number(BigInt(t.receipt.transactionIndex)), logIndex: -1, timestamp: chain.times.get(blockNumber.toString()) ?? null, sender: t.tx.from });
  }
  return out;
}

/** The milestone amounts of every order a successful, signed bindPayee opened. */
function schedulesOf(chain: ChainView): Map<string, readonly bigint[]> {
  const out = new Map<string, readonly bigint[]>();
  for (const t of chain.txs.values()) {
    if (t.call?.name !== "bindPayee" || t.receipt?.status !== "0x1") continue;
    out.set(String((t.call.args[0] as Record<string, unknown>).orderId).toLowerCase(), t.call.args[1] as readonly bigint[]);
  }
  return out;
}

export function checkReplay(b: ParsedBundle, chain: ChainView): VerifyCheck {
  const events = chain.events;
  const p = new Problems("event replay (caps, payees, duplicates)");
  const s: State = {
    plan: null,
    planId: ZERO,
    version: 0,
    agent: "",
    agentExpiry: 0n,
    agentRevoked: false,
    paused: false,
    released: 0n,
    funded: 0n,
    outflow: 0n,
    lines: new Map(),
    bindings: new Map(),
    listed: new Map(),
    orders: new Map(),
    schedules: schedulesOf(chain),
    intents: new Set(),
    invoices: new Set(),
    settlements: new Map(),
    milestones: new Map(),
    loosens: new Map(),
  };
  for (const ev of [...events, ...attemptsOf(chain)].sort(chainOrder)) {
    if (ev.timestamp === null && TIMED.has(ev.name)) p.add(`${ev.name} in ${ev.txHash.slice(0, 10)}…: its block time is not in the bundle`);
    step(s, b, ev, p);
  }
  const orphans = checkOrphans(b, events, p);
  if (orphans > 0) p.note(`${orphans} orphan spend(s) followed by the treasury pause`);
  const spends = events.filter((e) => e.name === "Spent").length;
  return p.result(`${events.length} events replayed, ${spends} spends within the plan`);
}
