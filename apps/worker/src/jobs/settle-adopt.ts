/**
 * Reserve withdrawals enter settlement from the chain, not from an API row (§9.1, M8). Treasury.executeLoosen of a
 * LOOSEN_WITHDRAW_RESERVE emits ReserveWithdrawn(loosenId, taxPayeeId, amount) and opens settlement `loosenId`, which
 * the ORACLE closes with the same confirmSettlement / failSettlement calls as a spend. Anyone may execute a matured
 * loosening, so the tx may not be the worker's: for every WITHDRAW_RESERVE exception whose loosen reads EXECUTED at
 * `finalized` and that no live payment row of this deployment covers yet, the worker records a worker-owned
 * WITHDRAW_RESERVE row (`reserve:<loosenId>`, state FINALIZED) from the finalized log and the executing tx's own signed
 * bytes (rebuilt from the chain and checked against its hash, so the row's signed-state CHECKs hold).
 *
 * The exception is only a hint for which loosen ids to look up: an id that never executed adopts nothing, and the
 * adopted row is bound to the chain again on every settle pass (settle-binding.ts) before anything is paid.
 *
 * Finding the executing log never scans a block range (audit run-4 L7: RPCs such as the Alchemy free tier cap
 * eth_getLogs at 10 blocks): the block where the loosen first reads EXECUTED is found by a binary search over
 * historical state (firstBlockWhere, as nonces.ts findNonceConsumer does), and the log is read from that one block.
 * Founder-signed settlements another account executed first are adopted the same way (settle-adopt-founder.ts).
 */
import { HOGEE_KINDS, iPlanRegistryAbi, iTreasuryAbi, shortErrorReason } from '@hogee/chain';
import { BaseError, ContractFunctionZeroDataError, getAbiItem, keccak256, serializeTransaction, type AccessList, type Hex } from 'viem';
import { poolOf, rows } from '../store/pg';
import { appendTrace } from '../store/trace';
import type { JobDeps } from './deps';
import { traceIdOf } from './pacing';
import { finalizedHead, same, shortIdOfBytes32, ZERO32, type FinalizedHead } from './settle-chain';

const RESERVE_WITHDRAWN = getAbiItem({ abi: iTreasuryAbi, name: 'ReserveWithdrawn' });
const HEX32_RE = /^0x[0-9a-f]{64}$/;

export const reserveRowId = (loosenId: Hex): string => `reserve:${loosenId.toLowerCase()}`;

export interface AdoptOutcome {
  readonly paymentId: string;
  readonly step: 'error';
  readonly detail: string;
}

/** The fields of a mined transaction (viem getTransaction) needed to rebuild its signed bytes. */
export interface SignedTxFields {
  readonly type: string;
  readonly chainId?: number | undefined;
  readonly nonce: number;
  readonly gas: bigint;
  readonly gasPrice?: bigint | undefined;
  readonly maxFeePerGas?: bigint | undefined;
  readonly maxPriorityFeePerGas?: bigint | undefined;
  readonly to: Hex | null;
  readonly value: bigint;
  readonly input: Hex;
  readonly accessList?: AccessList | undefined;
  readonly r: Hex;
  readonly s: Hex;
  readonly v?: bigint | undefined;
  readonly yParity?: number | undefined;
}

