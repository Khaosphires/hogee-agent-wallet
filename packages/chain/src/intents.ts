/**
 * Has a payment's intent taken effect on-chain? (§12.3, G0-AUDIT v-4). Three reads, never guesses:
 *
 * - {@link probeIntent}: recovery's "is it already executed?" check before any re-send, at `latest`, with
 *   the intent's event searched in a lookback window (and the executing tx hash when found).
 * - {@link intentEffect}: the CANCELLED proof, from views read at ONE given block (the `finalized` head):
 *   SPEND / OWNER_SPEND `isIntentUsed`; FUND_MILESTONE `fundedMinor` vs `cumulativeAfterMinor`;
 *   RELEASE_MILESTONE `released` (true for good once released, even after a failed payout: re-check M-1), else
 *   Treasury `settlementState(settlementId)` as a second proof; WITHDRAW_RESERVE the loosen's status.
 * - {@link effectTxHashes}: which txs in a block range emitted this intent's event.
 */
import { getAbiItem, type AbiEvent, type Address, type Hex } from 'viem';
import type { HogeePublicClient } from './clients';
import type { DeploymentContracts } from './deployments';
import { iMilestoneEscrowAbi, iTreasuryAbi } from './generated';
import { HOGEE_KINDS } from './kinds';
import type { PaymentIntentFields } from './targets';
import { fundMilestoneIntentId, releaseMilestoneIntentId } from './tx-builder';
import { decisionIdToBytes32, shortIdToBytes32 } from './values';
import { DEFAULT_LOG_CHUNK, planChunksBackward } from './watcher';

export interface HogeeContracts {
  readonly Treasury: Address;
  readonly MilestoneEscrow?: Address;
}

/** The addresses intent reads use, from a deployment manifest's `contracts`. */
export function hogeeContractsOf(contracts: DeploymentContracts): HogeeContracts {
  return Object.freeze({
    Treasury: contracts.Treasury.address,
    ...(contracts.MilestoneEscrow ? { MilestoneEscrow: contracts.MilestoneEscrow.address } : {}),
  });
}

export type IntentReadClient = Pick<HogeePublicClient, 'readContract' | 'getLogs' | 'getBlockNumber'>;

/** `absent` is a proof that the effect is not there; `unknown` means it could not be established. */
export type IntentEffect = 'absent' | 'present' | 'unknown';

export type Probe =
  | { readonly status: 'executed'; readonly txHash?: Hex; readonly block?: bigint }
  | { readonly status: 'not_executed' }
  | { readonly status: 'unknown' };

interface FoundLog {
  readonly args: Readonly<Record<string, unknown>>;
  readonly transactionHash: Hex | null;
  readonly blockNumber: bigint | null;
}

/** The getLogs filter that finds an intent's event; `match` checks non-indexed args. */
interface EffectQuery {
  readonly address: Address;
  readonly event: AbiEvent;
  readonly args: Readonly<Record<string, unknown>>;
  readonly match?: (args: Readonly<Record<string, unknown>>) => boolean;
}

type LooseGetLogs = (a: {
  address: Address;
  event: AbiEvent;
  args: Readonly<Record<string, unknown>>;
  fromBlock: bigint;
  toBlock: bigint;
}) => Promise<readonly FoundLog[]>;

const SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'Spent' });
const OWNER_SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'OwnerSpent' });
const RESERVE_WITHDRAWN = getAbiItem({ abi: iTreasuryAbi, name: 'ReserveWithdrawn' });
const MILESTONE_FUNDED = getAbiItem({ abi: iMilestoneEscrowAbi, name: 'MilestoneFunded' });
const MILESTONE_RELEASED = getAbiItem({ abi: iMilestoneEscrowAbi, name: 'MilestoneReleased' });

const sameHex = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

function milestoneRef(p: PaymentIntentFields): { orderId: Hex; idx: number } | null {
  if (p.orderId === null || p.milestoneIdx === null) return null;
  return { orderId: shortIdToBytes32(p.orderId, 'orderId'), idx: p.milestoneIdx };
}

