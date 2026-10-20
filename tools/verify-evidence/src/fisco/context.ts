/**
 * What every FISCO check shares: the parsed pack, the pinned source identity, the source bundle (parsed once), the
 * mirror view (./view.ts) and small helpers to rebuild a signed struct's EIP-712 digest from calldata.
 */
import { decodeAbiParameters, type Hex } from "viem";
import type { PasskeyAssertion, SignatureKind, TypedData } from "@hogee/core";
import { webAuthnAuthParams } from "../abi";
import type { ParsedBundle } from "../bundle";
import { digestOf, domainSalt, HOGEE_TYPES } from "../eip712";
import { sameHex, tagToBytes32 } from "../util";
import type { CatalogueEntry } from "./catalogue";
import { DEPLOYED, FISCO_CHAIN_TAG, type DeployedName, type ParsedPack, type SourceIdentity, type Step, type TxFile } from "./pack";
import type { ParsedTx } from "../crypto";
import type { DecodedCall } from "../calls";

export interface MirrorEvent {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly address: string;
  readonly seq: number;
  readonly stepId: string;
}

export interface MirrorTx {
  readonly hash: string;
  readonly file: TxFile | null;
  readonly parsed: ParsedTx | null;
  readonly call: DecodedCall | null;
  readonly blockNumber: bigint | null;
  readonly blockTime: bigint | null;
  readonly events: readonly MirrorEvent[];
}

export interface MirrorStep {
  readonly step: Step;
  readonly entry: CatalogueEntry | null;
  readonly tx: MirrorTx | null;
}

export interface MirrorView {
  readonly steps: readonly MirrorStep[];
  readonly byId: ReadonlyMap<string, MirrorStep>;
  readonly deploys: ReadonlyMap<DeployedName, MirrorTx>;
  /** Decoded events of every mined step, in step order. */
  readonly events: readonly MirrorEvent[];
}

export interface SourceBundle {
  /** null when the source bundle's files do not even parse. */
  readonly parsed: ParsedBundle | null;
  /** verifyBundle(...).ok */
  readonly verified: boolean;
  readonly files: Readonly<Record<string, string | Uint8Array>>;
}

export interface Ctx {
  /** The pack's files as given (exact bytes, for keccak comparisons). */
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  readonly pack: ParsedPack;
  readonly source: SourceIdentity;
  readonly bundle: SourceBundle | null;
  readonly view: MirrorView;
}

export const ZERO32 = `0x${"0".repeat(64)}`;
type HasPack = { readonly pack: ParsedPack };
export const fiscoAddress = (ctx: HasPack, name: DeployedName | "TreasuryGovernance"): string => ctx.pack.deployment.contracts[name].address;
export const isDeploymentAddress = (ctx: HasPack, address: string): boolean =>
  [...DEPLOYED, "TreasuryGovernance" as const].some((n) => sameHex(fiscoAddress(ctx, n), address));

/** A uint/bytes/address/bool calldata value as the JSON typed-data message holds it. */
const jsonValue = (v: unknown): string | boolean => (typeof v === "boolean" ? v : typeof v === "string" ? v.toLowerCase() : String(v));

/** The typed-data message of a decoded struct, field by field in canonical order. */
export function messageOf(kind: SignatureKind, struct: unknown): Record<string, string | boolean> {
  const s = struct as Readonly<Record<string, unknown>>;
  return Object.fromEntries(HOGEE_TYPES[kind].map((f) => [f.name, jsonValue(s[f.name])]));
}

/** Hogee typed data for `message` on a domain (chain tag + deployment id → salt) and verifying contract. */
export function typedDataOf(kind: SignatureKind, message: Record<string, string | boolean>, verifyingContract: string, chainTag: string, deploymentId: string): TypedData {
  return {
    domain: { name: "Hogee", version: "1", verifyingContract: verifyingContract.toLowerCase(), salt: domainSalt(chainTag, deploymentId) },
    types: { [kind]: HOGEE_TYPES[kind].map((f) => ({ ...f })) },
    primaryType: kind,
    message,
  };
}

/** The digest a FISCO contract checks for a struct decoded from calldata; a string when the struct is malformed. */
export function fiscoDigest(ctx: Ctx, kind: SignatureKind, struct: unknown, verifying: DeployedName): Hex | string {
  return digestOf(typedDataOf(kind, messageOf(kind, struct), fiscoAddress(ctx, verifying), FISCO_CHAIN_TAG, ctx.pack.deployment.deploymentId));
}

export interface Sig {
  readonly kind: number;
  readonly data: Hex;
}

/** The PasskeyAssertion of a kind-1 Sig (credentialId is not on chain), or null when it does not decode. */
export function assertionOf(sig: Sig): PasskeyAssertion | null {
  if (sig.kind !== 1) return null;
  try {
    const [w] = decodeAbiParameters(webAuthnAuthParams, sig.data);
    return { credentialId: "AA", r: w.r.toLowerCase(), s: w.s.toLowerCase(), challengeIndex: Number(w.challengeIndex), typeIndex: Number(w.typeIndex), authenticatorData: w.authenticatorData.toLowerCase(), clientDataJSON: w.clientDataJSON };
  } catch {
    return null;
  }
}

/** The signed struct and the Sig of a founder- or lender-signed call, by function. */
export function signedPartsOf(call: DecodedCall | null): { kind: SignatureKind; struct: unknown; sig: Sig; verifying: DeployedName } | null {
  if (!call) return null;
  const a = call.args;
  switch (call.name) {
    case "commitPlan":
      return { kind: "PlanApproval", struct: a[0], sig: a[3] as Sig, verifying: "PlanRegistry" };
    case "bindPayee":
      return { kind: "SupplierApproval", struct: a[0], sig: a[3] as Sig, verifying: "Treasury" };
    case "releaseMilestone":
      return { kind: "MilestoneRelease", struct: a[0], sig: a[1] as Sig, verifying: "MilestoneEscrow" };
    case "releaseStage":
      return { kind: "StageRelease", struct: a[0], sig: a[1] as Sig, verifying: "Treasury" };
    default:
      return null;
  }
}

export const deploymentTag = (ctx: Ctx): string => tagToBytes32(ctx.pack.deployment.deploymentId);

/** JSON equality with bigints as decimals and strings lowercased (calldata vs JSON). */
export function sameJson(a: unknown, b: unknown): boolean {
  const norm = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? v.toLowerCase() : v);
  return JSON.stringify(a, norm) === JSON.stringify(b, norm);
}

/** The step a catalogue id names, when present. */
export const stepOf = (ctx: Ctx, id: string): MirrorStep | undefined => ctx.view.byId.get(id);

/** The block time window of a step: its own block, or (not mined) the mined blocks around it. */
export function timeWindow(ctx: Ctx, seq: number): { from: bigint; to: bigint } | null {
  const own = ctx.view.steps.find((s) => s.step.seq === seq);
  if (own?.tx?.blockTime !== null && own?.tx?.blockTime !== undefined) return { from: own.tx.blockTime, to: own.tx.blockTime };
  const times = ctx.view.steps.filter((s) => s.tx?.blockTime !== null && s.tx?.blockTime !== undefined);
  const before = times.filter((s) => s.step.seq < seq).at(-1)?.tx?.blockTime;
  const after = times.find((s) => s.step.seq > seq)?.tx?.blockTime;
  if (before === undefined || before === null) return null;
  return { from: before, to: after ?? (1n << 63n) };
}
