/**
 * Mei's facility context for the brain (compiler, constitution, policy) and her compile input, mirroring
 * ./rina-context.ts and core/test/fixtures/rina-compile.ts. Built from the numbers in ./mei.ts.
 *
 * There is no SG country pack in core: `meiCompileInput` takes one (data/country-packs/SG.json once it exists, or a
 * test fixture), so no SG fact is ever fixed here. Ids are deterministic fakes for demos and tests.
 */
import { ZERO_ADDRESS } from "../constitution/check";
import type { ConstitutionFacility, RegistryPayee } from "../constitution/types";
import type { CompileFacility, CompileInput } from "../compiler/compile";
import type { CountryPack } from "../schemas/country-pack";
import { fakeAddress, fakeHex32 } from "../schemas/example-data/fake";
import { DEMO_COOLING_SECONDS, JUDGING_WINDOW_END } from "./rina-context";
import { MEI_COMMIT_AT, MEI_FACILITY, MEI_IDS, MEI_PLAN_INTENT, MEI_PLATFORM_PAYEES, MEI_SUPPLIER_A_SCHEDULE } from "./mei";

/** Static platform registry for a Shopee seller in SG (plans may name these without a SupplierApproval). */
export const MEI_PLATFORM_REGISTRY: readonly RegistryPayee[] = [
  { payeeId: MEI_PLATFORM_PAYEES.LOGISTICS, source: "platform", lineKeys: ["LOGISTICS"], channels: ["shopee"] },
  { payeeId: MEI_PLATFORM_PAYEES.ADS, source: "platform", lineKeys: ["ADS"], channels: ["shopee"] },
  { payeeId: MEI_PLATFORM_PAYEES.PLATFORM_FEES, source: "platform", lineKeys: ["PLATFORM_FEES"], channels: ["shopee"] },
];

/** Supplier A (SG) after Mei signs the SupplierApproval (bound to SUPPLIER, lifetime cap = schedule total 430,000). */
export function meiSupplierABinding(boundAt: bigint): RegistryPayee {
  return {
    payeeId: MEI_IDS.supplierAPayeeId,
    source: "bound",
    lineKeys: ["SUPPLIER"],
    schedule: MEI_SUPPLIER_A_SCHEDULE.map((m) => ({ amountMinor: m.amountMinor, autoRelease: m.autoRelease })),
    coolingUntil: String(boundAt + BigInt(DEMO_COOLING_SECONDS)),
  };
}

/** Mei's facility as the constitution sees it at plan v1 (no supplier bound yet; role keys are deployment facts). */
export const MEI_CONSTITUTION_FACILITY: ConstitutionFacility = {
  capMinor: MEI_FACILITY.capMinor,
  reserveFloorBps: MEI_FACILITY.reserveFloorBps,
  judgingWindowEnd: JUDGING_WINDOW_END,
  payees: MEI_PLATFORM_REGISTRY,
  ownerEOA: ZERO_ADDRESS,
  lender: ZERO_ADDRESS,
  oracle: ZERO_ADDRESS,
};

/** Mei's facility as the compiler sees it. The lender and oracle are the shared final-1 deployment's (same fakes as Rina's). */
export const MEI_COMPILE_FACILITY: CompileFacility = {
  facilityId: MEI_IDS.facilityId,
  countryCode: MEI_FACILITY.countryCode,
  currency: MEI_FACILITY.currency,
  capMinor: MEI_FACILITY.capMinor,
  reserveFloorBps: MEI_FACILITY.reserveFloorBps,
  judgingWindowEnd: JUDGING_WINDOW_END,
  payees: MEI_PLATFORM_REGISTRY,
  ownerEOA: ZERO_ADDRESS, // passkey-only owner
  lender: fakeAddress("lender:final-1"),
  oracle: fakeAddress("oracle:final-1"),
};

/** Mei's compile input against `countryPack` (an SG pack; the compiler refuses any other country). */
export function meiCompileInput(countryPack: CountryPack): CompileInput {
  return {
    intent: MEI_PLAN_INTENT,
    countryPack,
    facility: MEI_COMPILE_FACILITY,
    now: MEI_COMMIT_AT,
    ids: { draftId: "draft-mei-001", planId: fakeHex32("planId:mei"), agentAddress: fakeAddress("agent:mei:final-1") },
    aigc: { model: "claude-sonnet-5-5", promptHash: fakeHex32("promptHash:mei:v1") },
  };
}
