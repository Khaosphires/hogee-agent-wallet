/**
 * State reads on the mirror (eth_call at the current block) as short strings for steps.json: the refusal reads
 * before/after, the regulator's reads (GOV_READS: the agent's account status, Treasury's ContractAuth admin, whether
 * Treasury.spend is allowed for the agent), the preflight snapshot (P0, fail closed: chain, code, domain views, roles,
 * fresh contracts, date guard) and the final snapshot (P1, fail closed: released 10,000 BU, revenue 2,000 BU, paused,
 * the agent's account normal and spend allowed for it).
 */
import { iMilestoneEscrowAbi, iPlanRegistryAbi, iTreasuryAbi, lineKeyToLineId, type LineKey } from "@hogee/chain";
import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi, type Abi, type Hex } from "viem";
import { FINAL_READS, GOV_READS, type GovRead } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import type { DeployedName } from "../../../../tools/verify-evidence/src/fisco/pack";
import { SPEND_SELECTOR, SYSTEM, SYSTEM_ABI, type SystemName } from "../../../../tools/verify-evidence/src/fisco/system";
import type { ReadSpec } from "./runner";
import type { Rpc } from "./rpc";

export class StateError extends Error {
  override readonly name = "StateError";
}

/** Views of the implementations that the frozen interfaces do not list. */
export const EXTRA_VIEWS = parseAbi([
  "function deploymentId() view returns (bytes32)",
  "function chainTag() view returns (bytes32)",
  "function fiscoMs() view returns (bool)",
  "function isNonceUsed(uint256 nonce) view returns (bool)",
  "function lender() view returns (address)",
  "function oracle() view returns (address)",
  "function observer() view returns (address)",
  "function governance() view returns (address)",
  "function coolingSeconds() view returns (uint64)",
  "function loosenTimelockSeconds() view returns (uint64)",
  "function judgingWindowEnd() view returns (uint64)",
  "function domainSeparator() view returns (bytes32)",
]);

/** The interface ABI plus the extra views it does not already name (no duplicate entries for viem to choose from). */
function withExtras(abi: Abi): Abi {
  const named = new Set(abi.flatMap((x) => ("name" in x ? [x.name] : [])));
  return [...abi, ...EXTRA_VIEWS.filter((x) => !named.has(x.name))];
}

const ABI_OF: Record<DeployedName, Abi> = {
  PlanRegistry: withExtras(iPlanRegistryAbi as Abi),
  Treasury: withExtras(iTreasuryAbi as Abi),
  MilestoneEscrow: withExtras(iMilestoneEscrowAbi as Abi),
  SalesOracle: withExtras([]),
};

/** JSON with bigints as decimal strings (a read's value). */
export function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "bigint" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
}

/** bytes32 right-padded label → text ("fisco"); other bytes32 stay hex. */
export function tagText(v: Hex): string {
  try {
    const text = hexToString(v, { size: 32 }).replace(/\0+$/, "");
    return /^[\x20-\x7e]+$/.test(text) ? text : v;
  } catch {
    return v;
  }
}

export class Reader {
  constructor(
    private readonly rpc: Rpc,
    readonly contracts: Readonly<Record<DeployedName, Hex>>,
  ) {}

  async view<T = unknown>(contract: DeployedName, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const abi = ABI_OF[contract];
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const ret = await this.rpc.call({ to: this.contracts[contract], data });
    return decodeFunctionResult({ abi, functionName, data: ret } as never) as T;
  }

  /** A ReadSpec of one view; `pick` narrows a struct to the fields that matter. */
  spec(label: string, contract: DeployedName, functionName: string, args: readonly unknown[] = [], pick?: (v: never) => unknown): ReadSpec {
    return { label, read: async () => show(pick ? pick((await this.view(contract, functionName, args)) as never) : await this.view(contract, functionName, args)) };
  }

  pocketField(line: LineKey, field: string): ReadSpec {
    return this.spec(`Treasury.pocket(${line}).${field}`, "Treasury", "pocket", [lineKeyToLineId(line)], (p: Record<string, unknown>) => p[field]);
  }

