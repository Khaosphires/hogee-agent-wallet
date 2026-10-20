/**
 * EIP-1559 fee rules for the worker (§12.3): fees come from `estimateFeesPerGas`, capped by MAX_FEE_GWEI;
 * a fee bump re-signs the SAME nonce with BOTH fees raised by at least 10 % (the geth/reth replacement rule),
 * still capped. Pure functions, unit-tested without a network.
 */
import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem';

export interface Eip1559Fees {
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** Minimum raise of both fees for a same-nonce replacement to be accepted by the mempool. */
export const MIN_FEE_BUMP_PERCENT = 10n;

/** EIP-7825 per-transaction gas cap (Fusaka); §12.3 forced reverts must stay at or below it. */
export const MAX_TX_GAS = 16_777_216n;

const WEI_PER_GWEI = 1_000_000_000n;

export class FeeCapExceededError extends Error {
  override readonly name = 'FeeCapExceededError';
  constructor(
    message: string,
    readonly neededWei: bigint,
    readonly capWei: bigint,
  ) {
    super(message);
  }
}

export class GasLimitError extends Error {
  override readonly name = 'GasLimitError';
}

/** MAX_FEE_GWEI (number or digit string, may be fractional like "2.5") → wei. */
export function gweiToWei(gwei: number | string | bigint): bigint {
  if (typeof gwei === 'bigint') {
    if (gwei <= 0n) throw new RangeError('MAX_FEE_GWEI must be positive');
    return gwei * WEI_PER_GWEI;
  }
  const text = String(gwei).trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,9}))?$/.exec(text);
  if (!match) throw new RangeError('MAX_FEE_GWEI must be a positive decimal number');
  const whole = BigInt(match[1] ?? '0');
  const frac = BigInt((match[2] ?? '').padEnd(9, '0'));
  const wei = whole * WEI_PER_GWEI + frac;
  if (wei <= 0n) throw new RangeError('MAX_FEE_GWEI must be positive');
  return wei;
}

function checkFees(fees: Eip1559Fees, field: string): void {
  if (fees.maxFeePerGas <= 0n || fees.maxPriorityFeePerGas < 0n) throw new RangeError(`${field}: fees must be positive`);
  if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) throw new RangeError(`${field}: priority fee exceeds max fee`);
}

/**
 * Applies the MAX_FEE_GWEI cap to an estimate. Throws {@link FeeCapExceededError} (nothing is signed, no
 * nonce is used) when the estimate is above the cap, so the loop can skip the tick (§18.3).
 */
export function capFees(estimate: Eip1559Fees, capWei: bigint): Eip1559Fees {
  checkFees(estimate, 'estimate');
  if (capWei <= 0n) throw new RangeError('fee cap must be positive');
  if (estimate.maxFeePerGas > capWei) {
    throw new FeeCapExceededError('estimated maxFeePerGas is above MAX_FEE_GWEI', estimate.maxFeePerGas, capWei);
  }
  return { maxFeePerGas: estimate.maxFeePerGas, maxPriorityFeePerGas: estimate.maxPriorityFeePerGas };
}

/** ceil(value * (100 + percent) / 100), and always at least value + 1. */
export function raiseByPercent(value: bigint, percent: bigint = MIN_FEE_BUMP_PERCENT): bigint {
  if (value < 0n || percent < 0n) throw new RangeError('value and percent must be non-negative');
  const raised = (value * (100n + percent) + 99n) / 100n;
  return raised > value ? raised : value + 1n;
}

const max = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * Fees for a same-nonce replacement: each fee is max(previous + 10 %, current estimate), capped at
 * `capWei`. Throws {@link FeeCapExceededError} when the cap leaves less than the 10 % minimum on either fee.
 */
export function bumpFees(previous: Eip1559Fees, capWei: bigint, current?: Eip1559Fees): Eip1559Fees {
  checkFees(previous, 'previous');
  const minFee = raiseByPercent(previous.maxFeePerGas);
  const minTip = raiseByPercent(previous.maxPriorityFeePerGas);
  if (minFee > capWei) {
    throw new FeeCapExceededError('a 10% fee bump would exceed MAX_FEE_GWEI', minFee, capWei);
  }
  const wantFee = current ? max(minFee, current.maxFeePerGas) : minFee;
  const wantTip = current ? max(minTip, current.maxPriorityFeePerGas) : minTip;
  const maxFeePerGas = wantFee > capWei ? capWei : wantFee;
  const maxPriorityFeePerGas = wantTip > maxFeePerGas ? maxFeePerGas : wantTip;
  if (maxPriorityFeePerGas < minTip) {
    throw new FeeCapExceededError('a 10% priority-fee bump would exceed MAX_FEE_GWEI', minTip, capWei);
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

/** Throws unless `0 < gas <= 16,777,216` (EIP-7825). */
export function assertGasLimit(gas: bigint): bigint {
  if (typeof gas !== 'bigint' || gas <= 0n) throw new GasLimitError('gas must be a positive bigint');
  if (gas > MAX_TX_GAS) throw new GasLimitError(`gas ${gas} is above the per-tx cap ${MAX_TX_GAS}`);
  return gas;
}

/** What signs a transaction: a viem LocalAccount (privateKeyToAccount) satisfies this. */
export interface TxSigner {
  readonly address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}
