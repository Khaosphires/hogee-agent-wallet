/**
 * "event sources (calldata ↔ events)" (run-6 v-6): every decoded event sits in the receipt of the tx whose signed
 * calldata produced it, and agrees with that calldata. Per Hogee call: the events it may emit (and from which
 * contract), the one event a successful call always emits exactly once, and the fields both carry. A successful tx
 * whose calldata is no Hogee call of its contract may emit nothing. Unindexed fields such as FounderKeyRegistered's
 * qx / qy are not in the logs bloom, so this binding is what ties them to the lender-signed registerFounderKey.
 */
import type { ContractName, ParsedBundle } from "./bundle";
import type { ChainEvent, ChainTx } from "./chain";
import { Problems, sameHex, type VerifyCheck } from "./util";

const ZERO = `0x${"0".repeat(64)}`;
const UINT128_MAX = 2n ** 128n - 1n;
type Args = readonly unknown[];
type Struct = Readonly<Record<string, unknown>>;
/** True when the event agrees with the call (and its sender). */
type Match = (ev: Struct, a: Args, from: string) => boolean;

const eq = (x: unknown, y: unknown): boolean => (typeof x === "string" && typeof y === "string" ? sameHex(x, y) : typeof x === "bigint" || typeof y === "bigint" ? BigInt(x as bigint) === BigInt(y as bigint) : x === y);
const f = (v: unknown, name: string): unknown => (v as Struct)[name];
const fields = (ev: Struct, src: unknown, names: readonly string[]): boolean => names.every((n) => eq(ev[n], f(src, n)));

interface Rule {
  /** The events the call may emit, with their emitting contract and how each agrees with the calldata. */
  readonly may: Readonly<Record<string, readonly [ContractName, Match]>>;
  /** The event a successful call emits exactly once. */
  readonly one: string;
}

const T = "Treasury" as const;
const P = "PlanRegistry" as const;
const E = "MilestoneEscrow" as const;
const S = "SalesOracle" as const;

/** A platform payee bound by syncPlan: listed on a non-escrow line of the committed lines, uncapped, no order. */
const platformBinding: Match = (ev, a) => {
  const lines = a[1] as readonly Struct[];
  const line = lines.find((l) => eq(l.lineId, ev.lineId));
  const listed = !!line && !line.escrowOnly && (line.payeeIds as readonly string[]).some((p) => eq(p, ev.payeeId));
  return listed && eq(ev.orderId, ZERO) && eq(ev.supplierId, ZERO) && eq(ev.scheduleHash, ZERO) && eq(ev.lifetimeCapMinor, UINT128_MAX);
};

