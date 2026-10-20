/**
 * The forge deploy lets the node estimate each transaction's gas (decision amsterdam §1): forge's own simulation runs
 * the repo's evm_version (cancun) and set PlanRegistry's limit to 5.9M on a Sepolia (Amsterdam) fork, where its
 * creation uses 32.3M, so it died OutOfGas; a fixed 8x multiplier instead breaks Anvil's 30M block gas limit.
 */
import { describe, expect, it } from "vitest";
import { anvilAccount, FORGE_NODE_GAS_ARGS, forgeDeployArgs } from "../src/deploy";

describe("forgeDeployArgs", () => {
  const sender = anvilAccount(0).address;
  const args = forgeDeployArgs("http://127.0.0.1:8591", sender);

  it("broadcasts DeployFinal from the unlocked Anvil account, no key", () => {
    expect(args.slice(0, 8)).toEqual(["script", "script/DeployFinal.s.sol:DeployFinal", "--rpc-url", "http://127.0.0.1:8591", "--broadcast", "--unlocked", "--sender", sender]);
    expect(args.join(" ")).not.toMatch(/private-key|keystore|mnemonic/);
  });

  it("takes each gas limit from the node's eth_estimateGas, one transaction at a time", () => {
    expect(FORGE_NODE_GAS_ARGS).toEqual(["--skip-simulation", "--slow"]);
    expect(args).toEqual(expect.arrayContaining([...FORGE_NODE_GAS_ARGS]));
    expect(args).not.toContain("--gas-estimate-multiplier");
  });
});
