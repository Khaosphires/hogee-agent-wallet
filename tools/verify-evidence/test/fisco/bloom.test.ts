import { describe, expect, it } from "vitest";
import { logsBloom } from "../../src/index";
import { fiscoLogsBloom } from "../../src/fisco/bloom";

// S1 (Treasury.openFacility) of the first FISCO BCOS 3.17.1 mirror run, as node0 served it.
const S1_LOG = {
  address: "0xA3a58B08E0d2A626743Ff6D93b60290C5680423a",
  topics: [
    "0xa13b3bf65836ba042e1c911cb9917b4c2112124ea25e79b6e38d46c767b6eadd",
    "0x0000000000000000000000002d0c3e04f88aeaf427108c9a5672b6cc3a4da497",
  ],
};
const S1_BLOOM =
  "0x00000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000400000002000000000000000000000000000200000000000000000008000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000";

describe("fiscoLogsBloom", () => {
  it("reproduces the bloom FISCO 3.17.1 served for a real receipt", () => {
    expect(fiscoLogsBloom([S1_LOG])).toBe(S1_BLOOM);
  });

  it("differs from Ethereum's bloom: the address enters as its lowercase hex text", () => {
    expect(logsBloom([S1_LOG])).not.toBe(S1_BLOOM);
    // The address's case does not matter; the topics enter as on Ethereum.
    expect(fiscoLogsBloom([{ ...S1_LOG, address: S1_LOG.address.toLowerCase() }])).toBe(S1_BLOOM);
  });

  it("is the zero bloom without logs", () => {
    expect(fiscoLogsBloom([])).toBe(`0x${"00".repeat(256)}`);
  });
});
