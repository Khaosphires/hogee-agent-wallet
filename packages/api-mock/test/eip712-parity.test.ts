/** The mock's EIP-712 mirror (src/eip712.ts) must equal @hogee/chain exactly. */
import { describe, expect, it } from "vitest";
import * as chain from "@hogee/chain";
import { LOOSEN_KINDS, VERIFYING_CONTRACT_OF, hogeeDomain, hogeeTypes, scheduleHash, toBytes32Tag } from "../src/eip712";

describe("eip712 mirror", () => {
  it("struct field lists equal hogeeTypes", () => {
    expect(hogeeTypes).toEqual(chain.hogeeTypes);
  });

  it("verifying contracts equal VERIFYING_CONTRACT_OF", () => {
    expect(VERIFYING_CONTRACT_OF).toEqual(chain.VERIFYING_CONTRACT_OF);
  });

  it("loosen kinds equal HOGEE_KINDS", () => {
    for (const [name, value] of Object.entries(LOOSEN_KINDS)) expect(chain.HOGEE_KINDS[name as keyof typeof chain.HOGEE_KINDS], name).toBe(value);
  });

  it("toBytes32Tag and the domain salt match", () => {
    expect(toBytes32Tag("final-1")).toBe(chain.toBytes32Tag("final-1"));
    const p = { verifyingContract: "0x00000000000000000000000000000000000000aa" as const, chainTag: toBytes32Tag("sepolia"), deploymentId: toBytes32Tag("final-1") };
    expect(hogeeDomain(p)).toEqual({ ...chain.hogeeDomain(p) });
  });

  it("scheduleHash matches the chain's abi encoding", () => {
    const amounts = [75_000n, 175_000n];
    const auto = [true, false];
    expect(scheduleHash(amounts, auto)).toBe(chain.scheduleHash(amounts, auto));
    expect(scheduleHash([250_000n], [false])).toBe(chain.scheduleHash([250_000n], [false]));
    expect(() => scheduleHash([1n], [])).toThrow();
  });
});