  balance(field: string): ReadSpec {
    return this.spec(`Treasury.balances().${field}`, "Treasury", "balances", [], (b: Record<string, unknown>) => b[field]);
  }

  milestone(orderId: Hex, idx: number): ReadSpec {
    return this.spec(`MilestoneEscrow.milestones(${tagText(orderId)})[${idx}]`, "MilestoneEscrow", "milestones", [orderId], (ms: readonly Record<string, unknown>[]) => {
      const m = ms[idx];
      return m ? `funded ${show(m.fundedMinor)}/${show(m.amountMinor)} released ${String(m.released)}` : "none";
    });
  }

  nonceUsed(contract: DeployedName, nonce: bigint): ReadSpec {
    return this.spec(`${contract}.isNonceUsed(${nonce.toString(16).slice(0, 12)}…)`, contract, "isNonceUsed", [nonce]);
  }

  /** A FISCO system contract's view (system.ts ABI, fixed address). */
  async system<T = unknown>(name: SystemName, functionName: string, args: readonly unknown[] = []): Promise<T> {
    const abi = SYSTEM_ABI[name] as Abi;
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const ret = await this.rpc.call({ to: SYSTEM[name], data });
    return decodeFunctionResult({ abi, functionName, data: ret } as never) as T;
  }

  /** The value of one of the regulator's reads for `agent`: "0"/"1", a lowercase address, "true"/"false". */
  async govValue(label: GovRead, agent: Hex): Promise<string> {
    const treasury = this.contracts.Treasury;
    switch (label) {
      case GOV_READS.accountStatus:
        return show(await this.system<number>("AccountManager", "getAccountStatus", [agent]));
      case GOV_READS.treasuryAdmin:
        return (await this.system<Hex>("ContractAuth", "getAdmin", [treasury])).toLowerCase();
      case GOV_READS.spendAllowed:
        return show(await this.system<boolean>("ContractAuth", "checkMethodAuth", [treasury, SPEND_SELECTOR, agent]));
    }
  }

  /** A ReadSpec of one of the regulator's reads, labelled as the checker expects (GOV_READS). */
  gov(label: GovRead, agent: Hex): ReadSpec {
    return { label, read: () => this.govValue(label, agent) };
  }
}

export interface PreflightExpect {
  readonly lender: Hex;
  readonly oracle: Hex;
  readonly earliestExpiry: string;
}

/** P0 reads; throws unless the mirror is a fresh, correctly tagged final-2 set wired to the replay's roles. */
export async function preflightReads(rpc: Rpc, r: Reader, x: PreflightExpect): Promise<ReadSpec[]> {
  const specs: ReadSpec[] = [{ label: "eth_chainId", read: async () => String(await rpc.chainId()) }];
  for (const name of Object.keys(r.contracts) as DeployedName[]) {
    const code = await rpc.code(r.contracts[name], "latest");
    if (code.length <= 2) throw new StateError(`${name} has no code at ${r.contracts[name]}`);
    specs.push({ label: `eth_getCode(${name}) bytes`, read: async () => String((code.length - 2) / 2) });
  }
  for (const name of ["PlanRegistry", "Treasury", "MilestoneEscrow"] as const) {
    const [dep, tag, ms] = await Promise.all([r.view<Hex>(name, "deploymentId"), r.view<Hex>(name, "chainTag"), r.view<boolean>(name, "fiscoMs")]);
    if (tagText(dep) !== "final-2" || tagText(tag) !== "fisco" || ms !== false) throw new StateError(`${name}: deploymentId ${tagText(dep)}, chainTag ${tagText(tag)}, fiscoMs ${ms}: not the fisco final-2 set`);
    specs.push({ label: `${name}.deploymentId/chainTag/fiscoMs`, read: async () => `${tagText(dep)} / ${tagText(tag)} / ${String(ms)}` });
  }
  const [lender, oracle, version, facility] = await Promise.all([r.view<Hex>("Treasury", "lender"), r.view<Hex>("Treasury", "oracle"), r.view<number>("PlanRegistry", "planVersion"), r.view<{ opened: boolean }>("Treasury", "facility")]);
  if (lender.toLowerCase() !== x.lender || oracle.toLowerCase() !== x.oracle) throw new StateError("the Treasury's lender/oracle are not the replay's lender/oracle keys");
  if (version !== 0 || facility.opened) throw new StateError("the mirror is not fresh: a plan is committed or the facility is open");
  specs.push(
    r.spec("Treasury.lender()", "Treasury", "lender", [], (a: string) => a.toLowerCase()),
    r.spec("Treasury.oracle()", "Treasury", "oracle", [], (a: string) => a.toLowerCase()),
    r.spec("Treasury.observer()", "Treasury", "observer", [], (a: string) => a.toLowerCase()),
    r.spec("Treasury.governance()", "Treasury", "governance", [], (a: string) => a.toLowerCase()),
    r.spec("PlanRegistry.planVersion()", "PlanRegistry", "planVersion"),
    r.spec("Treasury.facility().opened", "Treasury", "facility", [], (f: { opened: boolean }) => f.opened),
    { label: "date guard: earliest plan expiry", read: async () => x.earliestExpiry },
  );
  return specs;
}

