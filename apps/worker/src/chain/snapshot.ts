/**
 * The on-chain state the worker mirrors (Treasury + PlanRegistry views, §26.9), all read at ONE block so the policy
 * context is consistent. mirror.ts reads it; context.ts turns it into core's PolicyContext.
 */
import type { Address, Hex } from 'viem';

export interface PocketView {
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
}

export interface BindingView {
  readonly payeeId: Hex;
  readonly bound: boolean;
  readonly coolingUntil: bigint;
  /** type(uint128).max when uncapped (static platform payees). */
  readonly lifetimeCapMinor: bigint;
  readonly paidMinor: bigint;
  readonly payoutAccountHash: Hex;
}

export interface LineView {
  readonly lineId: Hex;
  readonly pocket: PocketView;
  /** Treasury.lineSequence: next pacing slot (starts at 1), 0 for invoice lines. */
  readonly sequence: bigint;
  /** PlanRegistry.line(lineId).payeeIds: payees the current plan version lists on this line. */
  readonly payeeIds: readonly Hex[];
  /** Treasury.payeeBinding(lineId, payeeId) for each listed payee. */
  readonly bindings: readonly BindingView[];
}

export interface ChainSnapshot {
  readonly blockNumber: bigint;
  /** Block timestamp (unix seconds): the policy clock, so Anvil time warps move it. */
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
    readonly committedAt: bigint;
  };
  readonly paused: boolean;
  /** Treasury.agentExpiry (extended by a loosen; the plan value otherwise). */
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
  /**
   * Deployment roles as the contracts hold them: founderKey().ownerEOA (zero = passkey only), lender, oracle, and
   * Treasury.observer() (zero = none; always zero on the loop-1 shape, whose Treasury has no observer).
   */
  readonly roles: { readonly ownerEOA: Address; readonly lender: Address; readonly oracle: Address; readonly observer: Address };
  readonly judgingWindowEnd: bigint;
}

/** Right-padded bytes32 ShortId → string (inverse of toBytes32Tag); throws on non-ASCII or an inner zero byte. */
export function shortIdFromBytes32(value: Hex): string {
  const hex = value.slice(2).replace(/(00)+$/, '');
  if (hex.length % 2 !== 0 || hex.length === 0) throw new Error('bytes32 id is empty or malformed');
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const code = Number.parseInt(hex.slice(i, i + 2), 16);
    if (code < 0x20 || code > 0x7e) throw new Error('bytes32 id is not printable ASCII');
    out += String.fromCharCode(code);
  }
  return out;
}
