/**
 * SupplierApproval (§26.1 step 6, T1): the founder signs ONE struct that binds the payee to the escrowOnly SUPPLIER
 * line, the payout destination the server holds (payoutAccountHash) and a code-built milestone schedule
 * (scheduleHash). `planFor(refId)` picks the order the refId names, from server state only:
 *   - `terms-<uuidv7>` (VISION-DECISIONS §9): a web supplier's confirmed terms → planWebOrder. Everything is recomputed
 *     from the immutable supplier_terms row with the CURRENT limits (the schedule by core termsToSchedule, the
 *     account hash, sanctions, the candidate and quoteHash = WEB_TERMS) and must match the row. One order per web
 *     supplier: `order-w<12>-001`. finalize re-plans by req.ref_id; the commit moves the row CONFIRMED → USED and
 *     must change exactly one row.
 *   - anything else: a catalog shortlist pick → planOrder (refuses web ids), today's split from the goods value:
 *       goods = min(landed cost, 80% of the SUPPLIER pocket), in whole budget units
 *       sample = 7.5% of goods (autoRelease)      deposit = 30% of goods (autoRelease)
 *       balance = goods - deposit (needs the founder's MilestoneRelease with inspection evidence, and stage 2)
 *     The order id is `order-<x>-<NNN>` for `supplier-<x>` (NNN = the supplier's next order); refId may name either.
 * At submit the supplier payee, the order and its milestones are written with an unsigned bindPayee for the relayer.
 */
import { formatBu, hashObject, isWebSupplierId, jcs, mulDivFloor, payoutAccountHash, type RankedSupplier } from "@hogee/core";
import { buildBindPayee, lineKeyToLineId, scheduleHash, shortIdToBytes32 } from "../../chain-lib";
import type { ApiDeps, Scope } from "../../context";
import { fail } from "../../http/problem";
import { insertAction } from "../actions";
import { requireServerCountry } from "../compile";
import { requireFacility } from "../facility";
import { policyWorld } from "../policy-context";
import { latestReadyShortlist } from "../shortlist";
import { one, pool, rows, type Q } from "../sql";
import { appendTrace } from "../traces";
import { row, type DisplayRow, type SignKind } from "./kinds";
import { toViemMessage } from "./typed";
import { planWebOrder, webOrderRows, type WebOrderPlan } from "./web-order";
import { TERMS_ID_RE, autoLimitsProblem, supplierLimits, termsFailure, webSchedule } from "../terms-checks";

const BU = 100n;
const floorBu = (x: bigint): bigint => (x / BU) * BU;
const ORDER_RE = /^order-([a-z0-9]{1,20})-(\d{3})$/;
const SUPPLIER_RE = /^supplier-([a-z0-9]{1,20})$/;
/** Sample and deposit are paid by the agent once funded; the balance waits for the founder. */
const CATALOG_AUTO_RELEASE: readonly boolean[] = [true, true, false];

/** What the signed struct commits to, for either kind of order. */
interface ApprovalPlan {
  readonly orderId: string;
  readonly supplierId: string;
  readonly payoutAccountHash: string;
  readonly chosenIndex: number;
  readonly shortlistHash: string;
  readonly schedule: readonly bigint[];
  readonly autoRelease: readonly boolean[];
  readonly lineId: `0x${string}`;
  readonly account: { channel: string; accountNumber: string; holderName: string };
  readonly quoteHash: string;
}

export interface OrderPlan extends ApprovalPlan {
  readonly candidate: RankedSupplier;
}

/** Sample, deposit, balance from the goods value (Rina: 400,000 → 30,000 / 120,000 / 280,000). */
export function milestoneSchedule(landedMinor: bigint, supplierLineMinor: bigint): bigint[] {
  const goods = floorBu(landedMinor < mulDivFloor(supplierLineMinor, 8_000n, 10_000n) ? landedMinor : mulDivFloor(supplierLineMinor, 8_000n, 10_000n));
  const sample = floorBu(mulDivFloor(goods, 750n, 10_000n));
  const deposit = floorBu(mulDivFloor(goods, 3_000n, 10_000n));
  return [sample, deposit, goods - deposit];
}

async function nextOrderId(deps: ApiDeps, scope: Scope, supplierId: string): Promise<string> {
  const [r] = await rows<{ n: string }>(pool(deps.db), "select count(*)::text as n from escrow_orders where facility_id = $1 and supplier_id = $2", [scope.facilityId, supplierId]);
  const suffix = SUPPLIER_RE.exec(supplierId)?.[1] as string;
  return `order-${suffix}-${String(Number(r?.n ?? "0") + 1).padStart(3, "0")}`;
}

