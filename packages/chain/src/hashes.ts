/**
 * Commitments and derived ids, byte-identical to HogeeTypes.sol (abi.encode, not JCS).
 * JCS object hashes (planHash, countryPackHash) live in packages/core, not here.
 */
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { toBytes32Tag } from './eip712';
import { HOGEE_KINDS } from './kinds';

/** On-chain Line struct (IHogee.sol). Amounts are minor units (1 BU = 100 minor). */
export interface OnchainLine {
  lineId: Hex;
  amountMinor: bigint;
  perTxCapMinor: bigint;
  windowCapMinor: bigint;
  windowSeconds: number;
  validUntil: bigint;
  /** 0n = invoice-backed line; >0n = no-invoice pacing line (invoiceHash = per-line sequence number). */
  pacingMinor: bigint;
  escrowOnly: boolean;
  payeeIds: readonly Hex[];
}

/** On-chain Stage struct (IHogee.sol). metric: HOGEE_KINDS.METRIC_*. */
export interface OnchainStage {
  stageId: Hex;
  releaseMinor: bigint;
  metric: number;
  target: bigint;
  deadline: bigint;
}

export const lineAbiComponents = [
  { name: 'lineId', type: 'bytes32' },
  { name: 'amountMinor', type: 'uint128' },
  { name: 'perTxCapMinor', type: 'uint128' },
  { name: 'windowCapMinor', type: 'uint128' },
  { name: 'windowSeconds', type: 'uint32' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'pacingMinor', type: 'uint128' },
  { name: 'escrowOnly', type: 'bool' },
  { name: 'payeeIds', type: 'bytes32[]' },
] as const;

export const stageAbiComponents = [
  { name: 'stageId', type: 'bytes32' },
  { name: 'releaseMinor', type: 'uint128' },
  { name: 'metric', type: 'uint8' },
  { name: 'target', type: 'uint128' },
  { name: 'deadline', type: 'uint64' },
] as const;

/** PlanApproval.linesHash = keccak256(abi.encode(Line[])). Order matters: same order as commitPlan calldata. */
export function hashLines(lines: readonly OnchainLine[]): Hex {
  return keccak256(encodeAbiParameters([{ type: 'tuple[]', components: lineAbiComponents }], [lines]));
}

/** PlanApproval.stagesHash = keccak256(abi.encode(Stage[])). Stage index 0 is released at commitPlan. */
export function hashStages(stages: readonly OnchainStage[]): Hex {
  return keccak256(encodeAbiParameters([{ type: 'tuple[]', components: stageAbiComponents }], [stages]));
}

/** SupplierApproval.scheduleHash = keccak256(abi.encode(uint128[] schedule, bool[] autoRelease)). */
export function scheduleHash(schedule: readonly bigint[], autoRelease: readonly boolean[]): Hex {
  if (schedule.length !== autoRelease.length) {
    throw new Error(`schedule (${schedule.length}) and autoRelease (${autoRelease.length}) lengths differ`);
  }
  return keccak256(encodeAbiParameters([{ type: 'uint128[]' }, { type: 'bool[]' }], [schedule, autoRelease]));
}

export interface IntentParams {
  planId: Hex;
  lineId: Hex;
  payeeId: Hex;
  invoiceHash: Hex;
  amountMinor: bigint;
}

/** §8.4 intentId = keccak256(abi.encode(planId, lineId, payeeId, invoiceHash, uint128 amount)); also spendId. */
export function intentId({ planId, lineId, payeeId, invoiceHash, amountMinor }: IntentParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint128' }],
      [planId, lineId, payeeId, invoiceHash, amountMinor],
    ),
  );
}

/** §9.1 settlementId of a milestone release = keccak256(abi.encode(bytes32 orderId, uint8 idx)). */
export function milestoneSettlementId(orderId: Hex, idx: number): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint8' }], [orderId, idx]));
}

/** invoiceHash for a pacing line: the per-line sequence number as bytes32 (ITreasury.lineSequence). */
export function sequenceInvoiceHash(sequence: bigint): Hex {
  return encodeAbiParameters([{ type: 'uint256' }], [sequence]);
}

// ---- PlanManifest -> commitPlan calldata (G0-REVIEW M15) ----
// Minimal local shape of core's PlanManifest lines/stages (no zod import). Money and times are digit strings;
// ids are ShortIds encoded with stringToHex(id, { size: 32 }), like lineId.

