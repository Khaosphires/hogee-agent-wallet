/** Rina's compile input (§26.2) against the mock MY pack. Ids are deterministic fakes. */
import {
  JUDGING_WINDOW_END,
  RINA_COMMIT_AT,
  RINA_FACILITY,
  RINA_IDS,
  RINA_PLATFORM_REGISTRY,
  examplePlanIntent,
  fakeAddress,
  fakeHex32,
  ZERO_ADDRESS,
  type CompileFacility,
  type CompileInput,
} from "../../src/index";
import { TEST_PACK_MY } from "./packs";

export const RINA_COMPILE_FACILITY: CompileFacility = {
  facilityId: RINA_IDS.facilityId,
  countryCode: RINA_FACILITY.countryCode,
  currency: RINA_FACILITY.currency,
  capMinor: RINA_FACILITY.capMinor,
  reserveFloorBps: RINA_FACILITY.reserveFloorBps,
  judgingWindowEnd: JUDGING_WINDOW_END,
  payees: RINA_PLATFORM_REGISTRY,
  ownerEOA: ZERO_ADDRESS, // passkey-only owner
  lender: fakeAddress("lender:final-1"),
  oracle: fakeAddress("oracle:final-1"),
};

export const RINA_COMPILE_INPUT: CompileInput = {
  intent: examplePlanIntent,
  countryPack: TEST_PACK_MY,
  facility: RINA_COMPILE_FACILITY,
  now: RINA_COMMIT_AT,
  ids: { draftId: "draft-rina-001", planId: fakeHex32("planId:rina"), agentAddress: fakeAddress("agent:final-1") },
  aigc: { model: "claude-sonnet-5-5", promptHash: fakeHex32("promptHash:rina:v1") },
};
