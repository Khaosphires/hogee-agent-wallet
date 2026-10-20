/**
 * FISCO BCOS 3.17.1 system contracts the mirror's regulator drives (pack format `hogee.fisco-mirror/2`): their fixed
 * addresses, the minimal ABIs the replay sends and the checker decodes, the allow-list of calls a catalogue step may
 * send, the one system log a step may carry, and the native receipt status codes. Browser-safe: constants and pure
 * viem helpers only. Facts confirmed by P1's live test of a 3.17.1 auth chain (~/hogee-wt/REG-FACTS.md, 20 Oct).
 */
import { decodeFunctionData, decodeFunctionResult, parseAbi, toFunctionSelector, type Abi, type Hex } from "viem";

/** Precompiled system contracts (fixed addresses on every FISCO BCOS 3.x chain). */
export const SYSTEM = {
  AccountManager: "0x0000000000000000000000000000000000010003",
  CommitteeManager: "0x0000000000000000000000000000000000010001",
  ContractAuth: "0x0000000000000000000000000000000000001005",
} as const;
export const SYSTEM_NAMES = ["AccountManager", "CommitteeManager", "ContractAuth"] as const;
export type SystemName = (typeof SYSTEM_NAMES)[number];

/**
 * AccountManager (0x10003). Status 0 = normal, 1 = frozen, 2 = abolished (never used: it cannot be undone). A status
 * change takes effect from the NEXT block; a tx calling getAccountStatus (V steps) proves the new status on chain.
 */
export const ACCOUNT_MANAGER_ABI = parseAbi([
  "function setAccountStatus(address account, uint8 status) returns (int32)",
  "function getAccountStatus(address account) view returns (uint8)",
]);

/** CommitteeManager (0x10001). With one governor (weight 1, rates 0) a proposal passes and executes in its own tx. */
export const COMMITTEE_MANAGER_ABI = parseAbi([
  "function createSetConsensusWeightProposal(string nodeId, uint32 weight, bool addFlag, uint256 blockNumberInterval) returns (uint256)",
  "function createResetAdminProposal(address newAdmin, address contractAddr, uint256 blockNumberInterval) returns (uint256)",
  "function isGovernor(address account) view returns (bool)",
]);

/** ContractAuth (0x1005). Method auth type 1 = whitelist, 2 = blacklist; effects are immediate; calls need the admin. */
export const CONTRACT_AUTH_ABI = parseAbi([
  "function setMethodAuthType(address contractAddr, bytes4 func, uint8 authType) returns (int256)",
  "function openMethodAuth(address contractAddr, bytes4 func, address account) returns (int256)",
  "function closeMethodAuth(address contractAddr, bytes4 func, address account) returns (int256)",
  "function checkMethodAuth(address contractAddr, bytes4 func, address account) view returns (bool)",
  "function getAdmin(address contractAddr) view returns (address)",
]);

export const SYSTEM_ABI = { AccountManager: ACCOUNT_MANAGER_ABI, CommitteeManager: COMMITTEE_MANAGER_ABI, ContractAuth: CONTRACT_AUTH_ABI } as const;

/**
 * The only system calls a catalogue step may SEND. getAccountStatus is a view, sent as a tx only by the V steps (the
 * catalogue names it nowhere else); every other read goes through eth_call and is never a step.
 */
export const SYSTEM_CALLS: Readonly<Record<SystemName, readonly string[]>> = {
  AccountManager: ["setAccountStatus", "getAccountStatus"],
  CommitteeManager: ["createResetAdminProposal"],
  ContractAuth: ["setMethodAuthType", "closeMethodAuth", "openMethodAuth"],
};

/** The chain-up call that makes node4 the regulator's observer (not a replay step; ledger.ts explains its tx). */
export const OBSERVER_PROPOSAL = { contract: "CommitteeManager", function: "createSetConsensusWeightProposal", weight: 0, addFlag: true, blockNumberInterval: 1000n } as const;

/**
 * The one log a system call emits: CommitteeManager on a proposal (G3, and the observer proposal at chain-up). It is
 * allowed exactly there; any other log from a system contract fails the pack.
 */
export const PROPOSAL_LOG = {
  address: SYSTEM.CommitteeManager,
  topic0: "0x7251e13f6f51fdfe60094817f80310366d2e1148fe8a46cb475b582d35bfdea8",
  data: `0x${"0".repeat(64)}`,
} as const;

/** FISCO native receipt status (getTransactionReceipt on the native RPC): 16 is an ordinary contract revert. */
export const NATIVE_STATUS = { ok: 0, revert: 16, permissionDenied: 18, accountFrozen: 22 } as const;

/**
 * JSON-RPC error codes of an eth_call / estimateGas the chain refuses ("Account's status is abnormal", "Call
 * permission denied" in the Error(string) data): the code is authoritative, the text informative.
 */
export const RPC_REFUSAL_CODE = { accountFrozen: 22, permissionDenied: 18 } as const;

/** AccountManager statuses the regulator uses (2, abolished, is never used). */
export const ACCOUNT_STATUS = { normal: 0, frozen: 1 } as const;
/** ContractAuth method auth types. */
export const METHOD_AUTH_TYPE = { whitelist: 1, blacklist: 2 } as const;
/** blockNumberInterval of every regulator proposal (G3, the observer proposal). */
export const PROPOSAL_BLOCK_INTERVAL = 1000n;

/**
 * Return codes a system call may give inside a SUCCESS receipt (the receipt alone never shows them): a non-governor's
 * setAccountStatus, and a freeze of an account that was never registered (trap 1: it freezes nothing).
 */
export const SYSTEM_RETURN = { ok: 0n, notGovernor: -50_000n, accountNotRegistered: -51_900n } as const;

/** Treasury.spend's selector: the one method the regulator bans for the agent (G4–G6). */
export const SPEND_SIGNATURE = "spend(bytes32,bytes32,uint128,bytes32,uint32,bytes32,bytes32)";
export const SPEND_SELECTOR: Hex = toFunctionSelector(`function ${SPEND_SIGNATURE}`);

export const isSystemName = (name: string): name is SystemName => (SYSTEM_NAMES as readonly string[]).includes(name);
/** The system contract at an address, or null. */
export const systemNameAt = (address: string | null | undefined): SystemName | null =>
  SYSTEM_NAMES.find((n) => typeof address === "string" && SYSTEM[n] === address.toLowerCase()) ?? null;

export interface SystemCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** An allow-listed system call of `target` decoded from calldata; null for anything else (fail closed). */
export function decodeSystemCall(target: SystemName, data: string): SystemCall | null {
  try {
    const d = decodeFunctionData({ abi: SYSTEM_ABI[target] as Abi, data: data as Hex });
    return SYSTEM_CALLS[target].includes(d.functionName) ? { name: d.functionName, args: d.args ?? [] } : null;
  } catch {
    return null;
  }
}

const INT_WORD = parseAbi(["function r() returns (int256)"]);

/**
 * A system call's return word (native receipt `output`, or an eth_call result) as a signed bigint; null when it is
 * not exactly one ABI word. int32 and uint8 returns are one word too (sign- or zero-extended), so all read alike.
 */
export function outputOf(output: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(output)) return null;
  try {
    return decodeFunctionResult({ abi: INT_WORD, functionName: "r", data: output as Hex });
  } catch {
    return null;
  }
}
