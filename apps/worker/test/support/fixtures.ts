/**
 * Rina fixtures for the unit tests: a chain snapshot right after commitPlan + fund (core's example manifest, §26.2
 * numbers), and the committed plan row that matches it.
 */
import { examplePlanManifest, hashObject, RINA_COMMIT_AT, type PlanManifest } from '@hogee/core';
import { toBytes32Tag } from '@hogee/chain';
import { zeroAddress, type Address, type Hex } from 'viem';
import type { ChainSnapshot, LineView } from '../../src/chain/snapshot';
import type { CommittedPlan } from '../../src/chain/context';

export const UINT128_MAX = (1n << 128n) - 1n;
export const LENDER: Address = '0x00000000000000000000000000000000000000a1';
export const ORACLE: Address = '0x00000000000000000000000000000000000000a2';
export const OWNER: Address = '0x00000000000000000000000000000000000000a3';
export const OBSERVER: Address = '0x00000000000000000000000000000000000000a4';
export const NOW = BigInt(RINA_COMMIT_AT) + 86_400n;

export const manifest: PlanManifest = examplePlanManifest;
/** planHash = keccak256(utf8(JCS(PlanManifest))) (§8.1). */
export const PLAN_HASH = hashObject(manifest) as Hex;
export const AGENT: Address = manifest.agent.address as Address;

export const committed: CommittedPlan = {
  planId: manifest.planId as Hex,
  version: 1,
  planHash: PLAN_HASH,
  manifest,
};

function lineView(l: PlanManifest['lines'][number], over: Partial<LineView['pocket']> = {}, sequence?: bigint): LineView {
  const payeeIds = l.payeeIds.map((p) => toBytes32Tag(p));
  return {
    lineId: l.lineId as Hex,
    pocket: {
      allocatedMinor: BigInt(l.amountMinor),
      spentMinor: 0n,
      escrowedMinor: 0n,
      availableMinor: BigInt(l.amountMinor),
      perTxCapMinor: BigInt(l.perTxCapMinor),
      windowCapMinor: BigInt(l.windowCapMinor),
      windowSpentMinor: 0n,
      windowSeconds: Number(l.windowSeconds),
      validUntil: BigInt(l.validUntil),
      pacingMinor: l.pacing ? BigInt(l.pacing.amountMinor) : 0n,
      escrowOnly: l.escrowOnly,
      paused: false,
      circuitOpen: false,
      ...over,
    },
    sequence: sequence ?? (l.pacing ? 1n : 0n),
    payeeIds,
    bindings: payeeIds.map((payeeId) => ({
      payeeId,
      bound: true,
      coolingUntil: 0n,
      lifetimeCapMinor: UINT128_MAX,
      paidMinor: 0n,
      payoutAccountHash: toBytes32Tag(`acct-${l.lineKey.toLowerCase()}`),
    })),
  };
}

export interface SnapshotOptions {
  readonly ads?: Partial<LineView['pocket']>;
  readonly adsSequence?: bigint;
  readonly paused?: boolean;
  readonly now?: bigint;
  readonly observer?: Address;
}

/** Chain state after commitPlan (stage 1 = 400,000 released) and fund(1,000,000). */
export function rinaSnapshot(o: SnapshotOptions = {}): ChainSnapshot {
  return {
    blockNumber: 100n,
    timestamp: o.now ?? NOW,
    planVersion: 1,
    plan: {
      planId: committed.planId,
      version: 1,
      planHash: PLAN_HASH,
      countryPackHash: manifest.countryPackHash as Hex,
      totalMinor: 1_000_000n,
      reserveBps: manifest.reserveBps,
      agent: AGENT,
      agentExpiry: BigInt(manifest.agent.expiresAt),
      agentRevoked: false,
      committedAt: BigInt(RINA_COMMIT_AT),
    },
    paused: o.paused ?? false,
    agentExpiry: BigInt(manifest.agent.expiresAt),
    balances: { fundedMinor: 1_000_000n, releasedMinor: 400_000n, spentMinor: 0n, escrowedMinor: 0n, revenueMinor: 0n, reserveMinor: 0n },
    facility: { capMinor: 1_000_000n, reserveFloorBps: 300, fundedMinor: 1_000_000n, opened: true },
    lines: manifest.lines.map((l) => (l.lineKey === 'ADS' ? lineView(l, o.ads, o.adsSequence) : lineView(l))),
    stages: manifest.stages.map((s, i) => ({ stageId: toBytes32Tag(s.stageId), released: i === 0 })),
    roles: { ownerEOA: OWNER, lender: LENDER, oracle: ORACLE, observer: o.observer ?? zeroAddress },
    judgingWindowEnd: BigInt(RINA_COMMIT_AT) + 45n * 86_400n,
  };
}

export const roles = { agent: AGENT, lender: LENDER, oracle: ORACLE };
