/**
 * Rina's facility context for the brain (compiler, constitution, policy): the static platform payee registry
 * and the judging-window constant, built from the frozen numbers in ./rina.ts (§26.2).
 */
import { ZERO_ADDRESS } from "../constitution/check";
import type { ConstitutionFacility, RegistryPayee } from "../constitution/types";
import type { UnixSeconds } from "../schemas/primitives";
import {
  JUDGING_WINDOW_END_ISO,
  RINA_FACILITY,
  RINA_IDS,
  RINA_PLATFORM_PAYEES,
  RINA_SUPPLIER_A_SCHEDULE,
} from "./rina";

/** Deployment constant: unix seconds of JUDGING_WINDOW_END_ISO (2026-11-30T23:59:59Z). */
export const JUDGING_WINDOW_END: UnixSeconds = String(Date.parse(JUDGING_WINDOW_END_ISO) / 1000);

/** Static platform registry for a Shopee seller in MY (plans may name these without a SupplierApproval). */
export const RINA_PLATFORM_REGISTRY: readonly RegistryPayee[] = [
  { payeeId: RINA_PLATFORM_PAYEES.LOGISTICS, source: "platform", lineKeys: ["LOGISTICS"], channels: ["shopee"] },
  { payeeId: RINA_PLATFORM_PAYEES.ADS, source: "platform", lineKeys: ["ADS"], channels: ["shopee"] },
  { payeeId: RINA_PLATFORM_PAYEES.PLATFORM_FEES, source: "platform", lineKeys: ["PLATFORM_FEES"], channels: ["shopee"] },
];

/** Demo cooling period after bindPayee (labelled demo value). */
export const DEMO_COOLING_SECONDS = 120;

/** Supplier A after Rina signs the SupplierApproval (bound to SUPPLIER, lifetime cap = schedule total 430,000). */
export function rinaSupplierABinding(boundAt: bigint): RegistryPayee {
  return {
    payeeId: RINA_IDS.supplierAPayeeId,
    source: "bound",
    lineKeys: ["SUPPLIER"],
    schedule: RINA_SUPPLIER_A_SCHEDULE.map((m) => ({ amountMinor: m.amountMinor, autoRelease: m.autoRelease })),
    coolingUntil: String(boundAt + BigInt(DEMO_COOLING_SECONDS)),
  };
}

/**
 * Rina's facility as the constitution sees it at plan v1 (no supplier bound yet). The role keys are deployment facts
 * the worker mirrors from Treasury; core does not know them, so they are ZERO_ADDRESS here (Rina is a passkey owner).
 */
export const RINA_CONSTITUTION_FACILITY: ConstitutionFacility = {
  capMinor: RINA_FACILITY.capMinor,
  reserveFloorBps: RINA_FACILITY.reserveFloorBps,
  judgingWindowEnd: JUDGING_WINDOW_END,
  payees: RINA_PLATFORM_REGISTRY,
  ownerEOA: ZERO_ADDRESS,
  lender: ZERO_ADDRESS,
  oracle: ZERO_ADDRESS,
};
