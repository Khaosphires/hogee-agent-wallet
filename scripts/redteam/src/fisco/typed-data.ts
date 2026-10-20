/**
 * Hogee typed data as the API stores it (core TypedData): viem's TypedDataDefinition with the custom domain, uints as
 * decimal strings, hex and addresses lowercase, booleans as booleans. The same JSON the source bundle's
 * signatures.json holds, so a checker hashes both the same way.
 */
import { hogeeTypes, type HogeeDomain, type HogeeMessages, type HogeeStructName } from "@hogee/chain";
import type { TypedData } from "@hogee/core";

function jsonValue(v: unknown): string | boolean {
  if (typeof v === "bigint" || typeof v === "number") return v.toString();
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase();
  throw new Error(`typed data: unsupported value ${typeof v}`);
}

export function typedDataJson<K extends HogeeStructName>(primaryType: K, domain: HogeeDomain, message: HogeeMessages[K]): TypedData {
  const fields = hogeeTypes[primaryType];
  const values = message as unknown as Record<string, unknown>;
  return {
    domain: { name: domain.name, version: domain.version, verifyingContract: domain.verifyingContract.toLowerCase(), salt: domain.salt.toLowerCase() },
    types: { [primaryType]: fields.map((f) => ({ name: f.name, type: f.type })) },
    primaryType,
    message: Object.fromEntries(fields.map((f) => [f.name, jsonValue(values[f.name])])),
  };
}
