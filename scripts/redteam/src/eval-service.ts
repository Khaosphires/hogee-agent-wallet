/**
 * The E1 service behind POST /api/eval/case (packages/api/src/services/eval-case.ts): quarantined Reader → binder →
 * policy → eth_call of Treasury.spend from the agent, or the planner turn, memory verification, the Stripe signature
 * check, the listing gates. The route itself answers only on Anvil (CHAIN=local); on Sepolia the runner calls this
 * same function in-process. It never signs and writes only traces and the LLM call log.
 */
import type { E1Case } from "@hogee/core";
import { evalCase } from "../../../packages/api/src/services/eval-case";
import type { ApiDeps, Scope } from "./api-internals";

export async function evalCaseService(deps: ApiDeps, scope: Scope, c: E1Case): Promise<{ executed: boolean; refusalTraceId?: string; revertReason?: string; lossMinor: string }> {
  return evalCase(deps, scope, "hogee", c);
}