function effectQuery(p: PaymentIntentFields, contracts: HogeeContracts): EffectQuery | null {
  const treasury = contracts.Treasury;
  const escrow = contracts.MilestoneEscrow;
  switch (p.kind) {
    case 'SPEND':
      return { address: treasury, event: SPENT, args: { spendId: p.intentId } };
    case 'OWNER_SPEND':
      return { address: treasury, event: OWNER_SPENT, args: { spendId: p.intentId } };
    case 'WITHDRAW_RESERVE':
      return { address: treasury, event: RESERVE_WITHDRAWN, args: { settlementId: p.intentId } };
    case 'FUND_MILESTONE': {
      const ref = milestoneRef(p);
      if (!escrow || !ref || p.decisionId === null) return null;
      const decisionId = decisionIdToBytes32(p.decisionId);
      return { address: escrow, event: MILESTONE_FUNDED, args: ref, match: (a) => sameHex(a.decisionId, decisionId) };
    }
    case 'RELEASE_MILESTONE': {
      const ref = milestoneRef(p);
      return escrow && ref ? { address: escrow, event: MILESTONE_RELEASED, args: ref } : null;
    }
    default:
      return null;
  }
}

async function fetchLogs(client: Pick<HogeePublicClient, 'getLogs'>, q: EffectQuery, range: { fromBlock: bigint; toBlock: bigint }): Promise<FoundLog[]> {
  const logs = await (client.getLogs as unknown as LooseGetLogs)({ address: q.address, event: q.event, args: q.args, ...range });
  return logs.filter((l) => !q.match || q.match(l.args));
}

/** Tx hashes (lowercase) in [fromBlock, toBlock] whose logs show this intent's effect; [] if none or unknown kind. */
export async function effectTxHashes(
  client: Pick<HogeePublicClient, 'getLogs'>,
  p: PaymentIntentFields,
  a: { contracts: HogeeContracts; fromBlock: bigint; toBlock: bigint },
): Promise<Hex[]> {
  const q = effectQuery(p, a.contracts);
  if (!q) return [];
  const logs = await fetchLogs(client, q, { fromBlock: a.fromBlock, toBlock: a.toBlock });
  return logs.map((l) => l.transactionHash?.toLowerCase() as Hex | undefined).filter((h): h is Hex => h !== undefined);
}

export interface ProbeOptions {
  readonly contracts: HogeeContracts;
  /** Blocks searched back from the head for the intent's event (default 64). */
  readonly logLookbackBlocks?: bigint;
  /** getLogs range per request (default 10). */
  readonly logChunkSize?: bigint;
}

const DEFAULT_LOOKBACK = 64n;

/** Searches [head − lookback + 1, head] newest-first in chunks; returns the first matching log. */
async function findEffectLog(client: IntentReadClient, q: EffectQuery, opts: ProbeOptions): Promise<FoundLog | null> {
  // cacheTime 0: viem caches the block number for pollingInterval (12 s on Sepolia); a stale head would
  // miss the block that just executed the intent.
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const lookback = opts.logLookbackBlocks ?? DEFAULT_LOOKBACK;
  const from = head + 1n > lookback ? head + 1n - lookback : 0n;
  for (const range of planChunksBackward(from, head, opts.logChunkSize ?? DEFAULT_LOG_CHUNK)) {
    const hit = (await fetchLogs(client, q, range))[0];
    if (hit) return hit;
  }
  return null;
}

const executed = (log: FoundLog | null): Probe => ({
  status: 'executed',
  ...(log?.transactionHash ? { txHash: log.transactionHash.toLowerCase() as Hex } : {}),
  ...(log?.blockNumber !== null && log?.blockNumber !== undefined ? { block: log.blockNumber } : {}),
});

/**
 * Is this payment's intent already executed on-chain (at `latest`)? Executed when the effect view says so
 * or the intent's event is in the lookback window (then with the executing tx); `not_executed` only when
 * the view proves absence ({@link intentEffect}); otherwise `unknown`.
 */
