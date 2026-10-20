/** Rina demo fixtures (project.md §26.2) built from @hogee/core exports: compile input, policy context, bindings. */
import {
  JUDGING_WINDOW_END,
  RINA_COMMIT_AT,
  RINA_FACILITY,
  RINA_IDS,
  RINA_PLATFORM_REGISTRY,
  ZERO_ADDRESS,
  compilePlan,
  examplePlanIntent,
  fakeAddress,
  fakeHex32,
  initialPolicyContext,
  planHash,
  rinaSupplierABinding,
  type CompileFacility,
  type PolicyContext,
  type PolicyEscrowOrder,
  type PolicyPayeeState,
} from "@hogee/core";
import type { PlannerContext } from "../../src/planner/planner";
import { TEST_PACK_MY } from "./pack";

export const DAY = 86_400n;
export const T0 = BigInt(RINA_COMMIT_AT);

export const RINA_COMPILE_FACILITY: CompileFacility = {
  facilityId: RINA_IDS.facilityId,
  countryCode: RINA_FACILITY.countryCode,
  currency: RINA_FACILITY.currency,
  capMinor: RINA_FACILITY.capMinor,
  reserveFloorBps: RINA_FACILITY.reserveFloorBps,
  judgingWindowEnd: JUDGING_WINDOW_END,
  payees: RINA_PLATFORM_REGISTRY,
  ownerEOA: ZERO_ADDRESS,
  lender: fakeAddress("lender:final-1"),
  oracle: fakeAddress("oracle:final-1"),
};

export const RINA_IDS_V1 = { draftId: "draft-rina-001", planId: fakeHex32("planId:rina"), agentAddress: fakeAddress("agent:final-1") };

export const RINA_PLANNER_CONTEXT: PlannerContext = {
  facility: RINA_COMPILE_FACILITY,
  countryPack: TEST_PACK_MY,
  now: RINA_COMMIT_AT,
  ids: RINA_IDS_V1,
};

export const RINA_DRAFT = compilePlan({
  intent: examplePlanIntent,
  countryPack: TEST_PACK_MY,
  facility: RINA_COMPILE_FACILITY,
  now: RINA_COMMIT_AT,
  ids: RINA_IDS_V1,
  aigc: { model: "claude-sonnet-5-5", promptHash: fakeHex32("promptHash:rina:v1") },
});
export const RINA_MANIFEST = RINA_DRAFT.manifest;

/** A bound PACKAGING printer (ADD_PAYEE executed), cooling until day 3. */
export const PRINTER: PolicyPayeeState = { payeeId: "printer-kl", source: "bound", lineKeys: ["PACKAGING"], coolingUntil: String(T0 + 3n * DAY), paidMinor: "0" };
export const PRINTER_ACCOUNT = "1234500001";
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

/** Day `n` after commitPlan, printer listed on PACKAGING, supplier A bound with its order. */
export function rinaCtx(day: bigint): PolicyContext {
  const base = initialPolicyContext(RINA_MANIFEST, planHash(RINA_MANIFEST), RINA_COMPILE_FACILITY, T0 + day * DAY);
  const packaging = base.lines.PACKAGING;
  if (!packaging) throw new Error("no PACKAGING line");
  return {
    ...base,
    lines: { ...base.lines, PACKAGING: { ...packaging, payeeIds: [PRINTER.payeeId] } },
    payees: [...RINA_PLATFORM_REGISTRY.map((p) => ({ ...p, paidMinor: "0" })), SUPPLIER_A, PRINTER],
    escrowOrders: [ORDER_A],
  };
}