export interface ManifestLineInput {
  readonly lineKey: string;
  readonly lineId: string;
  readonly amountMinor: string;
  readonly perTxCapMinor: string;
  readonly windowCapMinor: string;
  readonly windowSeconds: string;
  readonly validUntil: string;
  readonly payeeIds: readonly string[];
  readonly escrowOnly: boolean;
  /** Absent for invoice lines (pacingMinor 0). */
  readonly pacing?: { readonly period: 'day'; readonly amountMinor: string };
}

export interface ManifestStageInput {
  readonly stageId: string;
  readonly releaseMinor: string;
  /** null for stage index 0 (released at commitPlan, METRIC_NONE). */
  readonly gate: { readonly metric: 'salesMinor' | 'orders'; readonly target: string; readonly deadline: string } | null;
}

export interface ManifestInput {
  readonly lines: readonly ManifestLineInput[];
  readonly stages: readonly ManifestStageInput[];
}

const DIGITS_RE = /^(0|[1-9][0-9]*)$/;
const SHORT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const UINT32_MAX = 2n ** 32n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

function uint(value: string, max: bigint, path: string): bigint {
  if (!DIGITS_RE.test(value)) throw new Error(`${path} must be a digit string, got ${JSON.stringify(value)}`);
  const n = BigInt(value);
  if (n > max) throw new Error(`${path} is out of range`);
  return n;
}

function shortId(value: string, path: string): Hex {
  if (!SHORT_ID_RE.test(value)) throw new Error(`${path} must be a ShortId [a-z0-9_-]{1,32}, got ${JSON.stringify(value)}`);
  return toBytes32Tag(value);
}

const METRIC = { salesMinor: HOGEE_KINDS.METRIC_SALES_MINOR, orders: HOGEE_KINDS.METRIC_ORDERS } as const;

/** Maps manifest lines (array order kept) to the ABI Line[] passed to commitPlan and hashed into linesHash. */
export function manifestToLines(manifest: Pick<ManifestInput, 'lines'>): OnchainLine[] {
  return manifest.lines.map((line, i) => {
    const path = `lines[${i}]`;
    const lineId = toBytes32Tag(line.lineKey);
    if (line.lineId.toLowerCase() !== lineId) throw new Error(`${path}.lineId must equal stringToHex(lineKey, {size: 32})`);
    return {
      lineId,
      amountMinor: uint(line.amountMinor, UINT128_MAX, `${path}.amountMinor`),
      perTxCapMinor: uint(line.perTxCapMinor, UINT128_MAX, `${path}.perTxCapMinor`),
      windowCapMinor: uint(line.windowCapMinor, UINT128_MAX, `${path}.windowCapMinor`),
      windowSeconds: Number(uint(line.windowSeconds, UINT32_MAX, `${path}.windowSeconds`)),
      validUntil: uint(line.validUntil, UINT64_MAX, `${path}.validUntil`),
      pacingMinor: line.pacing ? uint(line.pacing.amountMinor, UINT128_MAX, `${path}.pacing.amountMinor`) : 0n,
      escrowOnly: line.escrowOnly,
      payeeIds: line.payeeIds.map((id, j) => shortId(id, `${path}.payeeIds[${j}]`)),
    };
  });
}

/** Maps manifest stages (array order kept; index 0 released at commitPlan) to the ABI Stage[]. */
export function manifestToStages(manifest: Pick<ManifestInput, 'stages'>): OnchainStage[] {
  return manifest.stages.map((stage, i) => {
    const path = `stages[${i}]`;
    const base = {
      stageId: shortId(stage.stageId, `${path}.stageId`),
      releaseMinor: uint(stage.releaseMinor, UINT128_MAX, `${path}.releaseMinor`),
    };
    if (stage.gate === null) return { ...base, metric: HOGEE_KINDS.METRIC_NONE, target: 0n, deadline: 0n };
    const metric = METRIC[stage.gate.metric];
    if (metric === undefined) throw new Error(`${path}.gate.metric is unknown`);
    return {
      ...base,
      metric,
      target: uint(stage.gate.target, UINT128_MAX, `${path}.gate.target`),
      deadline: uint(stage.gate.deadline, UINT64_MAX, `${path}.gate.deadline`),
    };
  });
}
