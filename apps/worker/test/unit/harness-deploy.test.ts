/**
 * The harness deploy lets the node estimate each transaction's gas (decision amsterdam §1): forge's own simulation runs
 * the repo's evm_version (cancun), ~7x under Amsterdam's state-creation cost (EIP-8037) on a Sepolia fork, so final-1's
 * PlanRegistry died OutOfGas at code deposit; a fixed 8x multiplier instead breaks Anvil's 30M block gas limit.
 */
import { describe, expect, it } from 'vitest';
import { anvilAccount, FORGE_NODE_GAS_ARGS, forgeScriptArgs } from '../../src/harness/deploy';

describe('forgeScriptArgs', () => {
  const sender = anvilAccount(0).address;
  const args = forgeScriptArgs('script/DeployFinal.s.sol:DeployFinal', 'http://127.0.0.1:8545', sender);

  it('broadcasts the script from the unlocked Anvil account, no key', () => {
    expect(args.slice(0, 8)).toEqual(['script', 'script/DeployFinal.s.sol:DeployFinal', '--rpc-url', 'http://127.0.0.1:8545', '--broadcast', '--unlocked', '--sender', sender]);
    expect(args.join(' ')).not.toMatch(/private-key|keystore|mnemonic/);
  });

  it("takes each gas limit from the node's eth_estimateGas, one transaction at a time", () => {
    expect(FORGE_NODE_GAS_ARGS).toEqual(['--skip-simulation', '--slow']);
    expect(args).toEqual(expect.arrayContaining([...FORGE_NODE_GAS_ARGS]));
    expect(args).not.toContain('--gas-estimate-multiplier');
  });
});
