/**
 * Treasury.revenueLedger() read into the CFO snapshot (reserve skimmed / withdrawn, recorded sales count). Not frozen
 * surface (task 1.8 ledger detail), so a local ABI, as in services/loosen.ts. Read at the CFO snapshot's block so the
 * reserve figures match the pockets and balances read at that block. Throws on any RPC error (the caller fails closed).
 */
import { parseAbi } from "viem";
import type { ApiDeps } from "../context";

export interface RevenueLedger {
  readonly reserveSkimmedMinor: bigint;
  readonly reserveWithdrawnMinor: bigint;
  readonly salesCount: bigint;
}

const ledgerAbi = parseAbi(["function revenueLedger() view returns (uint128 reserveSkimmedMinor, uint128 reserveWithdrawnMinor, uint64 salesCount)"]);

/** `blockNumber`: read at that block (the CFO snapshot's); absent: the latest block. */
export async function readRevenueLedger(deps: Pick<ApiDeps, "client" | "deployment">, blockNumber?: bigint): Promise<RevenueLedger> {
  const [skimmed, withdrawn, count] = await deps.client.readContract({
    address: deps.deployment.contracts.Treasury.address,
    abi: ledgerAbi,
    functionName: "revenueLedger",
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  if (withdrawn > skimmed) throw new Error("revenueLedger: more withdrawn than set aside");
  return { reserveSkimmedMinor: skimmed, reserveWithdrawnMinor: withdrawn, salesCount: BigInt(count) };
}
