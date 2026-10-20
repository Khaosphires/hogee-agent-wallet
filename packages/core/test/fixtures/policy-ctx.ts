/** Policy-engine fixtures: Rina's compiled plan one day after commitPlan, and proposal builders. */
import {
  RINA_COMMIT_AT,
  RINA_PLATFORM_REGISTRY,
  TRUSTED_PUBLIC,
  compilePlan,
  fakeHex32,
  initialPolicyContext,
  planHash,
  rinaSupplierABinding,
  sequenceInvoiceHash,
  trusted,
  type LineKey,
  type PolicyContext,
  type PolicyEscrowOrder,
  type PolicyPayeeState,
  type SpendProposalIn,
} from "../../src/index";
import { RINA_COMPILE_FACILITY, RINA_COMPILE_INPUT } from "./rina-compile";

export const DAY = 86_400n;
export const T0 = BigInt(RINA_COMMIT_AT);
export const RINA_DRAFT = compilePlan(RINA_COMPILE_INPUT);
export const RINA_MANIFEST = RINA_DRAFT.manifest;
export const RINA_PLAN_HASH = planHash(RINA_MANIFEST);

/** Fresh context on day 1 (stage 1 released, nothing spent). */
export function ctxDay1(): PolicyContext {
  return initialPolicyContext(RINA_MANIFEST, RINA_PLAN_HASH, RINA_COMPILE_FACILITY, T0 + DAY);
}

export function withLineState(ctx: PolicyContext, key: LineKey, patch: Partial<NonNullable<PolicyContext["lines"][LineKey]>>): PolicyContext {
  const current = ctx.lines[key];
  if (!current) throw new Error(`no line ${key}`);
  return { ...ctx, lines: { ...ctx.lines, [key]: { ...current, ...patch } } };
}

/** A bound PACKAGING printer (ADD_PAYEE executed), cooling until day 3. */
export const PRINTER: PolicyPayeeState = { payeeId: "printer-kl", source: "bound", lineKeys: ["PACKAGING"], coolingUntil: String(T0 + 3n * DAY), paidMinor: "0" };

/** Supplier A bound at T0 (cooling 120 s), with its escrow order. */
export const SUPPLIER_A: PolicyPayeeState = { ...rinaSupplierABinding(T0), paidMinor: "0" };
export const ORDER_A: PolicyEscrowOrder = {
  orderId: "order-a-001",
  payeeId: "supplier-a",
  lineKey: "SUPPLIER",
  inspectionRequired: true,
  milestones: [
    { amountMinor: "30000", fundedMinor: "0", autoRelease: true, released: false },
    { amountMinor: "120000", fundedMinor: "0", autoRelease: true, released: false },
    { amountMinor: "280000", fundedMinor: "0", autoRelease: false, released: false },
  ],
};

/** Day 1 with supplier A bound and the printer added to PACKAGING by ADD_PAYEE (so Treasury lists it on that line). */
export function ctxWithSupplier(): PolicyContext {
  const ctx = withLineState(ctxDay1(), "PACKAGING", { payeeIds: [PRINTER.payeeId] });
  return { ...ctx, payees: [...RINA_PLATFORM_REGISTRY.map((p) => ({ ...p, paidMinor: "0" })), SUPPLIER_A, PRINTER], escrowOrders: [ORDER_A] };
}

let seq = 0;
/** A valid invoice spend on LOGISTICS (trusted plan tick), unless patched. */
export function spend(patch: Partial<SpendProposalIn> = {}): SpendProposalIn {
  seq += 1;
  return {
    kind: "SPEND",
    origin: TRUSTED_PUBLIC,
    lineKey: trusted("LOGISTICS", "plan"),
    payeeId: trusted("spx-logistics", "db:payees"),
    amountMinor: trusted("20000", "db:invoice"),
    invoiceHash: fakeHex32(`test:invoice:${seq}`),
    intentId: fakeHex32(`test:intent:${seq}`),
    planVersion: 1,
    basis: { invoiceId: `inv-${seq}`, flags: [] },
    ...patch,
  };
}

/** A pacing spend on ADS for `slot` (amount = the manifest's pacing; invoiceHash = bytes32(slot), as Treasury reads it). */
export function pacingSpend(slot: number, amount = "7500"): SpendProposalIn {
  return spend({
    lineKey: trusted("ADS", "plan"),
    payeeId: trusted("shopee-ads", "registry:platform"),
    amountMinor: trusted(amount, "plan:pacing"),
    invoiceHash: sequenceInvoiceHash(slot),
    basis: { pacingSlot: slot },
  });
}
