/** The CFO's prefilled raise link (fixr-cfo): only a known line, cap kind and whole minor units prefill the form. */
import { describe, expect, it } from "vitest";
import { parseBuInput } from "./format";
import { minorToBuInput, raisePrefill } from "./raise-prefill";

describe("raisePrefill", () => {
  it("reads the link core builds", () => {
    expect(raisePrefill("?raise=LOGISTICS&cap=window&to=40000")).toEqual({ lineKey: "LOGISTICS", cap: "window", amountBu: "400" });
    expect(raisePrefill("?tab=spending&raise=ADS&cap=perTx&to=1250")).toEqual({ lineKey: "ADS", cap: "perTx", amountBu: "12.50" });
  });

  it("prefills nothing from anything else", () => {
    for (const bad of ["", "?raise=ADS", "?raise=ads&cap=window&to=100", "?raise=ADS&cap=daily&to=100", "?raise=ADS&cap=window&to=-1", "?raise=ADS&cap=window&to=01", "?raise=ADS&cap=window&to=1e5"]) {
      expect(raisePrefill(bad)).toBeNull();
    }
  });

  it("round-trips through the form's own parser", () => {
    for (const m of ["1", "99", "100", "40000", "123456789"]) expect(parseBuInput(minorToBuInput(m))).toBe(m);
  });
});
