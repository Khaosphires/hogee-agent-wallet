/**
 * Spend proposals (hard rule 6, D6). The caller names an invoice or a pacing slot; the SERVER derives everything else:
 *   invoice → the payee the invoice was registered for, its stored amount (Reader-extracted, so labelled untrusted),
 *             its Reader flags, its dedup hash;
 *   pacing  → the manifest's pacing amount and the line's single payable payee, the slot's sequence hash.
 * The policy (core evaluateProposal) runs on the chain-backed context with this line's in-flight payments projected
 * (core projectInFlight): AUTO, DENY or NEEDS_OFFICER. The intent id is built like the tx builder builds it.
 * A pacing line is paid at most one slot per chain day (the plan's pacing period, as the worker tick pays it; audit
 * run-4): core only orders the slots, so a later slot would otherwise be AUTO right behind an in-flight one. Here a
 * slot signed or mined that day refuses the proposal (policy-context.ts pacedToday); an unsigned one does not, and
 * the worker refuses a second slot of the day when it signs.
 */
import {
  evaluateProposal,
  hashObject,
  labeled,
  projectInFlight,
  trusted,
  type DerivedSpendProposal,
  type LineKey,
  type PolicyContext,
  type PolicyDecision,
  type SpendProposalIn,
  type Taint,
} from "@hogee/core";
import type { Hex } from "viem";
import { intentId, lineKeyToLineId, sequenceInvoiceHash, shortIdToBytes32 } from "../chain-lib";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { PolicyWorld } from "./policy-context";
import { one, pool } from "./sql";

const AGENT_ORIGIN: Taint = { trust: "trusted", sensitivity: "public" };

export interface Evaluated {
  readonly decision: PolicyDecision;
  readonly derived: DerivedSpendProposal;
  readonly proposal: SpendProposalIn;
}

export function projected(world: PolicyWorld, lineKey: LineKey, payeeId: string): PolicyContext {
  const f = world.inflight.perLine.get(lineKey) ?? { slots: 0, lineMinor: 0n };
  return projectInFlight(world.ctx, lineKey, { slots: f.slots, lineMinor: f.lineMinor.toString(), totalMinor: world.inflight.totalMinor.toString() }, payeeId);
}

function spendIn(world: PolicyWorld, x: { lineKey: LineKey; payeeId: SpendProposalIn["payeeId"]; amountMinor: SpendProposalIn["amountMinor"]; invoiceHash: Hex; basis: SpendProposalIn["basis"] }): SpendProposalIn {
  return {
    kind: "SPEND",
    origin: AGENT_ORIGIN,
    lineKey: trusted(x.lineKey as never, "agent-proposal"),
    payeeId: x.payeeId,
    amountMinor: x.amountMinor,
    invoiceHash: x.invoiceHash,
    intentId: intentId({
      planId: world.manifest.planId as Hex,
      lineId: lineKeyToLineId(x.lineKey),
      payeeId: shortIdToBytes32(x.payeeId.value),
      invoiceHash: x.invoiceHash,
      amountMinor: BigInt(x.amountMinor.value),
    }).toLowerCase() as Hex,
    planVersion: world.ctx.planVersion,
    basis: x.basis,
  };
}

export async function evaluateInvoiceSpend(deps: ApiDeps, scope: Scope, world: PolicyWorld, lineKey: LineKey, invoiceId: string): Promise<Evaluated> {
  const inv = await one<{ payee_id: string; amount_minor: string; invoice_hash: string; flags: string[]; taint: Taint }>(
    pool(deps.db),
    "select payee_id, amount_minor::text as amount_minor, invoice_hash, flags, taint from invoices where facility_id = $1 and id = $2",
    [scope.facilityId, invoiceId],
  );
  if (!inv) throw fail("NOT_FOUND", "No such invoice");
  const proposal = spendIn(world, {
    lineKey,
    payeeId: trusted(inv.payee_id as never, "invoice-registry"),
    amountMinor: labeled(inv.amount_minor as never, inv.taint, "invoice-reader"),
    invoiceHash: inv.invoice_hash.toLowerCase() as Hex,
    basis: { invoiceId, flags: inv.flags },
  });
  return { decision: evaluateProposal(proposal, projected(world, lineKey, inv.payee_id)), derived: { lineKey, payeeId: inv.payee_id, amountMinor: inv.amount_minor, invoiceId }, proposal };
}

/** The tick's code for a line whose slot of the day is taken (worker decide.ts). Not a contract error: never recordDenied. */
const ALREADY_PROPOSED_TODAY = "ALREADY_PROPOSED_TODAY";

/** An AUTO slot for a pacing line that already has its slot of the chain day is refused (module doc). */
function oncePerDay(world: PolicyWorld, lineKey: LineKey, decision: PolicyDecision): PolicyDecision {
  if (decision.verdict !== "AUTO" || !world.inflight.pacedToday.has(lineKey)) return decision;
  return { verdict: "DENY", reasonCode: ALREADY_PROPOSED_TODAY, mirrorsRevert: false };
}

export function evaluatePacingSpend(world: PolicyWorld, lineKey: LineKey, pacingSlot: number): Evaluated {
  const line = world.manifest.lines.find((l) => l.lineKey === lineKey);
  if (!line?.pacing) throw fail("NOT_FOUND", `${lineKey} is not a paced pocket in the committed plan`);
  const payable = (world.ctx.lines[lineKey]?.payeeIds ?? []).filter((id) => world.ctx.payees.some((p) => p.payeeId === id && p.lineKeys.includes(lineKey)));
  const payeeId = payable.length === 1 ? (payable[0] as string) : (line.payeeIds[0] as string);
  const proposal = spendIn(world, {
    lineKey,
    payeeId: trusted(payeeId as never, "plan-manifest"),
    amountMinor: trusted(line.pacing.amountMinor as never, "plan-manifest"),
    invoiceHash: sequenceInvoiceHash(BigInt(pacingSlot)),
    basis: { pacingSlot },
  });
  const decision = oncePerDay(world, lineKey, evaluateProposal(proposal, projected(world, lineKey, payeeId)));
  return { decision, derived: { lineKey, payeeId, amountMinor: line.pacing.amountMinor, pacingSlot }, proposal };
}

/** Deterministic rationale (same as the worker's pacing rationale): what was decided, from which facts. */
export function rationaleOf(e: Evaluated, decisionId: string): { rationale: Record<string, unknown>; rationaleHash: Hex } {
  const rationale = {
    kind: "SPEND_PROPOSAL",
    decisionId,
    proposal: e.derived,
    intentId: e.proposal.intentId,
    invoiceHash: e.proposal.invoiceHash,
    planVersion: e.proposal.planVersion,
    verdict: e.decision.verdict,
    reasonCode: e.decision.reasonCode,
  };
  return { rationale, rationaleHash: hashObject(rationale) as Hex };
}
