/**
 * Policy checks for exceptions, through @hogee/core against the chain-backed PolicyContext (the same rules the
 * contracts enforce, so a refusal here is the revert the chain would give): loosenings (queueLoosen/executeLoosen
 * rows) and stage releases (the gate as the chain counts it).
 */
import { evaluateLoosen, evaluateReleaseStage, trusted, type LoosenRequestIn, type PolicyContext, type PolicyDecision } from "@hogee/core";
import { parseAbi } from "viem";
import type { ApiDeps } from "../context";
import { contractFailure, fail, isContractError, type ApiProblem } from "../http/problem";
import { payoutHashOf } from "../catalog/payees";
import { reserveTaxPayee, type ExceptionRow } from "./exceptions";

const FOUNDER = { trust: "trusted", sensitivity: "public" } as const;
const SRC = "founder-request";

/** A refusal as the API failure: the contract error it mirrors (409), else CONFLICT with the policy code. */
export function decisionFailure(d: PolicyDecision): ApiProblem {
  if (isContractError(d.reasonCode)) {
    return contractFailure(d.reasonCode, `The chain would refuse this (${d.reasonCode}${d.constitutionCode ? `: ${d.constitutionCode}` : ""})`, d.constitutionCode ? { code: d.constitutionCode } : undefined);
  }
  return fail("CONFLICT", `Refused by policy (${d.reasonCode})`);
}

/**
 * The exception's payload as a core LoosenRequestIn (the founder's own authenticated request: trusted). The payees are
 * the server's own: ADD_PAYEE an onboarded catalog payee, WITHDRAW_RESERVE the server country's tax payee (run-8).
 */
export async function loosenIn(deps: ApiDeps, e: Pick<ExceptionRow, "kind" | "payload">): Promise<LoosenRequestIn> {
  const p = e.payload as Record<string, string>;
  switch (e.kind) {
    case "RAISE_CAP":
      return { kind: "RAISE_CAP", lineKey: p.lineKey as never, cap: p.cap as "perTx" | "window", newCapMinor: trusted(p.newCapMinor as string, SRC) };
    case "ADD_PAYEE": {
      const payee = (await deps.catalog.payees()).find((x) => x.payeeId === p.payeeId);
      if (!payee) throw fail("CONFLICT", "Only an onboarded payee can be added to a line");
      return { kind: "ADD_PAYEE", lineKey: p.lineKey as never, payeeId: trusted(payee.payeeId, SRC), payoutAccountHash: payoutHashOf(payee) };
    }
    case "EXTEND_EXPIRY":
      return { kind: "EXTEND_EXPIRY", target: p.target as "agent" | "line", ...(p.lineKey ? { lineKey: p.lineKey as never } : {}), newExpiresAt: trusted(p.newExpiresAt as string, SRC) };
    case "MOVE_POCKETS":
      return { kind: "MOVE_POCKETS", fromLineKey: p.fromLineKey as never, toLineKey: p.toLineKey as never, amountMinor: trusted(p.amountMinor as string, SRC) };
    case "UNPAUSE":
      return { kind: "UNPAUSE", ...(p.lineKey ? { lineKey: p.lineKey as never } : {}) };
    case "WITHDRAW_RESERVE":
      return { kind: "WITHDRAW_RESERVE", amountMinor: trusted(p.amountMinor as string, SRC), taxPayeeId: trusted(reserveTaxPayee(deps, p.taxPayeeId).payeeId, SRC) };
    default:
      throw fail("CONFLICT", `${e.kind} is not a timelocked loosening`);
  }
}

/** Throws the mirrored failure unless the loosening would pass queueLoosen's checks now. */
export async function assertLoosenAllowed(deps: ApiDeps, e: Pick<ExceptionRow, "kind" | "payload">, ctx: PolicyContext): Promise<void> {
  const d = evaluateLoosen({ kind: "LOOSEN", origin: FOUNDER, request: await loosenIn(deps, e) }, ctx);
  if (d.verdict === "DENY") throw decisionFailure(d);
}

/** Not frozen surface (task 1.8): the recorded sale count for an orders gate. */
const ledgerAbi = parseAbi(["function revenueLedger() view returns (uint128 reserveSkimmedMinor, uint128 reserveWithdrawnMinor, uint64 salesCount)"]);

/** Throws the mirrored failure unless the stage's gate is met as the chain counts it. */
export async function assertStageReleasable(deps: ApiDeps, stageId: string, ctx: PolicyContext, revenueMinor: bigint): Promise<void> {
  const [, , salesCount] = await deps.client.readContract({ address: deps.deployment.contracts.Treasury.address, abi: ledgerAbi, functionName: "revenueLedger" });
  const d = evaluateReleaseStage(
    { kind: "RELEASE_STAGE", origin: FOUNDER, stageId: stageId as never, salesMinor: trusted(revenueMinor.toString(), "chain"), salesCount: trusted(salesCount.toString(), "chain") },
    ctx,
  );
  if (d.verdict === "DENY") throw decisionFailure(d);
}