/** The raw signed bytes of a legacy, EIP-2930 or EIP-1559 call, or null (other types, missing fields). */
export function serializeSignedTx(tx: SignedTxFields): Hex | null {
  if (!tx.to) return null;
  const base = { nonce: tx.nonce, gas: tx.gas, to: tx.to, value: tx.value, data: tx.input };
  try {
    switch (tx.type) {
      case 'eip1559':
        if (tx.chainId === undefined || tx.yParity === undefined || tx.maxFeePerGas === undefined || tx.maxPriorityFeePerGas === undefined) return null;
        return serializeTransaction(
          { ...base, type: 'eip1559', chainId: tx.chainId, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList ?? [] },
          { r: tx.r, s: tx.s, yParity: tx.yParity },
        );
      case 'eip2930':
        if (tx.chainId === undefined || tx.yParity === undefined || tx.gasPrice === undefined) return null;
        return serializeTransaction({ ...base, type: 'eip2930', chainId: tx.chainId, gasPrice: tx.gasPrice, accessList: tx.accessList ?? [] }, { r: tx.r, s: tx.s, yParity: tx.yParity });
      case 'legacy':
        if (tx.gasPrice === undefined || tx.v === undefined) return null;
        return serializeTransaction({ ...base, type: 'legacy', gasPrice: tx.gasPrice, ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }) }, { r: tx.r, s: tx.s, v: tx.v });
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Loosen ids of this facility's reserve-withdrawal exceptions that no live payment row of the deployment covers. */
async function candidates(d: JobDeps, facilityId: string): Promise<Hex[]> {
  const found = await rows<{ loosen_id: string }>(
    poolOf(d.db),
    `select distinct lower(e.loosen_id) as loosen_id from exceptions e
      where e.facility_id = $1 and e.kind = 'WITHDRAW_RESERVE' and e.loosen_id is not null and e.status in ('QUEUED', 'EXECUTABLE', 'EXECUTED')
        and not exists (select 1 from payments p join facilities f on f.facility_id = p.facility_id
                         where f.deployment_id = $2 and p.kind = 'WITHDRAW_RESERVE' and p.intent_id = lower(e.loosen_id)
                           and p.state not in ('POLICY_DENIED', 'REVERTED', 'CANCELLED'))`,
    [facilityId, d.deployment.deploymentId],
  );
  return found.map((r) => r.loosen_id).filter((id): id is Hex => HEX32_RE.test(id));
}

export interface RebuiltTx {
  readonly raw: Hex;
  readonly from: Hex;
  readonly nonce: number;
}

/** The executing tx's own signed bytes, rebuilt from the chain and checked against its hash; a string says why not. */
export async function rebuiltTx(d: JobDeps, hash: Hex): Promise<RebuiltTx | string> {
  const tx = await d.client.getTransaction({ hash });
  const raw = serializeSignedTx(tx as SignedTxFields);
  if (!raw || !same(keccak256(raw), hash)) return 'the executing tx could not be rebuilt byte for byte';
  if (tx.chainId !== undefined && tx.chainId !== d.deployment.chainId) return 'the executing tx is for another chain';
  return { raw, from: tx.from.toLowerCase() as Hex, nonce: tx.nonce };
}

/** A Treasury read at a historical block; `fallback` where the Treasury had no code yet (before its deploy tx). */
export async function treasuryReadOr<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionZeroDataError)) return fallback;
    throw error;
  }
}

/**
 * The first block where the monotone `holds` (false, then true for good) is true, given it holds at `hi`: a binary
 * search from the manifest's blockNumber (the head before the deploy txs, where nothing holds yet). Needs historical
 * state (archive reads); RPC errors propagate.
 */
export async function firstBlockWhere(d: JobDeps, hi: bigint, holds: (blockNumber: bigint) => Promise<boolean>): Promise<bigint> {
  let lo = BigInt(d.deployment.blockNumber) > 0n ? BigInt(d.deployment.blockNumber) - 1n : 0n;
  let top = hi;
  while (top - lo > 1n) {
    const mid = (lo + top) / 2n;
    if (await holds(mid)) top = mid;
    else lo = mid;
  }
  return top;
}

