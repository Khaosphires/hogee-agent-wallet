/**
 * fix-cfo-load: a load-balanced public RPC (Sepolia via publicnode) answers each call from any backend, and they do not
 * see a new block at the same moment. Live log, 19 Oct: the API read the head from one backend and asked another for
 * that block ("BlockNotFoundError: Block at number "11946073" could not be found."), so GET /api/cfo and
 * GET /api/balances answered 502. A read pinned to a block number now retries ONCE after a short delay on an error
 * that says the block is unknown; anything else, or a second failure, still fails closed.
 */
import type { CfoReport } from "@hogee/core";
import { BlockNotFoundError, HttpRequestError, InvalidInputRpcError, RpcRequestError, TransactionReceiptNotFoundError, zeroAddress, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem } from "../src/http/problem";
import { BLOCK_LAG_RETRY_MS, isBlockLagError, retryOnBlockLag } from "../src/services/block-lag";
import { ReportCache } from "../src/services/cfo-cache";
import { BlockTimeCache } from "../src/services/cfo-dating";
import { cfoReport } from "../src/services/cfo";
import { balances } from "../src/services/dashboard";
import { readSnapshot } from "../src/services/snapshot";
import { facilityOnlyDb, fakeDeps } from "./support/fake-deps";

const HEAD = 11_946_073n;
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const hashOf = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const rpcError = (message: string) =>
  new InvalidInputRpcError(new RpcRequestError({ body: { method: "eth_call" }, error: { code: -32000, message }, url: "http://rpc.test" }));
const noWait = { sleep: async () => undefined };

/** Every view readSnapshot and the CFO read, at zero (no plan, no lines): a fresh deployment. */
const VIEWS: Readonly<Record<string, unknown>> = {
  planVersion: 0,
  currentPlan: { planId: ZERO32, version: 0, planHash: ZERO32, countryPackHash: ZERO32, totalMinor: 0n, reserveBps: 0, agent: zeroAddress, agentExpiry: 0n, agentRevoked: false },
  lineIds: [],
  stageIds: [],
  founderKey: [ZERO32, ZERO32, zeroAddress],
  lender: zeroAddress,
  paused: false,
  agentExpiry: 0n,
  balances: { fundedMinor: 0n, releasedMinor: 0n, spentMinor: 0n, escrowedMinor: 0n, revenueMinor: 0n, reserveMinor: 0n },
  facility: { capMinor: 0n, reserveFloorBps: 0, fundedMinor: 0n, opened: false },
  oracle: zeroAddress,
  judgingWindowEnd: 0n,
  observer: zeroAddress,
  revenueLedger: [0n, 0n, 0n],
};

/**
 * A chain behind a load balancer: the head is HEAD, and the first `lagging` reads pinned to HEAD (a getBlock, or a
 * readContract of `laggingView`) hit a backend that has not seen it yet.
 */
function laggingChain(o: { lagging: number; laggingView?: string; error?: () => Error }) {
  const s = { lagsLeft: o.lagging, pinnedGetBlocks: 0, pinnedReads: 0 };
  const lag = (): boolean => {
    if (s.lagsLeft === 0) return false;
    s.lagsLeft -= 1;
    return true;
  };
  const client = {
    getBlockNumber: async () => HEAD,
    getBlock: async (a: { blockTag?: string; blockNumber?: bigint }) => {
      if (a.blockTag === "latest") return { number: HEAD, hash: hashOf(HEAD), timestamp: 1_792_108_800n };
      if (a.blockNumber === HEAD) {
        s.pinnedGetBlocks += 1;
        if (o.laggingView === undefined && lag()) throw o.error?.() ?? new BlockNotFoundError({ blockNumber: HEAD });
      }
      return { number: a.blockNumber, hash: hashOf(a.blockNumber ?? 0n), timestamp: 1_792_108_800n };
    },
    readContract: async (a: { functionName: string; blockNumber?: bigint }) => {
      if (a.blockNumber === HEAD) s.pinnedReads += 1;
      if (a.functionName === o.laggingView && lag()) throw o.error?.() ?? rpcError("header not found");
      if (!(a.functionName in VIEWS)) throw new Error(`unexpected read ${a.functionName}`);
      return VIEWS[a.functionName];
    },
  };
  const fake = fakeDeps({ deps: { client: client as never, db: facilityOnlyDb(false) } });
  return { s, ...fake };
}

const scope = { facilityId: "fac-rina", founderId: "founder-rina" };
const freshCaches = () => ({ reports: new ReportCache<CfoReport>(), blockTimes: new BlockTimeCache() });

afterEach(() => {
  vi.useRealTimers();
});

