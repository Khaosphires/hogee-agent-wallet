/**
 * Typed data for POST /api/signatures/request, built with @hogee/chain (§8.7): the custom domain (salt = chainTag +
 * deploymentId), the frozen struct, a random 256-bit nonce (the contracts use unordered nonces; never a counter) and
 * an expiry in CHAIN time. JSON form (§26.5): uints as decimal strings, bytes and addresses as lowercase 0x-hex.
 */
import type { SignatureRequestResponse } from "@hogee/core";
import type { Address, Hex } from "viem";
import { hashHogeeTypedData, hogeeDomain, hogeeTypes, toBytes32Tag, type HogeeMessages, type HogeeStructName } from "../../chain-lib";
import type { ApiDeps } from "../../context";
import { contractAddress, type ContractKey } from "../../deployment";
import { randomNonce } from "../ids";

/** How long a founder has to sign a request (chain seconds). */
export const SIGNATURE_TTL_S = 900n;

export type TypedMessage = Record<string, string | boolean>;
type TypedData = SignatureRequestResponse["typedData"];

export class TypedMessageError extends Error {
  override readonly name = "TypedMessageError";
}

/** JSON message → viem message for `kind` (uint8..uint32 numbers, wider uints bigints), strictly field by field. */
export function toViemMessage<K extends HogeeStructName>(kind: K, m: TypedMessage): HogeeMessages[K] {
  const fields = hogeeTypes[kind];
  if (Object.keys(m).length !== fields.length) throw new TypedMessageError("typed message has missing or extra fields");
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = m[f.name];
    if (f.type === "bool") {
      if (typeof v !== "boolean") throw new TypedMessageError(`${f.name} must be a boolean`);
      out[f.name] = v;
    } else if (f.type.startsWith("uint")) {
      if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) throw new TypedMessageError(`${f.name} must be a decimal string`);
      out[f.name] = Number(f.type.slice(4)) <= 32 ? Number(v) : BigInt(v);
    } else {
      if (typeof v !== "string" || !/^0x([0-9a-f]{2})+$/.test(v)) throw new TypedMessageError(`${f.name} must be lowercase hex`);
      out[f.name] = v;
    }
  }
  return out as unknown as HogeeMessages[K];
}

export function domainFor(deps: Pick<ApiDeps, "deployment">, contract: ContractKey) {
  return hogeeDomain({
    verifyingContract: contractAddress(deps.deployment, contract),
    chainTag: toBytes32Tag(deps.deployment.chainTag),
    deploymentId: toBytes32Tag(deps.deployment.deploymentId),
  });
}

export interface BuiltTyped {
  readonly typedData: TypedData;
  readonly digest: Hex;
  readonly challengeB64url: string;
  readonly nonce: bigint;
  readonly expiry: bigint;
}

/** The full struct: `fields` plus deploymentId, a fresh random nonce and expiry = chain now + TTL. */
export function buildTyped(deps: Pick<ApiDeps, "deployment">, kind: HogeeStructName, contract: ContractKey, fields: TypedMessage, chainNow: bigint): BuiltTyped {
  const nonce = randomNonce();
  const expiry = chainNow + SIGNATURE_TTL_S;
  const message: TypedMessage = { ...fields, deploymentId: toBytes32Tag(deps.deployment.deploymentId), nonce: nonce.toString(), expiry: expiry.toString() };
  const domain = domainFor(deps, contract);
  const digest = hashHogeeTypedData(kind, domain, toViemMessage(kind, message));
  const typedData: TypedData = {
    domain: { name: domain.name as "Hogee", version: domain.version as "1", verifyingContract: domain.verifyingContract.toLowerCase() as Address, salt: domain.salt },
    types: { [kind]: hogeeTypes[kind].map((f) => ({ name: f.name, type: f.type })) },
    primaryType: kind,
    message,
  };
  return { typedData, digest, challengeB64url: Buffer.from(digest.slice(2), "hex").toString("base64url"), nonce, expiry };
}

/** Recompute the digest of a stored request (a tampered row never verifies). */
export function digestOf(deps: Pick<ApiDeps, "deployment">, kind: HogeeStructName, contract: ContractKey, message: TypedMessage): Hex {
  return hashHogeeTypedData(kind, domainFor(deps, contract), toViemMessage(kind, message));
}

export const hex32 = (x: string): Hex => x.toLowerCase() as Hex;
