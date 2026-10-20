/**
 * Hogee EIP-712 (project.md §8.7). Mirrors contracts/src/interfaces/HogeeTypes.sol exactly.
 *
 * Custom domain, no chainId: EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)
 * with name "Hogee", version "1", salt = keccak256(abi.encode(bytes32 chainTag, bytes32 deploymentId)).
 * Golden digests are asserted in both test/eip712.test.ts and contracts/test/HogeeTypes.t.sol.
 *
 * MetaMask note (not tested here): eth_signTypedData_v4 only checks domain.chainId against the active chain
 * when chainId is present, so a chainId-less domain signs on any network. The salt (chainTag + deploymentId)
 * is what blocks cross-chain and cross-deployment replay. Wallet UIs may show no network for the request.
 */
import {
  domainSeparator,
  encodeAbiParameters,
  hashStruct,
  hashTypedData,
  keccak256,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from 'viem';

export const HOGEE_DOMAIN_NAME = 'Hogee';
export const HOGEE_DOMAIN_VERSION = '1';

/** The six signed structs. Only static fields, so wallets can show them flat. */
export const hogeeTypes = {
  PlanApproval: [
    { name: 'planId', type: 'bytes32' },
    { name: 'version', type: 'uint32' },
    { name: 'prevPlanHash', type: 'bytes32' },
    { name: 'planHash', type: 'bytes32' },
    { name: 'countryPackHash', type: 'bytes32' },
    { name: 'linesHash', type: 'bytes32' },
    { name: 'stagesHash', type: 'bytes32' },
    { name: 'totalMinor', type: 'uint128' },
    { name: 'reserveBps', type: 'uint16' },
    { name: 'agent', type: 'address' },
    { name: 'agentExpiry', type: 'uint64' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
  SupplierApproval: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'supplierId', type: 'bytes32' },
    { name: 'payee', type: 'bytes32' },
    { name: 'payoutAccountHash', type: 'bytes32' }, // G0-REVIEW (M7, T1)
    { name: 'lineId', type: 'bytes32' },
    { name: 'scheduleHash', type: 'bytes32' },
    { name: 'totalMinor', type: 'uint128' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'shortlistHash', type: 'bytes32' },
    { name: 'chosenIndex', type: 'uint8' },
    { name: 'inspectionRequired', type: 'bool' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
  MilestoneRelease: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'idx', type: 'uint8' },
    { name: 'amountMinor', type: 'uint128' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
  LoosenRequest: [
    { name: 'kind', type: 'uint8' },
    { name: 'target', type: 'bytes32' },
    { name: 'aux', type: 'bytes32' },
    { name: 'newValue', type: 'uint256' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
  StageRelease: [
    { name: 'stageId', type: 'bytes32' },
    { name: 'amountMinor', type: 'uint128' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
  OwnerSpend: [
    { name: 'lineId', type: 'bytes32' },
    { name: 'payeeId', type: 'bytes32' },
    { name: 'amountMinor', type: 'uint128' },
    { name: 'invoiceHash', type: 'bytes32' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

export type HogeeStructName = keyof typeof hogeeTypes;
export const HOGEE_STRUCT_NAMES = Object.keys(hogeeTypes) as readonly HogeeStructName[];

/** Which deployed contract verifies each struct (its address is the domain's verifyingContract). */
export const VERIFYING_CONTRACT_OF = {
  PlanApproval: 'PlanRegistry',
  SupplierApproval: 'Treasury',
  MilestoneRelease: 'MilestoneEscrow',
  LoosenRequest: 'Treasury',
  StageRelease: 'Treasury',
  OwnerSpend: 'Treasury',
} as const satisfies Record<HogeeStructName, 'PlanRegistry' | 'Treasury' | 'MilestoneEscrow'>;

/** Canonical type strings, byte-identical to HogeeTypes.sol. */
export const HOGEE_TYPE_STRINGS = {
  EIP712Domain: 'EIP712Domain(string name,string version,address verifyingContract,bytes32 salt)',
  PlanApproval:
    'PlanApproval(bytes32 planId,uint32 version,bytes32 prevPlanHash,bytes32 planHash,bytes32 countryPackHash,bytes32 linesHash,bytes32 stagesHash,uint128 totalMinor,uint16 reserveBps,address agent,uint64 agentExpiry,bytes32 deploymentId,uint256 nonce,uint64 expiry)',
  SupplierApproval:
    'SupplierApproval(bytes32 orderId,bytes32 supplierId,bytes32 payee,bytes32 payoutAccountHash,bytes32 lineId,bytes32 scheduleHash,uint128 totalMinor,bytes32 quoteHash,bytes32 shortlistHash,uint8 chosenIndex,bool inspectionRequired,bytes32 deploymentId,uint256 nonce,uint64 expiry)',
  MilestoneRelease:
    'MilestoneRelease(bytes32 orderId,uint8 idx,uint128 amountMinor,bytes32 evidenceHash,bytes32 deploymentId,uint256 nonce,uint64 expiry)',
  LoosenRequest:
    'LoosenRequest(uint8 kind,bytes32 target,bytes32 aux,uint256 newValue,bytes32 deploymentId,uint256 nonce,uint64 expiry)',
  StageRelease: 'StageRelease(bytes32 stageId,uint128 amountMinor,bytes32 deploymentId,uint256 nonce,uint64 expiry)',
  OwnerSpend:
    'OwnerSpend(bytes32 lineId,bytes32 payeeId,uint128 amountMinor,bytes32 invoiceHash,bytes32 deploymentId,uint256 nonce,uint64 expiry)',
} as const satisfies Record<HogeeStructName | 'EIP712Domain', string>;

/** keccak256 of each type string; equal to the TYPEHASH constants in HogeeTypes.sol. */
export const HOGEE_TYPEHASHES = {
  EIP712Domain: '0x36c25de3e541d5d970f66e4210d728721220fff5c077cc6cd008b3a0c62adab7',
  PlanApproval: '0x79ade738b7faa5735e274b970b60b74a78381de71ba14db277e9699ab0fff10f',
  SupplierApproval: '0x4c20466f0a224da371247d079d44046edeb43aa6df2125a4a5ef470da19fe1d2',
  MilestoneRelease: '0x99561ec6c6f3333ade59c63a6dd74240f30a7ccf0ad591d8e38cbbccfb7cfb7c',
  LoosenRequest: '0x7c436c388e9be5950fd1e73eed20ba2be4044dc24a788bf108ccc8c0625a5cf9',
  StageRelease: '0xa47efdc649d9de812e1ec466521dba27f2f1eedfda6cae0a592e75c0f721e6e0',
  OwnerSpend: '0x915bed73783b116efd78330916948448ba772637dbeeff68be1e007c38b43962',
} as const satisfies Record<HogeeStructName | 'EIP712Domain', Hex>;

// ---- message types (viem's mapping: uint8..uint32 -> number, uint64+ -> bigint) ----

export interface PlanApprovalMessage {
  planId: Hex;
  version: number;
  prevPlanHash: Hex;
  planHash: Hex;
  countryPackHash: Hex;
  linesHash: Hex;
  stagesHash: Hex;
  totalMinor: bigint;
  reserveBps: number;
  agent: Address;
  agentExpiry: bigint;
  deploymentId: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface SupplierApprovalMessage {
  orderId: Hex;
  supplierId: Hex;
  payee: Hex;
  /** G0-REVIEW (M7, T1): keccak256(utf8(JCS({channel, accountNumber, holderName}))) of the payout account. */
  payoutAccountHash: Hex;
  lineId: Hex;
  scheduleHash: Hex;
  totalMinor: bigint;
  quoteHash: Hex;
  shortlistHash: Hex;
  chosenIndex: number;
  inspectionRequired: boolean;
  deploymentId: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface MilestoneReleaseMessage {
  orderId: Hex;
  idx: number;
  amountMinor: bigint;
  evidenceHash: Hex;
  deploymentId: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface LoosenRequestMessage {
  kind: number;
  target: Hex;
  aux: Hex;
  newValue: bigint;
  deploymentId: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface StageReleaseMessage {
  stageId: Hex;
  amountMinor: bigint;
  deploymentId: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface OwnerSpendMessage {
  lineId: Hex;
  payeeId: Hex;
  amountMinor: bigint;
  invoiceHash: Hex;
  deploymentId: Hex;
  nonce: bigint;
  expiry: bigint;
}

export interface HogeeMessages {
  PlanApproval: PlanApprovalMessage;
  SupplierApproval: SupplierApprovalMessage;
  MilestoneRelease: MilestoneReleaseMessage;
  LoosenRequest: LoosenRequestMessage;
  StageRelease: StageReleaseMessage;
  OwnerSpend: OwnerSpendMessage;
}

// ---- domain ----

export interface HogeeDomain {
  readonly name: typeof HOGEE_DOMAIN_NAME;
  readonly version: typeof HOGEE_DOMAIN_VERSION;
  readonly verifyingContract: Address;
  readonly salt: Hex;
}

export interface HogeeDomainParams {
  verifyingContract: Address;
  /** bytes32, e.g. toBytes32Tag('sepolia') */
  chainTag: Hex;
  /** bytes32, e.g. toBytes32Tag('final-1') */
  deploymentId: Hex;
}

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function assertBytes32(value: Hex, field: string): void {
  if (!BYTES32_RE.test(value)) throw new Error(`${field} must be a 0x-prefixed 32-byte hex string`);
}

/** Right-padded UTF-8 bytes32 (same convention as lineId, §26.3): chainTag, deploymentId, lineId, stageId. */
export function toBytes32Tag(label: string): Hex {
  if (label.length === 0) throw new Error('bytes32 tag must not be empty');
  if (new TextEncoder().encode(label).length > 32) throw new Error(`bytes32 tag too long: ${label}`);
  return stringToHex(label, { size: 32 });
}

/** keccak256(abi.encode(bytes32 chainTag, bytes32 deploymentId)) */
export function hogeeDomainSalt(chainTag: Hex, deploymentId: Hex): Hex {
  assertBytes32(chainTag, 'chainTag');
  assertBytes32(deploymentId, 'deploymentId');
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [chainTag, deploymentId]));
}

export function hogeeDomain({ verifyingContract, chainTag, deploymentId }: HogeeDomainParams): HogeeDomain {
  return Object.freeze({
    name: HOGEE_DOMAIN_NAME,
    version: HOGEE_DOMAIN_VERSION,
    verifyingContract,
    salt: hogeeDomainSalt(chainTag, deploymentId),
  });
}

/** Equals the on-chain IHogeeDomain.domainSeparator() of the verifying contract. */
export function hogeeDomainSeparator(domain: HogeeDomain): Hex {
  return domainSeparator({ domain });
}

// ---- typed data + hashing ----

/** Typed-data payload for a wallet (`signTypedData`) or the /api/signatures/request response. */
export interface HogeeTypedData<K extends HogeeStructName> {
  readonly domain: HogeeDomain;
  readonly types: { readonly [P in K]: (typeof hogeeTypes)[P] };
  readonly primaryType: K;
  readonly message: HogeeMessages[K];
}

export function hogeeTypedData<K extends HogeeStructName>(
  primaryType: K,
  domain: HogeeDomain,
  message: HogeeMessages[K],
): HogeeTypedData<K> {
  const types = { [primaryType]: hogeeTypes[primaryType] } as { readonly [P in K]: (typeof hogeeTypes)[P] };
  return Object.freeze({ domain, types, primaryType, message });
}

// Concrete wrappers: viem checks each message interface against its type definition at compile time.

export function hashPlanApproval(domain: HogeeDomain, message: PlanApprovalMessage): Hex {
  return hashTypedData({ domain, types: { PlanApproval: hogeeTypes.PlanApproval }, primaryType: 'PlanApproval', message });
}

export function hashSupplierApproval(domain: HogeeDomain, message: SupplierApprovalMessage): Hex {
  return hashTypedData({
    domain,
    types: { SupplierApproval: hogeeTypes.SupplierApproval },
    primaryType: 'SupplierApproval',
    message,
  });
}

export function hashMilestoneRelease(domain: HogeeDomain, message: MilestoneReleaseMessage): Hex {
  return hashTypedData({
    domain,
    types: { MilestoneRelease: hogeeTypes.MilestoneRelease },
    primaryType: 'MilestoneRelease',
    message,
  });
}

export function hashLoosenRequest(domain: HogeeDomain, message: LoosenRequestMessage): Hex {
  return hashTypedData({ domain, types: { LoosenRequest: hogeeTypes.LoosenRequest }, primaryType: 'LoosenRequest', message });
}

export function hashStageRelease(domain: HogeeDomain, message: StageReleaseMessage): Hex {
  return hashTypedData({ domain, types: { StageRelease: hogeeTypes.StageRelease }, primaryType: 'StageRelease', message });
}

export function hashOwnerSpend(domain: HogeeDomain, message: OwnerSpendMessage): Hex {
  return hashTypedData({ domain, types: { OwnerSpend: hogeeTypes.OwnerSpend }, primaryType: 'OwnerSpend', message });
}

const DIGESTERS: { [K in HogeeStructName]: (domain: HogeeDomain, message: HogeeMessages[K]) => Hex } = {
  PlanApproval: hashPlanApproval,
  SupplierApproval: hashSupplierApproval,
  MilestoneRelease: hashMilestoneRelease,
  LoosenRequest: hashLoosenRequest,
  StageRelease: hashStageRelease,
  OwnerSpend: hashOwnerSpend,
};

/** EIP-712 digest = keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message)), by struct name. */
export function hashHogeeTypedData<K extends HogeeStructName>(
  primaryType: K,
  domain: HogeeDomain,
  message: HogeeMessages[K],
): Hex {
  return DIGESTERS[primaryType](domain, message);
}

/** ITreasury.queueLoosen's loosenId = hashStruct(LoosenRequest) (no domain). */
export function loosenId(message: LoosenRequestMessage): Hex {
  return hashStruct({ data: message, primaryType: 'LoosenRequest', types: { LoosenRequest: hogeeTypes.LoosenRequest } });
}

/** keccak256(utf8(s)), e.g. saleIdHash = utf8Keccak(stripeEventId). */
export const utf8Keccak = (s: string): Hex => keccak256(toHex(s));
