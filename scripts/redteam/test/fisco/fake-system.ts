/**
 * The FISCO BCOS 3.17.1 system contracts as the fake node emulates them, from P1's live test (~/hogee-wt/REG-FACTS.md):
 *   AccountManager 0x10003  setAccountStatus by the governor only (else int32 -50000 inside a SUCCESS receipt); a freeze
 *                           of an account that sent a tx before it was ever registered gives -51900 and freezes nothing
 *                           (trap 1); a status change applies from the NEXT block; getAccountStatus also works as a tx.
 *   ContractAuth   0x1005   per-contract admin (the deployer until a reset-admin proposal); setMethodAuthType /
 *                           closeMethodAuth / openMethodAuth by that admin only; effects immediate; checkMethodAuth.
 *   CommitteeManager 0x10001 one governor; a proposal passes and executes in its own tx, returns its id and emits the
 *                           one proposal log.
 * A frozen sender's tx is mined with native status 22 (nonce consumed); a banned method call with 18. eth_call from a
 * frozen or banned sender fails with JSON-RPC code 22 / 18 and Error(string) data.
 */
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, parseAbi, type Abi, type Hex } from "viem";
import { PROPOSAL_LOG, SYSTEM, SYSTEM_ABI, systemNameAt, type SystemName } from "../../../../tools/verify-evidence/src/fisco/system";

export const ERROR_STRING_ABI = parseAbi(["error Error(string)"]);
export const errorString = (text: string): Hex => encodeErrorResult({ abi: ERROR_STRING_ABI, errorName: "Error", args: [text] });
export const FROZEN_TEXT = "Account's status is abnormal";
export const DENIED_TEXT = "Call permission denied";

export interface SystemResult {
  readonly output: Hex;
  readonly logs: readonly { address: string; topics: Hex[]; data: Hex }[];
}

export class FakeSystem {
  /** Status changes: the status applies from block `from` on. */
  private readonly statusChanges = new Map<string, { status: number; from: number }[]>();
  private readonly registered = new Set<string>();
  private readonly admins = new Map<string, string>();
  private readonly authType = new Map<string, number>();
  private readonly closed = new Set<string>();
  private readonly opened = new Set<string>();
  private proposals = 1;

  constructor(
    readonly governor: string,
    private readonly defaultAdmin: string,
  ) {}

  statusAt(account: string, block: number): number {
    const changes = this.statusChanges.get(account.toLowerCase()) ?? [];
    return changes.filter((c) => c.from <= block).at(-1)?.status ?? 0;
  }

  adminOf(contract: string): string {
    return this.admins.get(contract.toLowerCase()) ?? this.defaultAdmin.toLowerCase();
  }

  private key = (contract: string, selector: string, account?: string): string => `${contract.toLowerCase()}:${selector.toLowerCase()}${account ? `:${account.toLowerCase()}` : ""}`;

  allowed(contract: string, selector: string, account: string): boolean {
    const type = this.authType.get(this.key(contract, selector)) ?? 0;
    if (type === 2) return !this.closed.has(this.key(contract, selector, account));
    if (type === 1) return this.opened.has(this.key(contract, selector, account));
    return true;
  }

  /** The chain's own refusal of a call from `from` to `to` at block `block`: 22 frozen, 18 banned, null when it passes. */
  refusal(from: string, to: string | null, data: string, block: number): { code: 22 | 18; data: Hex } | null {
    if (this.statusAt(from, block) !== 0) return { code: 22, data: errorString(FROZEN_TEXT) };
    if (to && data.length >= 10 && !this.allowed(to, data.slice(0, 10), from)) return { code: 18, data: errorString(DENIED_TEXT) };
    return null;
  }

  /** Executes a call to a system contract from `from`; `mined` = the block it is mined in (state changes), or null for an eth_call. */
  execute(name: SystemName, from: string, data: Hex, at: { block: number; mined: boolean; nonceOf: (a: string) => number }): SystemResult {
    const abi = SYSTEM_ABI[name] as Abi;
    const d = decodeFunctionData({ abi, data });
    const args = (d.args ?? []) as readonly unknown[];
    const ret = (value: unknown): Hex => encodeFunctionResult({ abi, functionName: d.functionName, result: value } as never);
    const sender = from.toLowerCase();
    const isGov = sender === this.governor.toLowerCase();
    const noLogs = (output: Hex): SystemResult => ({ output, logs: [] });
    switch (`${name}.${d.functionName}`) {
      case "AccountManager.setAccountStatus": {
        const [account, status] = [String(args[0]).toLowerCase(), Number(args[1])];
        if (!isGov) return noLogs(ret(-50_000));
        if (status !== 0 && !this.registered.has(account) && at.nonceOf(account) > 0) return noLogs(ret(-51_900));
        if (at.mined) {
          if (status === 0) this.registered.add(account);
          this.statusChanges.set(account, [...(this.statusChanges.get(account) ?? []), { status, from: at.block + 1 }]);
        }
        return noLogs(ret(0));
      }
      case "AccountManager.getAccountStatus":
        return noLogs(ret(this.statusAt(String(args[0]), at.block)));
      case "CommitteeManager.isGovernor":
        return noLogs(ret(String(args[0]).toLowerCase() === this.governor.toLowerCase()));
      case "CommitteeManager.createResetAdminProposal":
      case "CommitteeManager.createSetConsensusWeightProposal": {
        if (!isGov) return noLogs(encodeAbiParameters([{ type: "int256" }], [-50_000n]));
        const id = this.proposals + 1;
        if (at.mined) {
          this.proposals = id;
          if (d.functionName === "createResetAdminProposal") this.admins.set(String(args[1]).toLowerCase(), String(args[0]).toLowerCase());
        }
        return { output: ret(BigInt(id)), logs: at.mined ? [{ address: PROPOSAL_LOG.address, topics: [PROPOSAL_LOG.topic0], data: PROPOSAL_LOG.data }] : [] };
      }
      case "ContractAuth.getAdmin":
        return noLogs(ret(this.adminOf(String(args[0]))));
      case "ContractAuth.checkMethodAuth":
        return noLogs(ret(this.allowed(String(args[0]), String(args[1]), String(args[2]))));
      case "ContractAuth.setMethodAuthType":
      case "ContractAuth.closeMethodAuth":
      case "ContractAuth.openMethodAuth": {
        const contract = String(args[0]);
        if (sender !== this.adminOf(contract)) return noLogs(ret(-50_000n));
        if (at.mined) {
          const sel = String(args[1]);
          if (d.functionName === "setMethodAuthType") this.authType.set(this.key(contract, sel), Number(args[2]));
          const k = this.key(contract, sel, String(args[2]));
          if (d.functionName === "closeMethodAuth") {
            this.closed.add(k);
            this.opened.delete(k);
          }
          if (d.functionName === "openMethodAuth") {
            this.opened.add(k);
            this.closed.delete(k);
          }
        }
        return noLogs(ret(0n));
      }
      default:
        throw new Error(`fake system: ${name}.${d.functionName} is not emulated`);
    }
  }
}

export const isSystemAddress = (to: string | null | undefined): SystemName | null => systemNameAt(to ?? null);
export { SYSTEM };