const FINAL_RELEASED = 1_000_000n;
const FINAL_REVENUE = 200_000n;

/**
 * P1 reads; throws unless the run ended as final-2's story says (10,000 BU released, 2,000 BU revenue, paused) and the
 * regulator lifted both of its stops (the agent's account normal, Treasury.spend allowed for it).
 */
export async function finalReads(r: Reader, orderId: Hex, settlementIds: readonly Hex[], agent: Hex): Promise<ReadSpec[]> {
  const [released, revenue, paused] = await Promise.all([r.view<bigint>("Treasury", "releasedMinor"), r.view<bigint>("Treasury", "revenue"), r.view<boolean>("Treasury", "paused")]);
  if (released !== FINAL_RELEASED || revenue !== FINAL_REVENUE || paused !== true) {
    throw new StateError(`final state: released ${released}, revenue ${revenue}, paused ${paused}; expected ${FINAL_RELEASED}, ${FINAL_REVENUE}, true`);
  }
  const [status, allowed] = [await r.govValue(GOV_READS.accountStatus, agent), await r.govValue(GOV_READS.spendAllowed, agent)];
  if (status !== FINAL_READS.agentAccountStatus || allowed !== FINAL_READS.spendAllowedForAgent) {
    throw new StateError(`final state: the agent's account status ${status}, spend allowed ${allowed}; expected ${FINAL_READS.agentAccountStatus}, ${FINAL_READS.spendAllowedForAgent}`);
  }
  // The first five labels are the checker's FINAL_READS (catalogue.ts): decimal strings and "true".
  return [
    r.spec("releasedMinor", "Treasury", "releasedMinor"),
    r.spec("revenueTotalMinor", "Treasury", "revenue"),
    r.spec("paused", "Treasury", "paused"),
    { label: "agentAccountStatus", read: () => r.govValue(GOV_READS.accountStatus, agent) },
    { label: "spendAllowedForAgent", read: () => r.govValue(GOV_READS.spendAllowed, agent) },
    r.spec("Treasury.reserve()", "Treasury", "reserve"),
    r.balance("fundedMinor"),
    r.balance("spentMinor"),
    r.balance("escrowedMinor"),
    r.spec("PlanRegistry.planVersion()", "PlanRegistry", "planVersion"),
    r.milestone(orderId, 0),
    r.milestone(orderId, 1),
    ...settlementIds.map((id, i) => r.spec(`Treasury.settlementState(milestone ${i})`, "Treasury", "settlementState", [id])),
    r.pocketField("LOGISTICS", "perTxCapMinor"),
    r.pocketField("PLATFORM_FEES", "spentMinor"),
  ];
}
