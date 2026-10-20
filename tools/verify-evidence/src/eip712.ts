/**
 * Hogee EIP-712 (project.md §8.7), re-derived here on purpose: the verifier never takes types from the bundle. The
 * struct layouts and typehashes are byte-identical to contracts/src/interfaces/HogeeTypes.sol (test/eip712.test.ts
 * pins the typehashes; packages/api's evidence tests compare them with @hogee/chain's).
 *
 * Custom domain, no chainId: EIP712Domain(string name,string version,address verifyingContract,bytes32 salt),
 * salt = keccak256(abi.encode(bytes32 chainTag, bytes32 deploymentId)).
 */
import { encodeAbiParameters, hashTypedData, keccak256, type Hex } from "viem";
import type { SignatureKind, TypedData } from "@hogee/core";
import { tagToBytes32 } from "./util";

type Field = { readonly name: string; readonly type: string };

export const HOGEE_TYPES: { readonly [K in SignatureKind]: readonly Field[] } = {
  PlanApproval: [
    { name: "planId", type: "bytes32" },
    { name: "version", type: "uint32" },
    { name: "prevPlanHash", type: "bytes32" },
    { name: "planHash", type: "bytes32" },
    { name: "countryPackHash", type: "bytes32" },
    { name: "linesHash", type: "bytes32" },
    { name: "stagesHash", type: "bytes32" },
    { name: "totalMinor", type: "uint128" },
    { name: "reserveBps", type: "uint16" },
    { name: "agent", type: "address" },
    { name: "agentExpiry", type: "uint64" },
    { name: "deploymentId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  SupplierApproval: [
    { name: "orderId", type: "bytes32" },
    { name: "supplierId", type: "bytes32" },
    { name: "payee", type: "bytes32" },
    { name: "payoutAccountHash", type: "bytes32" },
    { name: "lineId", type: "bytes32" },
    { name: "scheduleHash", type: "bytes32" },
    { name: "totalMinor", type: "uint128" },
    { name: "quoteHash", type: "bytes32" },
    { name: "shortlistHash", type: "bytes32" },
    { name: "chosenIndex", type: "uint8" },
    { name: "inspectionRequired", type: "bool" },
    { name: "deploymentId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  MilestoneRelease: [
    { name: "orderId", type: "bytes32" },
    { name: "idx", type: "uint8" },
    { name: "amountMinor", type: "uint128" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "deploymentId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  LoosenRequest: [
    { name: "kind", type: "uint8" },
    { name: "target", type: "bytes32" },
    { name: "aux", type: "bytes32" },
    { name: "newValue", type: "uint256" },
    { name: "deploymentId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  StageRelease: [
    { name: "stageId", type: "bytes32" },
    { name: "amountMinor", type: "uint128" },
    { name: "deploymentId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
  OwnerSpend: [
    { name: "lineId", type: "bytes32" },
    { name: "payeeId", type: "bytes32" },
    { name: "amountMinor", type: "uint128" },
    { name: "invoiceHash", type: "bytes32" },
    { name: "deploymentId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
};

/** keccak256 of each canonical type string, equal to the TYPEHASH constants of HogeeTypes.sol. */
export const HOGEE_TYPEHASHES: { readonly [K in SignatureKind | "EIP712Domain"]: Hex } = {
  EIP712Domain: "0x36c25de3e541d5d970f66e4210d728721220fff5c077cc6cd008b3a0c62adab7",
  PlanApproval: "0x79ade738b7faa5735e274b970b60b74a78381de71ba14db277e9699ab0fff10f",
  SupplierApproval: "0x4c20466f0a224da371247d079d44046edeb43aa6df2125a4a5ef470da19fe1d2",
  MilestoneRelease: "0x99561ec6c6f3333ade59c63a6dd74240f30a7ccf0ad591d8e38cbbccfb7cfb7c",
  LoosenRequest: "0x7c436c388e9be5950fd1e73eed20ba2be4044dc24a788bf108ccc8c0625a5cf9",
  StageRelease: "0xa47efdc649d9de812e1ec466521dba27f2f1eedfda6cae0a592e75c0f721e6e0",
  OwnerSpend: "0x915bed73783b116efd78330916948448ba772637dbeeff68be1e007c38b43962",
};

/** The contract whose address is each struct's verifyingContract. */
export const VERIFYING_CONTRACT = {
  PlanApproval: "PlanRegistry",
  SupplierApproval: "Treasury",
  MilestoneRelease: "MilestoneEscrow",
  LoosenRequest: "Treasury",
  StageRelease: "Treasury",
  OwnerSpend: "Treasury",
} as const satisfies { readonly [K in SignatureKind]: string };

export const typeString = (kind: SignatureKind): string => `${kind}(${HOGEE_TYPES[kind].map((f) => `${f.type} ${f.name}`).join(",")})`;

export function domainSalt(chainTag: string, deploymentId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [tagToBytes32(chainTag), tagToBytes32(deploymentId)]));
}

/** JSON message (uints as decimal strings, bytes/addresses as lowercase hex) → viem values, strictly field by field. */
export function viemMessage(kind: SignatureKind, m: Readonly<Record<string, string | boolean>>): Record<string, unknown> | string {
  const fields = HOGEE_TYPES[kind];
  if (Object.keys(m).length !== fields.length) return "the message has missing or extra fields";
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = m[f.name];
    if (f.type === "bool") {
      if (typeof v !== "boolean") return `${f.name} is not a boolean`;
      out[f.name] = v;
    } else if (f.type.startsWith("uint")) {
      if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v)) return `${f.name} is not a decimal string`;
      const n = BigInt(v);
      if (n >= 1n << BigInt(Number(f.type.slice(4)))) return `${f.name} overflows ${f.type}`;
      out[f.name] = Number(f.type.slice(4)) <= 32 ? Number(v) : n;
    } else {
      const len = f.type === "address" ? 40 : 64;
      if (typeof v !== "string" || !new RegExp(`^0x[0-9a-f]{${len}}$`).test(v)) return `${f.name} is not lowercase ${f.type}`;
      out[f.name] = v;
    }
  }
  return out;
}

/** The types in the bundle must be exactly the canonical ones (a swapped field order changes what was signed). */
export function typesAreCanonical(td: TypedData): boolean {
  const kind = td.primaryType;
  const entries = Object.entries(td.types);
  if (entries.length !== 1 || entries[0]?.[0] !== kind) return false;
  const fields = entries[0][1];
  const want = HOGEE_TYPES[kind];
  return fields.length === want.length && fields.every((f, i) => f.name === want[i]?.name && f.type === want[i]?.type);
}

/** EIP-712 digest of a bundle's typed data with the canonical types; a string when the message is malformed. */
export function digestOf(td: TypedData): Hex | string {
  const message = viemMessage(td.primaryType, td.message);
  if (typeof message === "string") return message;
  return hashTypedData({
    domain: { name: td.domain.name, version: td.domain.version, verifyingContract: td.domain.verifyingContract as Hex, salt: td.domain.salt as Hex },
    types: { [td.primaryType]: HOGEE_TYPES[td.primaryType].map((f) => ({ ...f })) },
    primaryType: td.primaryType,
    message,
  } as Parameters<typeof hashTypedData>[0]);
}