/**
 * The catalog order fits the SUPPLIER pocket's free budget as supplierLimits counts it (run-9): allocated − spent −
 * escrowed − what every open escrow order (web or catalog) still has to fund, so a catalog order never promises budget an
 * open web order already holds. Its automatic milestones (sample, deposit) follow the web rules (re-check 9 item 1): each
 * at most the per-payment cap, together at most the window left after the open orders' and recent automatic payments.
 */
async function requireCatalogRoom(deps: ApiDeps, scope: Scope, schedule: readonly bigint[], autoRelease: readonly boolean[]): Promise<void> {
  const total = schedule.reduce((s, x) => s + x, 0n);
  const limits = await supplierLimits(deps, scope);
  if (schedule.some((x) => x <= 0n) || total > limits.freeMinor) throw fail("CONFLICT", "The supplier pocket cannot hold this order");
  const problem = autoLimitsProblem(schedule, autoRelease, limits);
  if (problem?.code === "TERMS_AUTO_OVER_PER_TX") throw termsFailure(problem.code, "A payment the agent would make by itself is above the supplier pocket's per-payment cap", problem.idx);
  if (problem) throw termsFailure(problem.code, "The payments the agent would make by itself are above what the supplier pocket may still pay this week");
}

/** Resolve refId (order id or supplier id) to the catalog order the founder would approve now, built from server state. */
export async function planOrder(deps: ApiDeps, scope: Scope, refId: string): Promise<OrderPlan> {
  const db = pool(deps.db);
  // A READY shortlist priced before a HOGEE_COUNTRY change must not be offered for signing (run-8 fix-api follow-up).
  await requireServerCountry(deps, db, scope, await requireFacility(db, scope), "nothing was signed");
  if (await one(db, "select 1 as x from escrow_orders where facility_id = $1 and order_id = $2", [scope.facilityId, refId])) throw fail("CONFLICT", "That order is already approved");
  const m = ORDER_RE.exec(refId);
  const supplierId = m ? `supplier-${m[1]}` : SUPPLIER_RE.test(refId) ? refId : null;
  if (!supplierId) throw fail("NOT_FOUND", "Name an order (order-<x>-001) or a shortlisted supplier");
  // VISION-DECISIONS §9: a web supplier is approved only through its confirmed terms (refId terms-…).
  if (isWebSupplierId(supplierId)) throw fail("CONFLICT", "A supplier found by web search is approved through its confirmed terms, not by its id");
  const orderId = await nextOrderId(deps, scope, supplierId);
  if (m && orderId !== refId) throw fail("NOT_FOUND", `The next order for ${supplierId} is ${orderId}`);
  const ready = await latestReadyShortlist(db, scope, "catalog");
  const chosenIndex = ready?.shortlist.candidates.findIndex((c) => c.supplierId === supplierId) ?? -1;
  const candidate = ready?.shortlist.candidates[chosenIndex];
  if (!ready || !candidate || !ready.shortlist.shortlistHash) throw fail("NOT_FOUND", "That supplier is not on the current shortlist");
  if (await one(db, "select 1 as x from payees where facility_id = $1 and id = $2", [scope.facilityId, supplierId])) throw fail("CONFLICT", "That supplier is already bound as a payee");
  const supplier = await one<{ record_json: { xenditTest: OrderPlan["account"]; offer: unknown } }>(db, "select record_json from suppliers where facility_id = $1 and supplier_id = $2", [scope.facilityId, supplierId]);
  if (!supplier) throw fail("NOT_FOUND", "No such supplier");
  const world = await policyWorld(deps, scope);
  const line = world.manifest.lines.find((l) => l.lineKey === "SUPPLIER" && l.escrowOnly);
  const state = world.ctx.lines.SUPPLIER;
  if (!line || !state) throw fail("CONFLICT", "The committed plan has no escrow-only supplier pocket");
  const schedule = milestoneSchedule(BigInt(candidate.landedCost.totalMinor), BigInt(state.allocatedMinor));
  await requireCatalogRoom(deps, scope, schedule, CATALOG_AUTO_RELEASE);
  const x = supplier.record_json.xenditTest;
  const account = { channel: x.channel, accountNumber: x.accountNumber, holderName: x.holderName };
  // The founder is shown `account` and signs candidate.payoutAccountHash: they must be the same destination (audit run-5).
  if (payoutAccountHash(account) !== candidate.payoutAccountHash) {
    deps.log.warn("supplier_payout_hash_mismatch", { supplierId });
    throw fail("CONFLICT", "The supplier's payout account no longer matches the shortlist; run the shortlist again before choosing");
  }
  return {
    orderId,
    supplierId,
    candidate,
    chosenIndex,
    shortlistHash: ready.shortlist.shortlistHash,
    schedule,
    autoRelease: CATALOG_AUTO_RELEASE,
    lineId: lineKeyToLineId("SUPPLIER"),
    account,
    payoutAccountHash: candidate.payoutAccountHash,
    quoteHash: hashObject({ supplierId, offer: supplier.record_json.offer, quantity: ready.spec.quantity, landedCost: candidate.landedCost }),
  };
}

