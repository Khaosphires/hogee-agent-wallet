import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertGasLimit,
  bumpFees,
  capFees,
  DEFAULT_FORCED_REVERT_GAS,
  FeeCapExceededError,
  forcedRevertRequest,
  GasLimitError,
  gweiToWei,
  MAX_TX_GAS,
  raiseByPercent,
  withBuffer,
} from '../src/index';

const GWEI = 1_000_000_000n;
const fees = (maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) => ({ maxFeePerGas, maxPriorityFeePerGas });

describe('gweiToWei (MAX_FEE_GWEI)', () => {
  it.each([
    ['50', 50n * GWEI],
    ['2.5', 2_500_000_000n],
    ['0.000000001', 1n],
    [3, 3n * GWEI],
    [7n, 7n * GWEI],
  ])('%s gwei', (input, wei) => {
    expect(gweiToWei(input)).toBe(wei);
  });

  it.each(['0', '-1', 'abc', '1e9', '0.0000000001', ''])('rejects %s', (input) => {
    expect(() => gweiToWei(input)).toThrow(RangeError);
  });
});

describe('capFees', () => {
  it('passes an estimate under the cap through unchanged', () => {
    expect(capFees(fees(30n * GWEI, 2n * GWEI), 50n * GWEI)).toEqual(fees(30n * GWEI, 2n * GWEI));
  });

  it('throws FeeCapExceededError above MAX_FEE_GWEI so the loop skips the tick', () => {
    const error = (() => {
      try {
        capFees(fees(60n * GWEI, 2n * GWEI), 50n * GWEI);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(FeeCapExceededError);
    expect((error as FeeCapExceededError).neededWei).toBe(60n * GWEI);
  });

  it('rejects an inverted estimate (tip above max fee)', () => {
    expect(() => capFees(fees(1n, 2n), 10n)).toThrow(/priority fee exceeds/);
  });
});

describe('fee bump (same nonce, both fees ≥ +10 %, capped)', () => {
  it('raises both fees by 10 %, rounding up', () => {
    expect(bumpFees(fees(100n, 10n), 1_000n)).toEqual(fees(110n, 11n));
    expect(bumpFees(fees(101n, 1n), 1_000n)).toEqual(fees(112n, 2n));
  });

  it('follows the current estimate when the market moved more than 10 %', () => {
    expect(bumpFees(fees(100n, 10n), 1_000n, fees(300n, 30n))).toEqual(fees(300n, 30n));
  });

  it('clamps to the cap when the cap still leaves the 10 % minimum', () => {
    expect(bumpFees(fees(100n, 10n), 150n, fees(400n, 40n))).toEqual(fees(150n, 40n));
  });

  it('throws when the cap leaves less than +10 % (cannot replace)', () => {
    expect(() => bumpFees(fees(100n, 10n), 109n)).toThrow(FeeCapExceededError);
    expect(() => bumpFees(fees(100n, 99n), 109n)).toThrow(FeeCapExceededError);
  });

  it('every bump is ≥ 110 % on both fees, ≤ cap, and tip ≤ max fee (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        fc.bigInt({ min: 1n, max: 10n ** 14n }),
        fc.option(fc.tuple(fc.bigInt({ min: 1n, max: 10n ** 14n }), fc.bigInt({ min: 0n, max: 10n ** 14n }))),
        (maxFee, tipRaw, cap, cur) => {
          const prev = fees(maxFee, tipRaw > maxFee ? maxFee : tipRaw);
          const current = cur ? fees(cur[0], cur[1] > cur[0] ? cur[0] : cur[1]) : undefined;
          try {
            const next = bumpFees(prev, cap, current);
            expect(next.maxFeePerGas * 100n).toBeGreaterThanOrEqual(prev.maxFeePerGas * 110n);
            expect(next.maxPriorityFeePerGas * 100n).toBeGreaterThanOrEqual(prev.maxPriorityFeePerGas * 110n);
            expect(next.maxFeePerGas).toBeLessThanOrEqual(cap);
            expect(next.maxPriorityFeePerGas).toBeLessThanOrEqual(next.maxFeePerGas);
          } catch (e) {
            expect(e).toBeInstanceOf(FeeCapExceededError);
            expect(raiseByPercent(prev.maxFeePerGas) > cap || raiseByPercent(prev.maxPriorityFeePerGas) > cap).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('raiseByPercent always strictly increases', () => {
    expect(raiseByPercent(0n)).toBe(1n);
    expect(raiseByPercent(1n)).toBe(2n);
    expect(raiseByPercent(10n)).toBe(11n);
  });
});

describe('gas limits (EIP-7825) and forced-revert requests', () => {
  const request = { to: '0x0000000000000000000000000000000000000001', data: '0x12345678' } as const;

  it('forced reverts default to an explicit 500k gas, so eth_estimateGas is never needed', () => {
    expect(DEFAULT_FORCED_REVERT_GAS).toBe(500_000n);
    expect(forcedRevertRequest(request)).toEqual({ ...request, gas: 500_000n });
    expect(forcedRevertRequest({ ...request, gas: 1n }, 750_000n).gas).toBe(750_000n);
  });

  it('accepts exactly 16,777,216 and rejects anything above or non-positive', () => {
    expect(MAX_TX_GAS).toBe(16_777_216n);
    expect(forcedRevertRequest(request, MAX_TX_GAS).gas).toBe(MAX_TX_GAS);
    expect(() => forcedRevertRequest(request, MAX_TX_GAS + 1n)).toThrow(GasLimitError);
    expect(() => assertGasLimit(0n)).toThrow(GasLimitError);
    expect(() => assertGasLimit(-5n)).toThrow(GasLimitError);
  });

  it('withBuffer adds headroom over eth_estimateGas, rounding up', () => {
    expect(withBuffer(100_000n, 20n)).toBe(120_000n);
    expect(withBuffer(21_001n, 20n)).toBe(25_202n);
    expect(() => withBuffer(0n, 20n)).toThrow(RangeError);
  });
});
