/**
 * The one line under Ready to spend (first-timer #11, #16), pure so it is unit-tested: what is coming, from the signed
 * plan's stages and the chain's own totals, never hard-coded. Before a plan: how the wallet opens; before the loan
 * officer adds money: that it is on its way; with a release waiting on sales: how much more and after what.
 */
import type { Balances, PlanRecord } from "@hogee/core";
import { bu } from "../../lib/format";
import { nextRelease } from "../../lib/money";

export function readyLine(plan: Pick<PlanRecord, "status" | "manifest"> | undefined, balances: Pick<Balances, "fundedMinor" | "releasedMinor"> | null, noPlan: boolean): string {
  if (noPlan || plan?.status !== "COMMITTED") return "Opens when your plan is signed and funded.";
  if (balances && balances.fundedMinor === "0") return `Your loan officer is adding ${bu(balances.releasedMinor)} next.`;
  const next = balances ? nextRelease(plan.manifest.stages, balances.releasedMinor) : null;
  if (next) return `${bu(next.releaseMinor)} more after ${bu(next.targetMinor)} in sales.`;
  return "Yours to use now, inside your plan's limits.";
}
