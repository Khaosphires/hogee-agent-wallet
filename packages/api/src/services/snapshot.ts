/**
 * Read-only chain snapshot at ONE block (§26.9 views), the API's counterpart of the worker's mirror: plan, lines,
 * pockets, sequences, bindings, stages, balances, roles. Everything the policy engine and the dashboard read comes
 * from one block so it is consistent. Nothing here signs.
 */
import { parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { ApiDeps } from "../context";
import { iMilestoneEscrowAbi, iPlanRegistryAbi, iTreasuryAbi } from "../chain-lib";
import { lagErrorName, retryOnBlockLag, type BlockLagOptions } from "./block-lag";

/** Outside the frozen ABI; observer() exists only on the final-1 Treasury (loop-1 has none, so it is never read there). */
const extraAbi = parseAbi(["function oracle() view returns (address)", "function judgingWindowEnd() view returns (uint64)", "function observer() view returns (address)"]);

export interface BindingView {
  readonly payeeId: Hex;
  readonly bound: boolean;
  readonly coolingUntil: bigint;
  readonly lifetimeCapMinor: bigint;
  readonly paidMinor: bigint;
  readonly payoutAccountHash: Hex;
}

export interface LineView {
  readonly lineId: Hex;
  readonly pocket: {
    readonly allocatedMinor: bigint;
    readonly spentMinor: bigint;
    readonly escrowedMinor: bigint;
    readonly availableMinor: bigint;
    readonly perTxCapMinor: bigint;
    readonly windowCapMinor: bigint;
    readonly windowSpentMinor: bigint;
    readonly windowSeconds: number;
    readonly validUntil: bigint;
    readonly pacingMinor: bigint;
    readonly escrowOnly: boolean;
    readonly paused: boolean;
    readonly circuitOpen: boolean;
  };
  readonly sequence: bigint;
  readonly payeeIds: readonly Hex[];
  readonly bindings: readonly BindingView[];
}

export interface Snapshot {
  readonly blockNumber: bigint;
  readonly timestamp: bigint;
  readonly planVersion: number;
  readonly plan: {
    readonly planId: Hex;
    readonly version: number;
    readonly planHash: Hex;
    readonly countryPackHash: Hex;
    readonly totalMinor: bigint;
    readonly reserveBps: number;
    readonly agent: Address;
    readonly agentExpiry: bigint;
    readonly agentRevoked: boolean;
  };
  readonly paused: boolean;
  readonly agentExpiry: bigint;
  readonly balances: {
    readonly fundedMinor: bigint;
    readonly releasedMinor: bigint;
    readonly spentMinor: bigint;
    readonly escrowedMinor: bigint;
    readonly revenueMinor: bigint;
    readonly reserveMinor: bigint;
  };
  readonly facility: { readonly capMinor: bigint; readonly reserveFloorBps: number; readonly fundedMinor: bigint; readonly opened: boolean };
  readonly lines: readonly LineView[];
  readonly stages: readonly { readonly stageId: Hex; readonly released: boolean }[];
  /** observer: Treasury.observer() on the final-1 shape, zero = none (always zero on loop-1). */
  readonly roles: { readonly ownerEOA: Address; readonly lender: Address; readonly oracle: Address; readonly observer: Address };
  readonly judgingWindowEnd: bigint;
}

/** `log` (optional): where a block-lag retry is reported (every API caller passes its deps, which have one). */
type Reader = Pick<ApiDeps, "client" | "deployment"> & { readonly log?: ApiDeps["log"] };

/**
 * The snapshot at `blockNumber` (default: the head). Every read is pinned to that block and retried once on a backend
 * that has not seen it yet (./block-lag.ts), so a load-balanced RPC does not fail a snapshot taken at its head.
 */
export async function readSnapshot(d: Reader, blockNumber?: bigint, lag: BlockLagOptions = {}): Promise<Snapshot> {
  const block = blockNumber ?? (await d.client.getBlockNumber({ cacheTime: 0 }));
  const registry = d.deployment.contracts.PlanRegistry.address;
  const treasury = d.deployment.contracts.Treasury.address;
  const at = { blockNumber: block } as const;
  const retry = lagRetry(d, block, lag);
  const pinned = <T>(read: () => Promise<T>): Promise<T> => retryOnBlockLag(read, retry);
  const reg = (functionName: string, args?: readonly unknown[]) =>
    pinned(() => d.client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName, ...(args ? { args } : {}), ...at } as never) as Promise<unknown>);
  const tre = (functionName: string, args?: readonly unknown[]) =>
    pinned(() => d.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName, ...(args ? { args } : {}), ...at } as never) as Promise<unknown>);
  const extra = (address: Address, functionName: "oracle" | "judgingWindowEnd" | "observer") =>
    pinned(() => d.client.readContract({ address, abi: extraAbi, functionName, ...at }));
  const finalShape = (d.deployment.contracts as { MilestoneEscrow?: unknown }).MilestoneEscrow !== undefined;
  const [b, planVersion, plan, lineIds, stageIds, founder, lender, paused, agentExpiry, balances, facility, oracle, judgingWindowEnd, observer] = await Promise.all([
    pinned(() => d.client.getBlock({ blockNumber: block })),
    reg("planVersion") as Promise<number>,
    reg("currentPlan") as Promise<Snapshot["plan"]>,
    reg("lineIds") as Promise<readonly Hex[]>,
    reg("stageIds") as Promise<readonly Hex[]>,
    reg("founderKey") as Promise<readonly [Hex, Hex, Address]>,
    reg("lender") as Promise<Address>,
    tre("paused") as Promise<boolean>,
    tre("agentExpiry") as Promise<bigint>,
    tre("balances") as Promise<Snapshot["balances"]>,
    tre("facility") as Promise<Snapshot["facility"]>,
    extra(treasury, "oracle") as Promise<Address>,
    extra(registry, "judgingWindowEnd") as Promise<bigint>,
    finalShape ? (extra(treasury, "observer") as Promise<Address>) : Promise.resolve(zeroAddress),
  ]);
  const lines = await Promise.all(
    lineIds.map(async (lineId): Promise<LineView> => {
      const [line, pocket, sequence] = await Promise.all([
        reg("line", [lineId]) as Promise<{ payeeIds: readonly Hex[] }>,
        tre("pocket", [lineId]) as Promise<LineView["pocket"]>,
        tre("lineSequence", [lineId]) as Promise<bigint>,
      ]);
      const bindings = await Promise.all(
        line.payeeIds.map(async (payeeId): Promise<BindingView> => ({ payeeId, ...((await tre("payeeBinding", [lineId, payeeId])) as Omit<BindingView, "payeeId">) })),
      );
      return { lineId, pocket, sequence: BigInt(sequence), payeeIds: line.payeeIds, bindings };
    }),
  );
  const stages = await Promise.all(
    stageIds.map(async (stageId) => {
      const [, released] = (await reg("stage", [stageId])) as readonly [unknown, boolean];
      return { stageId, released };
    }),
  );
  return {
    blockNumber: block,
    timestamp: b.timestamp,
    planVersion: Number(planVersion),
    plan: { ...plan, version: Number(plan.version), reserveBps: Number(plan.reserveBps) },
    paused,
    agentExpiry: BigInt(agentExpiry),
    balances,
    facility: { ...facility, reserveFloorBps: Number(facility.reserveFloorBps) },
    lines,
    stages,
    roles: { ownerEOA: founder[2], lender, oracle, observer },
    judgingWindowEnd: BigInt(judgingWindowEnd),
  };
}

/**
 * Retry options for the reads pinned to `block`: the first retry is logged (when the reader has a log; once, however
 * many parallel reads retry), then every retry reaches `lag.onRetry`.
 */
export function lagRetry(d: Pick<Reader, "log">, block: bigint, lag: BlockLagOptions = {}): BlockLagOptions {
  let logged = false;
  return {
    ...lag,
    onRetry: (error) => {
      if (!logged) d.log?.info("chain_block_lag_retry", { blockNumber: block.toString(), error: lagErrorName(error) });
      logged = true;
      lag.onRetry?.(error);
    },
  };
}

/** Escrow milestones of an order as the chain holds them (empty when the order is not bound yet). */
export async function milestonesOnChain(d: Reader, orderId: Hex) {
  return d.client.readContract({ address: d.deployment.contracts.MilestoneEscrow.address, abi: iMilestoneEscrowAbi, functionName: "milestones", args: [orderId] });
}

/** Right-padded bytes32 ShortId → string (inverse of toBytes32Tag). */
export function shortIdFromBytes32(value: Hex): string {
  const hex = value.slice(2).replace(/(00)+$/, "");
  return Buffer.from(hex, "hex").toString("latin1");
}