describe("isBlockLagError: the errors that say a backend has not seen the block yet", () => {
  it.each([
    ["viem BlockNotFoundError (getBlock answered null)", new BlockNotFoundError({ blockNumber: HEAD })],
    ["geth's -32000 'header not found' on eth_call", rpcError("header not found")],
    ["'unknown block' (erigon / nethermind)", rpcError("unknown block")],
    ["wrapped as a cause (readContract → call → RPC)", new Error("readContract failed", { cause: rpcError("header not found") })],
    ["a receipt not found yet", new TransactionReceiptNotFoundError({ hash: ZERO32 })],
  ])("%s", (_name, error) => {
    expect(isBlockLagError(error)).toBe(true);
  });

  it.each([
    ["a revert", new Error("execution reverted")],
    ["an HTTP 429 from the node", new HttpRequestError({ url: "http://rpc.test", status: 429 })],
    ["a pruned state ('missing trie node')", rpcError("missing trie node")],
    ["not an Error", "header not found"],
    ["nothing", undefined],
  ])("not %s", (_name, error) => {
    expect(isBlockLagError(error)).toBe(false);
  });

  it("stops on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isBlockLagError(a)).toBe(false);
  });
});

describe("retryOnBlockLag: one retry, after a short wait, on a lag error only", () => {
  it("returns the first answer without waiting", async () => {
    const sleep = vi.fn(async () => undefined);
    expect(await retryOnBlockLag(async () => 7, { sleep })).toBe(7);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("waits BLOCK_LAG_RETRY_MS once and reads again", async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let calls = 0;
    const read = async () => {
      calls += 1;
      if (calls === 1) throw new BlockNotFoundError({ blockNumber: HEAD });
      return "ok";
    };
    expect(await retryOnBlockLag(read, { sleep, onRetry })).toBe("ok");
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(BLOCK_LAG_RETRY_MS);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("any other error fails at once (no retry)", async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const err = await retryOnBlockLag(
      async () => {
        calls += 1;
        throw new Error("execution reverted");
      },
      { sleep },
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe("execution reverted");
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("is bounded: a block still unknown on the retry fails with that second error", async () => {
    let calls = 0;
    const err = await retryOnBlockLag(async () => {
      calls += 1;
      throw new BlockNotFoundError({ blockNumber: BigInt(calls) });
    }, noWait).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockNotFoundError);
    expect((err as Error).message).toContain('"2"');
    expect(calls).toBe(2);
  });
});

describe("readSnapshot tolerates a lagging backend", () => {
  it("a getBlock of the head answered BlockNotFound once: read again, same block", async () => {
    const { s, deps } = laggingChain({ lagging: 1 });
    const snap = await readSnapshot(deps, undefined, noWait);
    expect(snap.blockNumber).toBe(HEAD);
    expect(s.pinnedGetBlocks).toBe(2);
  });

  it("a view read at the head answered 'header not found' once: read again, same block", async () => {
    const { s, deps } = laggingChain({ lagging: 1, laggingView: "balances" });
    const snap = await readSnapshot(deps, HEAD, noWait);
    expect(snap.balances.fundedMinor).toBe(0n);
    expect(s.lagsLeft).toBe(0);
  });

  it("fails closed when the block is still unknown on the retry", async () => {
    const { s, deps } = laggingChain({ lagging: 2 });
    await expect(readSnapshot(deps, undefined, noWait)).rejects.toBeInstanceOf(BlockNotFoundError);
    expect(s.pinnedGetBlocks).toBe(2);
  });
});

describe("GET /api/cfo and GET /api/balances on a lagging backend (the 19 Oct 502)", () => {
  it("cfoReport answers the report when the head block was not found once, and logs the retry", async () => {
    const { s, deps, logs } = laggingChain({ lagging: 1 });
    const report = await cfoReport(deps, scope, { ...freshCaches(), lag: noWait });
    expect(report.overview.cashAvailableMinor).toBe("0");
    expect(s.pinnedGetBlocks).toBe(2);
    expect(logs.map((l) => l.event)).toContain("chain_block_lag_retry");
    expect(logs.map((l) => l.event)).not.toContain("cfo_records_failed");
  });

  it("cfoReport tolerates the revenue ledger read lagging too", async () => {
    const { deps } = laggingChain({ lagging: 1, laggingView: "revenueLedger" });
    await expect(cfoReport(deps, scope, { ...freshCaches(), lag: noWait })).resolves.toMatchObject({ reserve: { skimmedMinor: "0" } });
  });

  it("cfoReport still answers UPSTREAM (fail closed) when the block stays unknown", async () => {
    const { deps, logs } = laggingChain({ lagging: 99 });
    const err = await cfoReport(deps, scope, { ...freshCaches(), lag: noWait }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblem);
    expect((err as ApiProblem).failure.code).toBe("UPSTREAM");
    expect(logs.map((l) => l.event)).toContain("cfo_records_failed");
  });

  it("balances waits BLOCK_LAG_RETRY_MS and answers instead of 502", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { s, deps, logs } = laggingChain({ lagging: 1 });
    const pending = balances(deps, scope);
    await vi.advanceTimersByTimeAsync(BLOCK_LAG_RETRY_MS);
    await expect(pending).resolves.toMatchObject({ fundedMinor: "0", drift: 0 });
    expect(s.pinnedGetBlocks).toBe(2);
    expect(logs.map((l) => l.event)).not.toContain("snapshot_failed");
  });
});
