/**
 * The chain's clock and finality, the only part of the run that differs between targets:
 *   anvil    evm_increaseTime + one mined block; finality = mine 70 blocks (Anvil's `finalized` is latest − 64);
 *            exact timestamps (T22) through evm_setNextBlockTimestamp.
 *   sepolia  waits real time until the latest block is past the target; finality = wait until the `finalized` tag
 *            reaches the block that was latest when asked. No time travel: cases that need it are "not run".
 */
import type { HogeePublicClient } from "@hogee/chain";
import { createTestClient, http } from "viem";
import { anvil } from "viem/chains";
import type { Target } from "./config";

export interface ChainClock {
  readonly target: Target;
  /** Latest block timestamp (unix seconds). */
  now(): Promise<bigint>;
  /** Moves chain time forward by at least `seconds`. */
  advance(seconds: bigint): Promise<void>;
  /** Every block mined so far becomes `finalized`. */
  finalize(): Promise<void>;
  /** Anvil only: the next block gets exactly this timestamp. */
  readonly setNextTimestamp?: (t: bigint) => Promise<void>;
  /** Anvil only: test balance for gas. */
  readonly setBalance?: (address: `0x${string}`, wei: bigint) => Promise<void>;
  /** Anvil only: mine blocks now. */
  readonly mine?: (blocks: number) => Promise<void>;
  /** Anvil only: switch automine (T22 puts two spends in one block). */
  readonly setAutomine?: (on: boolean) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function anvilClock(client: HogeePublicClient, rpcUrl: string): ChainClock {
  const test = createTestClient({ mode: "anvil", chain: anvil, transport: http(rpcUrl) });
  return {
    target: "anvil",
    now: async () => (await client.getBlock({ blockTag: "latest" })).timestamp,
    advance: async (seconds) => {
      await test.increaseTime({ seconds: Number(seconds) });
      await test.mine({ blocks: 1 });
    },
    finalize: async () => {
      await test.mine({ blocks: 70 });
    },
    setNextTimestamp: async (t) => {
      await test.setNextBlockTimestamp({ timestamp: t });
    },
    setBalance: async (address, wei) => {
      await test.setBalance({ address, value: wei });
    },
    mine: async (blocks) => {
      await test.mine({ blocks });
    },
    setAutomine: async (on) => {
      await test.setAutomine(on);
    },
  };
}

/** Real-time waits on Sepolia (12 s slots; `finalized` lags about two epochs, ~13 min). */
export function sepoliaClock(client: HogeePublicClient, opts: { pollMs?: number; maxWaitMs?: number } = {}): ChainClock {
  const pollMs = opts.pollMs ?? 12_000;
  const maxWaitMs = opts.maxWaitMs ?? 45 * 60_000;
  const until = async (what: string, ok: () => Promise<boolean>) => {
    const deadline = Date.now() + maxWaitMs;
    while (!(await ok())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(pollMs);
    }
  };
  const now = async () => (await client.getBlock({ blockTag: "latest" })).timestamp;
  return {
    target: "sepolia",
    now,
    advance: async (seconds) => {
      const target = (await now()) + seconds;
      await until(`chain time ${target}`, async () => (await now()) >= target);
    },
    finalize: async () => {
      const latest = await client.getBlockNumber();
      await until(`finalized >= ${latest}`, async () => (await client.getBlock({ blockTag: "finalized" })).number >= latest);
    },
  };
}
