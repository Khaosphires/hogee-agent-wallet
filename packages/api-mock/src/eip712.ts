/**
 * The slice of @hogee/chain eip712.ts / kinds.ts the mock needs, mirrored so Next can bundle the mock:
 * @hogee/chain's index also loads deployments.ts, whose `new URL('../deployments/', import.meta.url)` Turbopack
 * cannot resolve. test/eip712-parity.test.ts compares every value with @hogee/chain, so a drift fails CI.
 */
import { encodeAbiParameters, keccak256, stringToHex, type Hex } from "viem";

export const HOGEE_DOMAIN_NAME = "Hogee";
export const HOGEE_DOMAIN_VERSION = "1";

export const hogeeTypes = {
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
} as const;

export type HogeeStructName = keyof typeof hogeeTypes;

export const VERIFYING_CONTRACT_OF = {
  PlanApproval: "PlanRegistry",
  SupplierApproval: "Treasury",
  MilestoneRelease: "MilestoneEscrow",
  LoosenRequest: "Treasury",
  StageRelease: "Treasury",
  OwnerSpend: "Treasury",
} as const satisfies Record<HogeeStructName, string>;

/** LoosenRequest.kind values (HogeeKinds.sol LOOSEN_*). */
export const LOOSEN_KINDS = {
  LOOSEN_RAISE_PER_TX_CAP: 1,
  LOOSEN_RAISE_WINDOW_CAP: 2,
  LOOSEN_ADD_PAYEE: 3,
  LOOSEN_EXTEND_AGENT_EXPIRY: 4,
  LOOSEN_EXTEND_LINE_EXPIRY: 5,
  LOOSEN_MOVE_POCKETS: 6,
  LOOSEN_UNPAUSE: 7,
  LOOSEN_WITHDRAW_RESERVE: 8,
} as const;

/** Right-padded UTF-8 bytes32, like lineId (§26.3). */
export const toBytes32Tag = (label: string): Hex => stringToHex(label, { size: 32 });

/**
 * The deployment's chainTag label for a chain id (deployments/<chainTag>-<deploymentId>.json, e.g. "sepolia").
 * Not part of @hogee/chain: the browser uses it to check the signing domain against the session.
 */
export const chainTagOf = (chainId: number): string => (chainId === 31337 ? "anvil" : chainId === 11155111 ? "sepolia" : `chain-${chainId}`);

export interface HogeeDomain {
  readonly name: typeof HOGEE_DOMAIN_NAME;
  readonly version: typeof HOGEE_DOMAIN_VERSION;
  readonly verifyingContract: Hex;
  readonly salt: Hex;
}

/** Custom domain (§8.7): salt = keccak256(abi.encode(bytes32 chainTag, bytes32 deploymentId)). */
export function hogeeDomain(p: { verifyingContract: Hex; chainTag: Hex; deploymentId: Hex }): HogeeDomain {
  const salt = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [p.chainTag, p.deploymentId]));
  return { name: HOGEE_DOMAIN_NAME, version: HOGEE_DOMAIN_VERSION, verifyingContract: p.verifyingContract, salt };
}

/**
 * SupplierApproval.scheduleHash = keccak256(abi.encode(uint128[] schedule, bool[] autoRelease)), as @hogee/chain
 * hashes.ts. The browser recomputes it from the milestones a web order's panel shows (apps/web lib/typed-data.ts).
 */
export function scheduleHash(schedule: readonly bigint[], autoRelease: readonly boolean[]): Hex {
  if (schedule.length !== autoRelease.length) throw new Error(`schedule (${schedule.length}) and autoRelease (${autoRelease.length}) lengths differ`);
  return keccak256(encodeAbiParameters([{ type: "uint128[]" }, { type: "bool[]" }], [schedule, autoRelease]));
}