/** The order a refId names: confirmed web terms, or a catalog shortlist pick. */
export function planFor(deps: ApiDeps, scope: Scope, refId: string): Promise<OrderPlan | WebOrderPlan> {
  return TERMS_ID_RE.test(refId) ? planWebOrder(deps, scope, refId) : planOrder(deps, scope, refId);
}

const isWeb = (o: OrderPlan | WebOrderPlan): o is WebOrderPlan => "termsId" in o;

const fieldsOf = (o: ApprovalPlan) => ({
  orderId: shortIdToBytes32(o.orderId),
  supplierId: shortIdToBytes32(o.supplierId),
  payee: shortIdToBytes32(o.supplierId),
  payoutAccountHash: o.payoutAccountHash,
  lineId: o.lineId,
  scheduleHash: scheduleHash(o.schedule, o.autoRelease),
  totalMinor: o.schedule.reduce((s, x) => s + x, 0n).toString(),
  quoteHash: o.quoteHash,
  shortlistHash: o.shortlistHash,
  chosenIndex: String(o.chosenIndex),
  inspectionRequired: true,
});

const NAMES = ["Sample", "Deposit", "Balance"] as const;

function catalogRows(o: OrderPlan): DisplayRow[] {
  return [
    row("Order", o.orderId),
    row("Supplier", `${o.candidate.displayName} (rank ${o.candidate.rank} of the shortlist)`),
    row("Pays out to", `${o.account.holderName}, ${o.account.channel} account ending ${o.account.accountNumber.slice(-4)}`, "loosen"),
    ...o.schedule.map((amt, i) =>
      row(`Milestone ${i + 1}: ${NAMES[i]}`, `${formatBu(amt)}, ${o.autoRelease[i] ? "paid by the agent when funded" : "released only with your signature and inspection evidence"}`),
    ),
    row("Paid from", "The supplier pocket, through escrow only"),
  ];
}

/** The decoded orderId (bytes32 → short id) of a signed SupplierApproval. */
const signedOrderId = (signed: Record<string, unknown>): string => Buffer.from(String(signed.orderId).slice(2), "hex").toString("utf8").replace(/\0+$/, "");

/** Writes the payee, the order and its milestones (inside the transaction that consumes the request). */
async function writeOrder(q: Q, scope: Scope, o: ApprovalPlan, displayName: string, sigJson: string): Promise<void> {
  const expected = fieldsOf(o);
  await q.query(
    `insert into payees (id, facility_id, kind, display_name, supplier_id, xendit_account_ref, payout_account_hash, bound_line_ids, approval_sig, status)
     values ($1, $2, 'supplier', $3, $4, $5, $6, $7, $8::jsonb, 'PENDING')`,
    [o.supplierId, scope.facilityId, displayName, o.supplierId, jcs(o.account), o.payoutAccountHash, [o.lineId], sigJson],
  );
  await q.query(
    `insert into escrow_orders (order_id, facility_id, supplier_id, payee_id, schedule_hash, total_minor, quote_hash, shortlist_hash, chosen_index, inspection_required)
     values ($1, $2, $3, $3, $4, $5, $6, $7, $8, true)`,
    [o.orderId, scope.facilityId, o.supplierId, expected.scheduleHash, expected.totalMinor, o.quoteHash, o.shortlistHash, o.chosenIndex],
  );
  for (const [i, amount] of o.schedule.entries()) {
    await q.query("insert into escrow_milestones (order_id, idx, facility_id, amount_minor, auto_release) values ($1, $2, $3, $4, $5)", [o.orderId, i, scope.facilityId, amount.toString(), o.autoRelease[i]]);
  }
}

