/**
 * Reads the ChainSnapshot at ONE block number (§26.9 views), so every value the policy sees is from the same state.
 * Two views are outside the frozen ABI (not frozen surface, but public on the loop-1 contracts): Treasury.oracle()
 * and PlanRegistry.judgingWindowEnd(); they are read with a small local ABI. So is Treasury.observer(), which only the
 * final-1 Treasury has: it is read only when the manifest carries a MilestoneEscrow (the final-1 shape).
 */
import { iPlanRegistryAbi, iTreasuryAbi, type DeploymentManifest, type HogeePublicClient } from '@hogee/chain';
import { getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { BindingView, ChainSnapshot, LineView } from './snapshot';

export type MirrorClient = Pick<HogeePublicClient, 'readContract' | 'getBlock'>;

const extraAbi = parseAbi([
  'function oracle() view returns (address)',
  'function judgingWindowEnd() view returns (uint64)',
  'function observer() view returns (address)',
]);

export async function readChainSnapshot(client: MirrorClient, deployment: Pick<DeploymentManifest, 'contracts'>, blockNumber: bigint): Promise<ChainSnapshot> {
  const registry = deployment.contracts.PlanRegistry.address;
  const treasury = deployment.contracts.Treasury.address;
  const at = { blockNumber } as const;
  const reg = <F extends string>(functionName: F, args?: readonly unknown[]) =>
    client.readContract({ address: registry, abi: iPlanRegistryAbi, functionName, ...(args ? { args } : {}), ...at } as never) as Promise<unknown>;
  const tre = <F extends string>(functionName: F, args?: readonly unknown[]) =>
    client.readContract({ address: treasury, abi: iTreasuryAbi, functionName, ...(args ? { args } : {}), ...at } as never) as Promise<unknown>;

  const finalShape = deployment.contracts.MilestoneEscrow !== undefined;
  const [block, planVersion, plan, lineIds, stageIds, founder, lender, paused, agentExpiry, balances, facility, oracle, judgingWindowEnd, observer] = await Promise.all([
    client.getBlock({ blockNumber }),
    reg('planVersion') as Promise<number>,
    reg('currentPlan') as Promise<ChainSnapshot['plan']>,
    reg('lineIds') as Promise<readonly Hex[]>,
    reg('stageIds') as Promise<readonly Hex[]>,
    reg('founderKey') as Promise<readonly [Hex, Hex, Address]>,
    reg('lender') as Promise<Address>,
    tre('paused') as Promise<boolean>,
    tre('agentExpiry') as Promise<bigint>,
    tre('balances') as Promise<ChainSnapshot['balances']>,
    tre('facility') as Promise<ChainSnapshot['facility']>,
    client.readContract({ address: treasury, abi: extraAbi, functionName: 'oracle', ...at }),
    client.readContract({ address: registry, abi: extraAbi, functionName: 'judgingWindowEnd', ...at }),
    finalShape ? client.readContract({ address: treasury, abi: extraAbi, functionName: 'observer', ...at }) : Promise.resolve(zeroAddress),
  ]);

  const lines: LineView[] = await Promise.all(
    lineIds.map(async (lineId): Promise<LineView> => {
      const [line, pocket, sequence] = await Promise.all([
        reg('line', [lineId]) as Promise<{ payeeIds: readonly Hex[] }>,
        tre('pocket', [lineId]) as Promise<LineView['pocket']>,
        tre('lineSequence', [lineId]) as Promise<bigint>,
      ]);
      const bindings = await Promise.all(
        line.payeeIds.map(async (payeeId): Promise<BindingView> => ({ payeeId, ...((await tre('payeeBinding', [lineId, payeeId])) as Omit<BindingView, 'payeeId'>) })),
      );
      return { lineId, pocket, sequence: BigInt(sequence), payeeIds: line.payeeIds, bindings };
    }),
  );
  const stages = await Promise.all(
    stageIds.map(async (stageId) => {
      const [, released] = (await reg('stage', [stageId])) as readonly [unknown, boolean];
      return { stageId, released };
    }),
  );

  return {
    blockNumber,
    timestamp: block.timestamp,
    planVersion: Number(planVersion),
    plan: { ...plan, version: Number(plan.version), reserveBps: Number(plan.reserveBps) },
    paused,
    agentExpiry: BigInt(agentExpiry),
    balances,
    facility: { ...facility, reserveFloorBps: Number(facility.reserveFloorBps) },
    lines,
    stages,
    roles: { ownerEOA: getAddress(founder[2]), lender: getAddress(lender), oracle: getAddress(oracle), observer: getAddress(observer) },
    judgingWindowEnd: BigInt(judgingWindowEnd),
  };
}
