import { describe, expect, it } from "vitest";
import { MEI_FACILITY, RINA_FACILITY } from "@hogee/core";
import { SIMULATED_PAYNOW_PAYOUT, payoutRailLabel } from "./payout-rail";

describe("payoutRailLabel", () => {
  it("labels every payout of a Singapore (SGD) facility as a sample PayNow payout (one word for not real: Sample)", () => {
    expect(payoutRailLabel(MEI_FACILITY.currency)).toBe(SIMULATED_PAYNOW_PAYOUT);
    expect(SIMULATED_PAYNOW_PAYOUT).toBe("Sample payout (PayNow)");
  });

  it("claims no rail for other facilities or before the currency is known", () => {
    expect(payoutRailLabel(RINA_FACILITY.currency)).toBeUndefined();
    expect(payoutRailLabel("IDR")).toBeUndefined();
    expect(payoutRailLabel(undefined)).toBeUndefined();
  });
});