export const EMITS: Readonly<Record<string, Rule>> = {
  commitPlan: {
    one: "PlanCommitted",
    may: {
      PlanCommitted: [P, (ev, a) => fields(ev, a[0], ["planId", "version", "planHash", "prevPlanHash", "countryPackHash", "totalMinor", "agent", "agentExpiry", "linesHash", "stagesHash", "reserveBps"])],
      PayeeBound: [T, platformBinding],
    },
  },
  registerFounderKey: { one: "FounderKeyRegistered", may: { FounderKeyRegistered: [P, (ev, a) => eq(ev.qx, a[0]) && eq(ev.qy, a[1]) && eq(ev.ownerEOA, a[2])] } },
  spend: {
    one: "Spent",
    may: { Spent: [T, (ev, a) => ["lineId", "payeeId", "amountMinor", "invoiceHash", "planVersion", "decisionId", "rationaleHash"].every((n, i) => eq(ev[n], a[i]))] },
  },
  bindPayee: {
    one: "PayeeBound",
    may: { PayeeBound: [T, (ev, a) => eq(ev.payeeId, f(a[0], "payee")) && fields(ev, a[0], ["lineId", "orderId", "supplierId", "scheduleHash", "payoutAccountHash"])] },
  },
  cancelLoosen: { one: "LoosenCancelled", may: { LoosenCancelled: [T, (ev, a, from) => eq(ev.loosenId, a[0]) && eq(ev.by, from)] } },
  confirmSettlement: { one: "SettlementConfirmed", may: { SettlementConfirmed: [T, (ev, a) => eq(ev.settlementId, a[0]) && eq(ev.payoutRefHash, a[1])] } },
  failSettlement: { one: "SettlementFailed", may: { SettlementFailed: [T, (ev, a) => eq(ev.settlementId, a[0]) && eq(ev.code, a[1])] } },
  executeLoosen: {
    one: "LoosenExecuted",
    may: {
      LoosenExecuted: [T, (ev, a) => eq(ev.loosenId, a[0])],
      PayeeBound: [T, (ev) => eq(ev.orderId, ZERO) && eq(ev.lifetimeCapMinor, UINT128_MAX)],
      Unpaused: [T, (ev, _a, from) => eq(ev.by, from)],
      ReserveWithdrawn: [T, (ev, a) => eq(ev.settlementId, a[0])],
    },
  },
  fund: { one: "Funded", may: { Funded: [T, (ev, a) => eq(ev.amountMinor, a[0])] } },
  openFacility: { one: "FacilityOpened", may: { FacilityOpened: [T, (ev, a, from) => eq(ev.capMinor, a[0]) && eq(ev.reserveFloorBps, a[1]) && eq(ev.lender, from)] } },
  ownerSpend: { one: "OwnerSpent", may: { OwnerSpent: [T, (ev, a) => fields(ev, a[0], ["lineId", "payeeId", "amountMinor", "invoiceHash"])] } },
  pause: {
    one: "TreasuryPaused",
    may: { TreasuryPaused: [T, (ev, _a, from) => eq(ev.lineId, ZERO) && eq(ev.by, from)], LoosenCancelled: [T, (ev, _a, from) => eq(ev.by, from)] },
  },
  queueLoosen: { one: "LoosenQueued", may: { LoosenQueued: [T, (ev, a) => fields(ev, a[0], ["kind", "target", "aux", "newValue"])] } },
  recordDenied: {
    one: "Denied",
    may: {
      Denied: [T, (ev, a) => eq(ev.lineId, a[0]) && eq(ev.decisionId, a[1]) && eq(ev.reasonCode, a[2]) && eq(ev.proposalHash, a[3])],
      CircuitTripped: [T, (ev, a) => eq(ev.lineId, a[0])],
    },
  },
  releaseStage: { one: "StageReleased", may: { StageReleased: [T, (ev, a) => fields(ev, a[0], ["stageId", "amountMinor"])] } },
  tighten: {
    one: "Tightened",
    may: {
      Tightened: [T, (ev, a, from) => eq(ev.kind, a[0]) && eq(ev.target, a[1]) && eq(ev.decisionId, a[3]) && eq(ev.by, from) && (Number(a[0]) > 2 || eq(ev.newValue, a[2]))],
      TreasuryPaused: [T, (ev, a, from) => Number(a[0]) === 5 && eq(ev.lineId, a[1]) && eq(ev.by, from)],
    },
  },
  fundMilestone: {
    one: "MilestoneFunded",
    may: {
      MilestoneFunded: [E, (ev, a) => ["orderId", "idx", "amountMinor"].every((n, i) => eq(ev[n], a[i])) && eq(ev.decisionId, a[3]) && eq(ev.rationaleHash, a[4])],
      MilestoneReleased: [E, (ev, a) => eq(ev.orderId, a[0]) && eq(ev.idx, a[1]) && eq(ev.evidenceHash, ZERO)],
    },
  },
  releaseMilestone: { one: "MilestoneReleased", may: { MilestoneReleased: [E, (ev, a) => fields(ev, a[0], ["orderId", "idx", "amountMinor", "evidenceHash"])] } },
  recordSale: {
    one: "SaleRecorded",
    may: {
      SaleRecorded: [S, (ev, a) => eq(ev.saleIdHash, a[0]) && eq(ev.amountBucket, a[1])],
      RevenueRecorded: [T, (ev, a) => eq(ev.saleIdHash, a[0])],
      ReserveSkimmed: [T, (ev, a) => eq(ev.saleIdHash, a[0])],
    },
  },
};

function checkTx(t: ChainTx, p: Problems): void {
  if (!t.receipt || t.receipt.status !== "0x1") return;
  const where = t.hash.slice(0, 12);
  if (!t.call) {
    if (t.events.length > 0) p.add(`${where}…: emits ${t.events.map((e) => e.name).join(", ")} but its signed calldata is no Hogee call of its contract`);
    return;
  }
  const rule = EMITS[t.call.name];
  if (!rule) return p.add(`${where}…: no event rule for ${t.call.name}`);
  const from = t.tx?.from ?? "";
  for (const ev of t.events) {
    const allowed = rule.may[ev.name];
    if (!allowed) p.add(`${where}…: ${t.call.name} cannot emit ${ev.name}`);
    else if (allowed[0] !== ev.contract) p.add(`${where}…: ${ev.name} comes from ${ev.contract}, not ${allowed[0]}`);
    else if (!allowed[1](ev.args, t.call.args, from)) p.add(`${where}…: the ${ev.name} event differs from the signed ${t.call.name} calldata`);
  }
  const ones = t.events.filter((e) => e.name === rule.one).length;
  if (ones !== 1) p.add(`${where}…: a successful ${t.call.name} emits ${ones} ${rule.one} events, not exactly one`);
}

export function checkEventSources(_b: ParsedBundle, txs: ReadonlyMap<string, ChainTx>, events: readonly ChainEvent[]): VerifyCheck {
  const p = new Problems("event sources (calldata ↔ events)");
  for (const t of txs.values()) checkTx(t, p);
  return p.result(`${events.length} events sit in the receipts of the signed calls that emit them`);
}
