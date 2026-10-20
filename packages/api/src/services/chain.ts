/**
 * Read-only chain views the API needs (§26.9). Some views are outside the frozen ABI (public on the final-1
 * contracts, not frozen surface): Treasury.oracle() / platformPayoutAccountHash(payeeId) / observer() /
 * isSignedPayee(lineId, payeeId) and PlanRegistry.judgingWindowEnd(); they use a small local ABI. Nothing here can sign.
 */
import { parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { ApiDeps } from "../context";
import { iPlanRegistryAbi, iTreasuryAbi } from "../chain-lib";
import { fail } from "../http/problem";
import { one, type Q } from "./sql";

const extraAbi = parseAbi([
  "function oracle() view returns (address)",
  "function platformPayoutAccountHash(bytes32 payeeId) view returns (bytes32)",
  "function judgingWindowEnd() view returns (uint64)",
  "function observer() view returns (address)",
  "function isSignedPayee(bytes32 lineId, bytes32 payeeId) view returns (bool)",
]);

type Reader = Pick<ApiDeps, "client" | "deployment">;
const registry = (d: Reader) => d.deployment.contracts.PlanRegistry.address;
const treasury = (d: Reader) => d.deployment.contracts.Treasury.address;

/** Chain time (unix seconds) of the latest block: the policy clock, so Anvil warps move it. */
export async function chainNow(d: Reader): Promise<bigint> {
  return (await d.client.getBlock({ blockTag: "latest" })).timestamp;
}

export async function founderKeyOnChain(d: Reader): Promise<{ qx: Hex; qy: Hex; ownerEOA: Address; set: boolean }> {
  const [qx, qy, ownerEOA] = await d.client.readContract({ address: registry(d), abi: iPlanRegistryAbi, functionName: "founderKey" });
  const zero = /^0x0+$/;
  return { qx, qy, ownerEOA, set: !(zero.test(qx) && zero.test(qy) && zero.test(ownerEOA)) };
}

/**
 * Treasury.isSignedPayee: bound to the line by a founder-signed approval (bindPayee, LOOSEN_ADD_PAYEE). PlanReplan
 * counts such a payee among the line's current payees even when the current plan does not list it.
 */
export async function signedPayeeOnChain(d: Reader, lineId: Hex, payeeId: Hex, blockNumber: bigint): Promise<boolean> {
  return d.client.readContract({ address: treasury(d), abi: extraAbi, functionName: "isSignedPayee", args: [lineId, payeeId], blockNumber });
}

export async function facilityOnChain(d: Reader) {
  return d.client.readContract({ address: treasury(d), abi: iTreasuryAbi, functionName: "facility" });
}

export async function currentPlanOnChain(d: Reader) {
  return d.client.readContract({ address: registry(d), abi: iPlanRegistryAbi, functionName: "currentPlan" });
}

export async function lenderOnChain(d: Reader): Promise<Address> {
  return d.client.readContract({ address: registry(d), abi: iPlanRegistryAbi, functionName: "lender" });
}

export async function oracleOnChain(d: Reader): Promise<Address> {
  return d.client.readContract({ address: treasury(d), abi: extraAbi, functionName: "oracle" });
}

/** Treasury.observer() (the cancelLoosen veto); only the final-1 Treasury has it, so loop-1 reads as zero = none. */
export async function observerOnChain(d: Reader): Promise<Address> {
  if ((d.deployment.contracts as { MilestoneEscrow?: unknown }).MilestoneEscrow === undefined) return zeroAddress;
  return d.client.readContract({ address: treasury(d), abi: extraAbi, functionName: "observer" });
}

export async function judgingWindowEnd(d: Reader): Promise<bigint> {
  return d.client.readContract({ address: registry(d), abi: extraAbi, functionName: "judgingWindowEnd" });
}

export async function platformPayoutHash(d: Reader, payeeId: Hex): Promise<Hex> {
  return d.client.readContract({ address: treasury(d), abi: extraAbi, functionName: "platformPayoutAccountHash", args: [payeeId] });
}

export interface WorkerRoles {
  readonly agent: Address;
  readonly relayer: Address;
}

/**
 * The worker's public role addresses for this deployment (it publishes them at start-up in hogee_worker.roles). The
 * API needs the agent address to compile a plan (PlanApproval.agent) and the relayer to simulate relayed calls.
 */
export async function workerRoles(q: Q, d: Reader): Promise<WorkerRoles> {
  let row: { agent: string | null; relayer: string | null } | undefined;
  try {
    row = await one(
      q,
      `select max(address) filter (where role = 'agent') as agent, max(address) filter (where role = 'relayer') as relayer
         from hogee_worker.roles where deployment_id = $1 and chain_id = $2`,
      [d.deployment.deploymentId, d.deployment.chainId],
    );
  } catch {
    row = undefined; // the worker schema does not exist yet
  }
  if (!row?.agent || !row.relayer) throw fail("UPSTREAM", "The worker has not started for this deployment yet (no published role addresses)");
  return { agent: row.agent as Address, relayer: row.relayer as Address };
}