/** The facility's terms lock (the one confirm takes): every order commit takes it, so commits see each other's orders. */
const lockSupplierPocket = (q: Q, scope: Scope) => q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`supplier-terms:${scope.facilityId}`]);

/**
 * Web terms at commit, under the facility's terms lock (the one confirm takes, so the order is lock → row): the row is
 * still CONFIRMED (locked for this commit), and the schedule still fits the SUPPLIER pocket now, so two orders signed
 * at once can never promise the same budget (the second waits, then sees the first one's open order).
 */
async function recheckAtCommit(deps: ApiDeps, q: Q, scope: Scope, o: WebOrderPlan): Promise<void> {
  await lockSupplierPocket(q, scope);
  const r = await one<{ status: string }>(q, "select status from supplier_terms where facility_id = $1 and id = $2 for update", [scope.facilityId, o.termsId]);
  if (r?.status === "USED") throw termsFailure("TERMS_ALREADY_BOUND", "These terms were approved meanwhile; a web supplier gets one order");
  if (r?.status !== "CONFIRMED") throw termsFailure("TERMS_SUPERSEDED", "These terms changed while you signed; nothing was approved, request again");
  const total = o.schedule.reduce((sum, x) => sum + x, 0n);
  const now = webSchedule(total, o.milestones, await supplierLimits(deps, scope));
  if (now.amounts.join() !== o.schedule.join()) throw fail("CONFLICT", "The supplier pocket changed while you signed; nothing was approved, request again");
}

/** Web terms: CONFIRMED → USED with the order, exactly one row (a superseded or already used row aborts the commit). */
async function markUsed(q: Q, scope: Scope, o: WebOrderPlan): Promise<void> {
  const used = await q.query("update supplier_terms set status = 'USED', order_id = $3, updated_at = now() where facility_id = $1 and id = $2 and status = 'CONFIRMED'", [
    scope.facilityId,
    o.termsId,
    o.orderId,
  ]);
  if (used.rowCount !== 1) throw termsFailure("TERMS_SUPERSEDED", "These terms changed while you signed; nothing was approved, request again");
}

export const supplierApproval: SignKind = {
  async prepare(deps, scope, refId) {
    const o = await planFor(deps, scope, refId);
    if (isWeb(o)) return { contract: "Treasury", title: `Choose ${o.displayName} and sign its payment schedule`, rows: webOrderRows(o), fields: fieldsOf(o) };
    return { contract: "Treasury", title: `Choose ${o.candidate.displayName} and sign its payment schedule`, rows: catalogRows(o), fields: fieldsOf(o) };
  },

  async finalize(deps, scope, req, sig) {
    const signed = req.typed_data_json.message;
    // Web terms are re-planned by the request's refId (the termsId); a catalog pick by the signed order id.
    const o = TERMS_ID_RE.test(req.ref_id) ? await planWebOrder(deps, scope, req.ref_id) : await planOrder(deps, scope, signedOrderId(signed));
    const expected = fieldsOf(o);
    if (Object.entries(expected).some(([k, v]) => signed[k] !== v)) throw fail("CONFLICT", "The terms, the shortlist or the plan changed since you were asked to sign; request again");
    const approval = toViemMessage("SupplierApproval", signed);
    const displayName = isWeb(o) ? o.displayName : o.candidate.displayName;
    return {
      call: buildBindPayee({ approval, schedule: [...o.schedule], autoRelease: [...o.autoRelease], founder: sig }),
      async commit(q) {
        if (isWeb(o)) await recheckAtCommit(deps, q, scope, o);
        else {
          // A catalog order at commit: under the same lock, it still fits next to any order committed meanwhile.
          await lockSupplierPocket(q, scope);
          await requireCatalogRoom(deps, scope, o.schedule, o.autoRelease);
        }
        await writeOrder(q, scope, o, displayName, JSON.stringify({ kind: sig.kind, data: sig.data }));
        if (isWeb(o)) await markUsed(q, scope, o);
        const how = isWeb(o) ? `web supplier ${o.supplierId} (terms ${o.termsId})` : displayName;
        await appendTrace(q, { facilityId: scope.facilityId, traceId: req.id, actor: "founder", kind: "SIGNATURE", summary: `Founder chose ${how} for ${o.orderId}; the payee cools before any payment` });
        return insertAction(q, {
          facilityId: scope.facilityId,
          kind: "Treasury.bindPayee",
          refId: o.orderId,
          request: { approval: signed, schedule: o.schedule.map(String), autoRelease: [...o.autoRelease], founder: { kind: sig.kind, data: sig.data } },
        });
      },
    };
  },
};
