/**
 * Which contract emits each Hogee event (final-1, docs/assurance/require-table-final1.md). All four ABIs inherit
 * IHogeeEvents, so every event decodes from every address; this map says which address may emit it, so a watcher
 * bound to one contract refuses an event that contract never emits (a broken or hostile provider, a mis-wired
 * address). TreasuryGovernance runs by delegatecall, so its events (OwnerSpent, StageReleased, LoosenQueued /
 * Executed / Cancelled, PayeeBound for ADD_PAYEE, Unpaused, ReserveWithdrawn) come from Treasury's address, as do the
 * creditRevenue hook's RevenueRecorded and ReserveSkimmed. SalesOracle emits only SaleRecorded, MilestoneEscrow only
 * the milestone events. Loop-1 deployments have no escrow or oracle: their events simply never occur.
 */
import type { Address } from 'viem';
import { CONTRACT_NAMES, type ContractName, type DeploymentContracts } from './deployments';
import type { iTreasuryAbi } from './generated';

/** Every Hogee event name (the Treasury ABI carries all of IHogeeEvents). */
export type HogeeEventName = Extract<(typeof iTreasuryAbi)[number], { readonly type: 'event' }>['name'];

export const HOGEE_EVENT_SOURCES = {
  FounderKeyRegistered: 'PlanRegistry',
  PlanCommitted: 'PlanRegistry',
  FacilityOpened: 'Treasury',
  Funded: 'Treasury',
  PayeeBound: 'Treasury',
  Spent: 'Treasury',
  OwnerSpent: 'Treasury',
  RevenueRecorded: 'Treasury',
  ReserveSkimmed: 'Treasury',
  ReserveWithdrawn: 'Treasury',
  Tightened: 'Treasury',
  LoosenQueued: 'Treasury',
  LoosenExecuted: 'Treasury',
  LoosenCancelled: 'Treasury',
  StageReleased: 'Treasury',
  Denied: 'Treasury',
  TreasuryPaused: 'Treasury',
  Unpaused: 'Treasury',
  CircuitTripped: 'Treasury',
  SettlementConfirmed: 'Treasury',
  SettlementFailed: 'Treasury',
  MilestoneFunded: 'MilestoneEscrow',
  MilestoneReleased: 'MilestoneEscrow',
  SaleRecorded: 'SalesOracle',
} as const satisfies { readonly [E in HogeeEventName]: ContractName };

/** One address to watch and the contract it is. */
export interface WatchTarget {
  readonly source: ContractName;
  readonly address: Address;
}

/** Every contract of a deployment, in CONTRACT_NAMES order: the addresses a full event feed must poll. */
export function hogeeWatchTargets(contracts: DeploymentContracts): readonly WatchTarget[] {
  return CONTRACT_NAMES.flatMap((source) => {
    const deployed = contracts[source];
    return deployed ? [{ source, address: deployed.address }] : [];
  });
}

/** Whether `source` emits `eventName` (false for a name that is not a Hogee event). */
export function emitsEvent(source: ContractName, eventName: string): boolean {
  return Object.hasOwn(HOGEE_EVENT_SOURCES, eventName) && HOGEE_EVENT_SOURCES[eventName as HogeeEventName] === source;
}
