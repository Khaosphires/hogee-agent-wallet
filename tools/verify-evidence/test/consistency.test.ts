/** The verifier's own EIP-712 types, ABI fragments and line/stage hashing equal @hogee/chain's (no silent drift). */
import { describe, expect, it } from "vitest";
import { keccak256, toHex, type AbiEvent, type AbiFunction } from "viem";
import { examplePlanManifest } from "@hogee/core";
import * as chain from "@hogee/chain";
import { HOGEE_TYPEHASHES, HOGEE_TYPES, VERIFYING_CONTRACT, domainSalt, hogeeCallsAbi, hogeeEventsAbi, linesHash, stagesHash, typeString } from "../src/index";

const generated = [...chain.iTreasuryAbi, ...chain.iPlanRegistryAbi, ...chain.iMilestoneEscrowAbi, ...chain.iSalesOracleAbi];
const shape = (inputs: readonly { name?: string; type: string; indexed?: boolean; components?: unknown }[]) =>
  inputs.map((i) => ({ name: i.name, type: i.type, indexed: i.indexed ?? false, components: JSON.stringify(i.components ?? null) }));

describe("EIP-712 types", () => {
  it("match @hogee/chain and HogeeTypes.sol typehashes", () => {
    for (const kind of Object.keys(HOGEE_TYPES) as (keyof typeof HOGEE_TYPES)[]) {
      expect(HOGEE_TYPES[kind]).toEqual(chain.hogeeTypes[kind].map((f) => ({ ...f })));
      expect(typeString(kind)).toBe(chain.HOGEE_TYPE_STRINGS[kind]);
      expect(keccak256(toHex(typeString(kind)))).toBe(HOGEE_TYPEHASHES[kind]);
      expect(HOGEE_TYPEHASHES[kind]).toBe(chain.HOGEE_TYPEHASHES[kind]);
      expect(VERIFYING_CONTRACT[kind]).toBe(chain.VERIFYING_CONTRACT_OF[kind]);
    }
    expect(HOGEE_TYPEHASHES.EIP712Domain).toBe(keccak256(toHex(chain.HOGEE_TYPE_STRINGS.EIP712Domain)));
  });

  it("derive the domain salt like @hogee/chain", () => {
    expect(domainSalt("sepolia", "final-1")).toBe(chain.hogeeDomainSalt(chain.toBytes32Tag("sepolia"), chain.toBytes32Tag("final-1")));
  });
});

describe("ABI fragments", () => {
  it("every event equals the generated ABI (names, types, indexed)", () => {
    for (const ev of hogeeEventsAbi as readonly AbiEvent[]) {
      const g = generated.find((x) => x.type === "event" && x.name === ev.name) as AbiEvent | undefined;
      expect(g, ev.name).toBeDefined();
      expect(shape(ev.inputs)).toEqual(shape((g as AbiEvent).inputs));
    }
  });

  it("the decoded calls equal the generated ABI", () => {
    for (const fn of (hogeeCallsAbi as readonly AbiFunction[]).filter((x) => x.type === "function")) {
      const g = generated.find((x) => x.type === "function" && x.name === fn.name) as AbiFunction | undefined;
      expect(g, fn.name).toBeDefined();
      const types = (f: AbiFunction) => f.inputs.map((i) => (i as { type: string }).type);
      expect(chain.iTreasuryAbi.length).toBeGreaterThan(0);
      expect(types(fn)).toEqual(types(g as AbiFunction));
    }
  });
});

describe("plan commitments", () => {
  it("linesHash / stagesHash equal @hogee/chain's for the example manifest", () => {
    expect(linesHash(examplePlanManifest)).toBe(chain.hashLines(chain.manifestToLines(examplePlanManifest)));
    expect(stagesHash(examplePlanManifest)).toBe(chain.hashStages(chain.manifestToStages(examplePlanManifest)));
  });
});