export async function probeIntent(client: IntentReadClient, p: PaymentIntentFields, opts: ProbeOptions): Promise<Probe> {
  const q = effectQuery(p, opts.contracts);
  const log = q ? await findEffectLog(client, q, opts) : null;
  const effect = await intentEffect(client, p, { contracts: opts.contracts });
  if (effect === 'present' || log) return executed(log);
  return effect === 'absent' ? { status: 'not_executed' } : { status: 'unknown' };
}

/**
 * The intent's on-chain effect from views read at `blockNumber` (omit for `latest`). FUND_MILESTONE has no
 * intent registry and the row does not store `cumulativeAfterMinor`, so it is recovered from the intent key
 * keccak256(abi.encode(orderId, idx, amountMinor, cumulativeAfterMinor)): if the key matches
 * `fundedMinor + amountMinor`, then fundedMinor is below cumulativeAfterMinor (absent); if it matches
 * `fundedMinor`, the funding is in (present); otherwise `unknown`.
 */
export async function intentEffect(
  client: Pick<HogeePublicClient, 'readContract'>,
  p: PaymentIntentFields,
  a: { contracts: HogeeContracts; blockNumber?: bigint },
): Promise<IntentEffect> {
  const at = a.blockNumber !== undefined ? { blockNumber: a.blockNumber } : {};
  const treasury = a.contracts.Treasury;
  const escrow = a.contracts.MilestoneEscrow;
  switch (p.kind) {
    case 'SPEND':
    case 'OWNER_SPEND': {
      const used = await client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'isIntentUsed', args: [p.intentId], ...at });
      return used ? 'present' : 'absent';
    }
    case 'WITHDRAW_RESERVE': {
      const q = await client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [p.intentId], ...at });
      return q.status === HOGEE_KINDS.LOOSEN_STATUS_EXECUTED ? 'present' : 'absent';
    }
    case 'RELEASE_MILESTONE':
    case 'FUND_MILESTONE': {
      const ref = milestoneRef(p);
      if (!escrow || !ref) return 'unknown';
      const all = await client.readContract({ address: escrow, abi: iMilestoneEscrowAbi, functionName: 'milestones', args: [ref.orderId], ...at });
      const m = all[ref.idx];
      if (!m) return 'unknown';
      if (p.kind === 'RELEASE_MILESTONE') return m.released ? 'present' : releaseSettlementEffect(client, treasury, ref, at);
      return fundEffect(p, ref, m.fundedMinor);
    }
    default:
      return 'unknown';
  }
}

/**
 * A milestone that reads not released. Since re-check M-1 the escrow never clears `released` (a failed payout returns
 * the BU to the supplier line in Treasury and leaves the milestone released), so this means never released. The
 * settlement read stays as defence in depth: a CONFIRMED or FAILED settlement for the milestone's settlementId proves
 * the release took effect whatever the escrow reads (the pre-M-1 escrow cleared `released` on a failed payout). An
 * open record (NONE) cannot sit beside `released == false`, so NONE is absent.
 */
async function releaseSettlementEffect(
  client: Pick<HogeePublicClient, 'readContract'>,
  treasury: Address,
  ref: { orderId: Hex; idx: number },
  at: { blockNumber?: bigint },
): Promise<IntentEffect> {
  const settlementId = releaseMilestoneIntentId(ref);
  const state = await client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'settlementState', args: [settlementId], ...at });
  return state === HOGEE_KINDS.SETTLEMENT_FAILED || state === HOGEE_KINDS.SETTLEMENT_CONFIRMED ? 'present' : 'absent';
}

const UINT128_MAX = (1n << 128n) - 1n;

function fundEffect(p: PaymentIntentFields, ref: { orderId: Hex; idx: number }, fundedMinor: bigint): IntentEffect {
  const amountMinor = BigInt(p.amountMinor);
  const key = (cumulativeAfterMinor: bigint) => fundMilestoneIntentId({ ...ref, amountMinor, cumulativeAfterMinor });
  if (fundedMinor + amountMinor <= UINT128_MAX && sameHex(key(fundedMinor + amountMinor), p.intentId)) return 'absent';
  if (sameHex(key(fundedMinor), p.intentId)) return 'present';
  return 'unknown';
}
