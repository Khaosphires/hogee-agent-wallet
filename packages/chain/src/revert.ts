/**
 * Decodes Hogee custom errors (§8.5) from revert data. A receipt carries no revert data, so for a mined
 * revert we ask the node for a `callTracer` trace (Anvil, most paid RPCs) and fall back to replaying the
 * call at the parent block with `eth_call`.
 */
import { decodeErrorResult, type Abi, type Hex } from 'viem';
import type { HogeePublicClient } from './clients';
import { iMilestoneEscrowAbi, iPlanRegistryAbi, iSalesOracleAbi, iTreasuryAbi } from './generated';

/** An `error` entry of an ABI (viem does not re-export abitype's AbiError). */
export type AbiError = Extract<Abi[number], { type: 'error' }>;

function errorsOf(abi: Abi): AbiError[] {
  return abi.filter((item): item is AbiError => item.type === 'error');
}

/** Every custom error of the four Hogee contracts (IHogeeErrors), deduplicated by signature. */
export const hogeeErrorAbi: readonly AbiError[] = (() => {
  const seen = new Map<string, AbiError>();
  for (const abi of [iTreasuryAbi, iPlanRegistryAbi, iMilestoneEscrowAbi, iSalesOracleAbi] as readonly Abi[]) {
    for (const e of errorsOf(abi)) seen.set(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`, e);
  }
  return Object.freeze([...seen.values()]);
})();

export interface DecodedRevert {
  /** Custom error name, or `Error` / `Panic` for Solidity built-ins. */
  readonly name: string;
  readonly args: readonly unknown[];
  readonly data: Hex;
}

const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2}){4,}$/;

/** Decodes revert data with the Hogee error ABI (plus Error(string) / Panic(uint256)); null if unknown. */
export function decodeRevertData(data: Hex, abi: readonly AbiError[] = hogeeErrorAbi): DecodedRevert | null {
  if (!HEX_DATA_RE.test(data)) return null;
  try {
    const decoded = decodeErrorResult({ abi: abi as Abi, data });
    return { name: decoded.errorName, args: decoded.args ?? [], data };
  } catch {
    return null;
  }
}

/** Finds revert data in a viem error chain (`data` on the error or a cause, possibly nested as `data.data`). */
export function revertDataFromError(error: unknown): Hex | null {
  let current: unknown = error;
  for (let depth = 0; depth < 12 && current !== null && typeof current === 'object'; depth += 1) {
    const data = (current as { data?: unknown }).data;
    if (typeof data === 'string' && HEX_DATA_RE.test(data)) return data as Hex;
    if (data !== null && typeof data === 'object') {
      const nested = (data as { data?: unknown }).data;
      if (typeof nested === 'string' && HEX_DATA_RE.test(nested)) return nested as Hex;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export type RevertClient = Pick<HogeePublicClient, 'getTransaction' | 'getTransactionReceipt' | 'call' | 'request'>;

export interface RevertLookup {
  readonly decoded: DecodedRevert | null;
  readonly data: Hex | null;
  readonly via: 'trace' | 'call-replay' | null;
}

type RawRequest = (args: { method: string; params: readonly unknown[] }) => Promise<unknown>;

async function viaTrace(client: RevertClient, txHash: Hex): Promise<Hex | null> {
  try {
    const request = client.request as unknown as RawRequest;
    const trace = (await request({ method: 'debug_traceTransaction', params: [txHash, { tracer: 'callTracer' }] })) as {
      output?: unknown;
      error?: unknown;
    } | null;
    const output = trace?.output;
    return typeof output === 'string' && HEX_DATA_RE.test(output) ? (output as Hex) : null;
  } catch {
    return null;
  }
}

async function viaCallReplay(client: RevertClient, txHash: Hex): Promise<Hex | null> {
  try {
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash: txHash }), client.getTransactionReceipt({ hash: txHash })]);
    if (!tx.to) return null;
    await client.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      blockNumber: receipt.blockNumber > 0n ? receipt.blockNumber - 1n : 0n,
    });
    return null;
  } catch (error: unknown) {
    return revertDataFromError(error);
  }
}

/** Revert reason of a mined tx: trace first, then `eth_call` replay at the parent block. */
export async function lookupRevert(client: RevertClient, txHash: Hex): Promise<RevertLookup> {
  const traced = await viaTrace(client, txHash);
  if (traced) return { decoded: decodeRevertData(traced), data: traced, via: 'trace' };
  const replayed = await viaCallReplay(client, txHash);
  if (replayed) return { decoded: decodeRevertData(replayed), data: replayed, via: 'call-replay' };
  return { decoded: null, data: null, via: null };
}
