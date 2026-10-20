/**
 * Escrow orders per supplier.
 *  - G2 (P2 request): GET /api/suppliers/:id names the supplier's escrow order, so the suppliers page stops hard-coding
 *    the demo id. The live API reads escrow_orders; the mock's orders are its escrow map, whose ids follow the live
 *    naming per demo: `<orderPrefix><x>-NNN` for `supplier-<x>` (both demos: order-a-001, as the live API does).
 *    The newest one wins; null when the supplier has none.
 *  - SupplierApproval's refId, as the live API reads it (api services/signing/supplier-approval.ts planOrder): an
 *    escrow order id, or a shortlisted supplier id. A supplier with an order names its newest order; one without gets
 *    its first order with the live schedule (sample 7.5% and deposit 30% of the goods, auto-released; the balance needs
 *    the founder's release), written to the escrow map when the founder signs.
 */
import { mulDivFloor, parseMinor, type EscrowSchedule, type Hex32, type OrderId, type RankedSupplier } from "@hogee/core";
import type { SupplierWithOrder } from "@hogee/api-contract";
import { appendTrace, nextId, pocketOf, type MockState } from "./store";
import type { Failure } from "./result";

const SUPPLIER_RE = /^supplier-([a-z0-9]{1,20})$/;
const BU = 100n;
const floorBu = (x: bigint): bigint => (x / BU) * BU;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The supplier's orders in the escrow map, oldest first. */
function ordersOf(st: MockState, supplierId: string): string[] {
  const suffix = SUPPLIER_RE.exec(supplierId)?.[1];
  if (!suffix) return [];
  const re = new RegExp(`^${escapeRe(st.profile.orderPrefix)}${suffix}-\\d{3}$`);
  return [...st.escrow.keys()].filter((id) => re.test(id)).sort();
}

export function supplierWithOrder(st: MockState, supplierId: string): SupplierWithOrder | Failure {
  const supplier = st.suppliers.get(supplierId);
  if (!supplier) return { code: "NOT_FOUND", message: `No supplier ${supplierId}` };
  return { ...supplier, orderId: (ordersOf(st, supplierId).at(-1) as OrderId | undefined) ?? null };
}

export interface SupplierOrder {
  readonly orderId: string;
  readonly candidate: RankedSupplier;
  readonly schedule: EscrowSchedule;
  /** False until the founder signs: the order is then written to the escrow map. */
  readonly exists: boolean;
}

/** Sample, deposit, balance from the goods value, as live (Mei and Rina: 400,000 → 30,000 / 120,000 / 280,000). */
function newSchedule(st: MockState, candidate: RankedSupplier): EscrowSchedule | Failure {
  const allocated = parseMinor(pocketOf(st, "SUPPLIER")?.allocated ?? "0");
  const landed = parseMinor(candidate.landedCost.totalMinor);
  const cap = mulDivFloor(allocated, 8_000n, 10_000n);
  const goods = floorBu(landed < cap ? landed : cap);
  const sample = floorBu(mulDivFloor(goods, 750n, 10_000n));
  const deposit = floorBu(mulDivFloor(goods, 3_000n, 10_000n));
  const amounts = [sample, deposit, goods - deposit];
  if (amounts.some((a) => a <= 0n)) return { code: "CONFLICT", message: "The supplier pocket cannot hold this order" };
  return amounts.map((a, idx) => ({ idx, amountMinor: a.toString(), funded: "0", released: false, autoRelease: idx < 2 }));
}

/** The order a SupplierApproval with this refId approves (an order id, or a shortlisted supplier id). */
export function supplierOrderFor(st: MockState, refId: string): SupplierOrder | Failure {
  const shortlist = st.loaded.scenario["shortlist.json"];
  const rankOne = shortlist.candidates.find((c) => c.rank === 1) ?? shortlist.candidates[0];
  const existing = st.escrow.get(refId);
  if (existing) {
    const candidate = shortlist.candidates.find((c) => ordersOf(st, c.supplierId).includes(refId)) ?? rankOne;
    return candidate ? { orderId: refId, candidate, schedule: existing, exists: true } : { code: "CONFLICT", message: "The shortlist has no candidate to approve" };
  }
  const suffix = SUPPLIER_RE.exec(refId)?.[1];
  if (!suffix) return { code: "NOT_FOUND", message: `No escrow order or shortlisted supplier ${refId}` };
  const candidate = shortlist.candidates.find((c) => c.supplierId === refId);
  if (!candidate) return { code: "NOT_FOUND", message: "That supplier is not on the current shortlist" };
  const newest = ordersOf(st, refId).at(-1);
  const schedule = newest ? st.escrow.get(newest) : undefined;
  if (newest && schedule) return { orderId: newest, candidate, schedule, exists: true };
  const fresh = newSchedule(st, candidate);
  if (!Array.isArray(fresh)) return fresh as Failure;
  return { orderId: `${st.profile.orderPrefix}${suffix}-001`, candidate, schedule: fresh, exists: false };
}

/** POST /api/escrow/:orderId/inspection's effect: the evidence hash on every held milestone not yet released, and its trace. */
export function recordInspection(st: MockState, orderId: string, evidenceHash: Hex32): void {
  const schedule = st.escrow.get(orderId);
  if (!schedule) return;
  st.escrow.set(orderId, schedule.map((m) => (!m.released && !m.autoRelease ? { ...m, evidenceHash } : m)));
  appendTrace(st, { traceId: nextId(st, "trace"), actor: "founder", kind: "TOOL_CALL", summary: "Founder uploaded inspection evidence (hash recorded; the file stays off-chain)", refs: {} });
}