/** Records one executed withdrawal; null when done or nothing to do, else why it could not be recorded. */
async function adoptOne(d: JobDeps, facilityId: string, loosenId: Hex, head: FinalizedHead): Promise<string | null> {
  const treasury = d.deployment.contracts.Treasury.address;
  const loosenAt = (blockNumber: bigint) => d.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'queuedLoosen', args: [loosenId], blockNumber });
  const ql = await loosenAt(head.number);
  if (Number(ql.status) !== HOGEE_KINDS.LOOSEN_STATUS_EXECUTED || Number(ql.kind) !== HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE) return null;
  // EXECUTED is for good once reached: the block it first reads so holds the execution and its ReserveWithdrawn.
  const block = await firstBlockWhere(d, head.number, async (n) => treasuryReadOr(async () => Number((await loosenAt(n)).status) === HOGEE_KINDS.LOOSEN_STATUS_EXECUTED, false));
  const [log] = await d.client.getLogs({ address: treasury, event: RESERVE_WITHDRAWN, args: { settlementId: loosenId }, fromBlock: block, toBlock: block });
  if (!log || log.args.taxPayeeId === undefined || log.args.amountMinor === undefined) return 'the loosen executed but its block has no ReserveWithdrawn';
  const payeeId = shortIdOfBytes32(log.args.taxPayeeId);
  if (payeeId === null) return 'the tax payee id is not a ShortId';
  const pool = poolOf(d.db);
  const [payee] = await rows<{ x: number }>(pool, 'select 1 as x from payees where facility_id = $1 and id = $2', [facilityId, payeeId]);
  if (!payee) return `no payee row for the tax payee ${payeeId}`;
  const tx = await rebuiltTx(d, log.transactionHash);
  if (typeof tx === 'string') return tx;
  const planVersion = await d.client.readContract({ address: d.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: 'planVersion', blockNumber: log.blockNumber });
  const id = reserveRowId(loosenId);
  const txHash = log.transactionHash.toLowerCase();
  const inserted = await pool.query(
    `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state,
       signer_address, chain_id, raw_signed_tx, nonce, tx_hash, block, settlement_id, trace_id)
     values ($1, $2, 'WITHDRAW_RESERVE', $3, null, null, $4, $5, $6, $7, 'FINALIZED', $8, $9, $10, $11, $12, $13, $3, $14)
     on conflict do nothing`,
    [id, facilityId, loosenId, payeeId, log.args.amountMinor.toString(), ZERO32, Number(planVersion), tx.from, d.deployment.chainId, tx.raw, String(tx.nonce), txHash, String(log.blockNumber), traceIdOf(id)],
  );
  if (inserted.rowCount !== 1) return 'a conflicting payment row blocks recording the withdrawal';
  d.log.info('reserve_withdrawal_adopted', { facilityId, paymentId: id });
  await appendTrace(pool, {
    facilityId,
    traceId: traceIdOf(id),
    actor: 'oracle',
    kind: 'TX',
    summary: `reserve withdrawal executed on-chain (finalized ReserveWithdrawn ${loosenId}): settling ${log.args.amountMinor} to ${payeeId}`,
    refs: { paymentId: id, txHash },
  }).catch((error: unknown) => d.log.warn('trace_append_failed', { paymentId: id, error }));
  return null;
}

/** Adopts every executed, uncovered reserve withdrawal of the facility. Never throws; failures come back as outcomes. */
export async function adoptReserveWithdrawals(d: JobDeps, facilityId: string): Promise<AdoptOutcome[]> {
  const out: AdoptOutcome[] = [];
  let ids: Hex[];
  try {
    ids = await candidates(d, facilityId);
  } catch (error: unknown) {
    d.log.error('reserve_adopt_failed', { facilityId, error });
    return [{ paymentId: 'reserve:-', step: 'error', detail: shortErrorReason(error) }];
  }
  if (ids.length === 0) return out;
  let head: FinalizedHead;
  try {
    head = await finalizedHead(d.client);
  } catch (error: unknown) {
    d.log.error('reserve_adopt_failed', { facilityId, error });
    return [{ paymentId: 'reserve:-', step: 'error', detail: shortErrorReason(error) }];
  }
  for (const loosenId of ids) {
    try {
      const why = await adoptOne(d, facilityId, loosenId, head);
      if (why) out.push({ paymentId: reserveRowId(loosenId), step: 'error', detail: why });
    } catch (error: unknown) {
      d.log.error('reserve_adopt_failed', { facilityId, loosenId, error });
      out.push({ paymentId: reserveRowId(loosenId), step: 'error', detail: shortErrorReason(error) });
    }
  }
  return out;
}
