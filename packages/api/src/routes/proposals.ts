/**
 * POST /api/proposals/spend (DEMO_MODE; the MCP-wrapper demo of the agent proposing a payment). Hard rule 6: the body
 * names an invoice or a pacing slot only (strict schema); payee and amount are derived by the server and checked by
 * the policy with in-flight payments counted. Outcomes:
 *   AUTO          → a POLICY_OK SPEND row with its decision and rationale hash; the worker re-checks, signs, sends;
 *   DENY          → no payment; an invoice the chain would refuse is recorded (denials row + recordDenied for the
 *                   worker's agent key: the circuit breaker counts it), unless the refusal is the treasury's state
 *                   (STATE_REASONS); a pacing refusal is only traced;
 *   NEEDS_OFFICER → a POLICY_ESCALATION exception holding the server-derived proposal (the only way one is created).
 *                   While one for the same derived proposal is OPEN, its trace is returned and nothing is written
 *                   (run-7 re-check L1: no duplicate rows, and no named traces, for a repeated flagged invoice).
 */
import type { SpendProposal, SpendProposalResult } from "@hogee/core";
import { insertRationale } from "@hogee/db";
import type { ApiDeps, Scope } from "../context";
import { decisionIdToBytes32, lineKeyToLineId, reasonCodeToBytes32 } from "../chain-lib";
import type { RouteGroup } from "../http/register";
import { insertAction, wake } from "../services/actions";
import { newId, uuidv7 } from "../services/ids";
import { policyWorld } from "../services/policy-context";
import { evaluateInvoiceSpend, evaluatePacingSpend, rationaleOf, type Evaluated } from "../services/spend-proposal";
import { inTx, one, type Q } from "../services/sql";
import { appendTrace } from "../services/traces";
import { lockWriter } from "../services/writer-bounds";

const REASON_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/**
 * Refusals that describe the treasury's state, not the agent (core pacing.ts WORKER RULE): never anchored with
 * recordDenied, or a pause or an expired line would trip the line's circuit (3 per window). CircuitOpen, NotAgent and
 * AgentExpired would also revert recordDenied itself.
 */
const STATE_REASONS: ReadonlySet<string> = new Set(["Paused", "CircuitOpen", "LineExpired", "AgentExpired", "NotAgent"]);

export const recordsDenial = (e: Evaluated): boolean =>
  e.decision.verdict === "DENY" && e.derived.invoiceId !== undefined && e.decision.mirrorsRevert === true && REASON_RE.test(e.decision.reasonCode) && !STATE_REASONS.has(e.decision.reasonCode);

/** The trace of the OPEN escalation that holds exactly this server-derived proposal (jsonb equality), if any. */
async function openEscalation(q: Q, scope: Scope, derived: Evaluated["derived"]): Promise<string | undefined> {
  const r = await one<{ trace_id: string }>(
    q,
    `select trace_id from exceptions where facility_id = $1 and kind = 'POLICY_ESCALATION' and status = 'OPEN' and trace_id is not null
        and payload = $2::jsonb order by created_at, id limit 1`,
    [scope.facilityId, JSON.stringify({ proposal: derived })],
  );
  return r?.trace_id;
}

/** Treasury.CIRCUIT_THRESHOLD: three anchored denials on a line inside its window open the line's circuit. */
export const CIRCUIT_THRESHOLD = 3;

/**
 * Audit run-7 re-check: the circuit only counts denials the chain has seen, so a burst could record any number while
 * their recordDenied actions wait for the relay. A line never has more than CIRCUIT_THRESHOLD in flight; past that
 * the newest in-flight denial's trace is returned and nothing is written (the chain opens the circuit on those).
 */
async function inFlightDenial(q: Q, scope: Scope, lineId: string): Promise<string | undefined> {
  const rows = (await q.query<{ trace_id: string }>(
    `select d.trace_id from denials d join chain_actions c on c.facility_id = d.facility_id and c.kind = 'Treasury.recordDenied' and c.ref_id = d.id
      where d.facility_id = $1 and c.state in ('PENDING', 'BROADCAST') and c.request_json->>'lineId' = $2
      order by d.created_at desc, d.id collate "C" desc`,
    [scope.facilityId, lineId],
  )).rows;
  return rows.length >= CIRCUIT_THRESHOLD ? rows[0]?.trace_id : undefined;
}

async function propose(deps: ApiDeps, scope: Scope, body: SpendProposal): Promise<SpendProposalResult> {
  const world = await policyWorld(deps, scope);
  const e: Evaluated = "invoiceId" in body ? await evaluateInvoiceSpend(deps, scope, world, body.lineKey, body.invoiceId) : evaluatePacingSpend(world, body.lineKey, body.pacingSlot);
  const decisionId = uuidv7();
  const traceId = newId("trace");
  const { rationale, rationaleHash } = rationaleOf(e, decisionId);
  const { verdict, reasonCode } = e.decision;
  const what = `${e.derived.lineKey}: ${e.derived.amountMinor} minor to ${e.derived.payeeId}${e.derived.invoiceId ? ` (invoice ${e.derived.invoiceId})` : ` (pacing slot ${e.derived.pacingSlot})`}`;
  const paymentId = verdict === "AUTO" ? newId("pay") : undefined;
  const tracedAs = await inTx(deps.db, async (q) => {
    if (verdict === "NEEDS_OFFICER") {
      await lockWriter(q, "escalations", scope.facilityId);
      const open = await openEscalation(q, scope, e.derived);
      if (open) return open;
    }
    if (recordsDenial(e)) {
      await lockWriter(q, "denials", scope.facilityId);
      const pending = await inFlightDenial(q, scope, lineKeyToLineId(e.derived.lineKey));
      if (pending) return pending;
    }
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId,
      actor: "policy",
      kind: "POLICY_VERDICT",
      verdict,
      reasonCode,
      summary: `Spend proposal ${what} → ${verdict} (${reasonCode})`,
      refs: { decisionId, invoiceHash: e.proposal.invoiceHash, ...(paymentId ? { paymentId } : {}), planVersion: e.proposal.planVersion },
    });
    if (verdict === "AUTO" && paymentId) {
      await q.query(
        `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state, decision_id, rationale_hash, trace_id)
         values ($1, $2, 'SPEND', $3, $4, $5, $6, $7, $8, $9, 'POLICY_OK', $10, $11, $12)`,
        [paymentId, scope.facilityId, e.proposal.intentId, e.derived.lineKey, lineKeyToLineId(e.derived.lineKey), e.derived.payeeId, e.derived.amountMinor, e.proposal.invoiceHash, e.proposal.planVersion, decisionId, rationaleHash, traceId],
      );
      await insertRationale(q, { facilityId: scope.facilityId, rationaleHash, decisionId, rationale });
    } else if (verdict === "NEEDS_OFFICER") {
      await q.query(
        `insert into exceptions (id, facility_id, kind, title, payload, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id)
         values ($1, $2, 'POLICY_ESCALATION', 'Review a flagged payment', $3::jsonb, 'agent', false, true, 'OPEN', $4, $5)`,
        [newId("exc"), scope.facilityId, JSON.stringify({ proposal: e.derived }), e.derived.amountMinor, traceId],
      );
    } else if (recordsDenial(e)) {
      const denialId = newId("den");
      const proposalHash = rationaleHash;
      await q.query(
        "insert into denials (id, facility_id, decision_id, proposal_json, proposal_hash, reason, reason_code, trace_id) values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)",
        [denialId, scope.facilityId, decisionId, JSON.stringify(rationale), proposalHash, `Refused: ${reasonCode}`, reasonCode, traceId],
      );
      await insertRationale(q, { facilityId: scope.facilityId, rationaleHash: proposalHash, decisionId, rationale });
      await insertAction(q, {
        facilityId: scope.facilityId,
        kind: "Treasury.recordDenied",
        refId: denialId,
        request: { denialId, lineId: lineKeyToLineId(e.derived.lineKey), decisionId: decisionIdToBytes32(decisionId), reasonCode: reasonCodeToBytes32(reasonCode), proposalHash },
      });
    }
    return traceId;
  });
  if (verdict === "AUTO") await wake(deps, "agent-actions");
  if (verdict === "DENY") await wake(deps, "relay");
  return { verdict, reasonCode, traceId: tracedAs, ...(paymentId ? { paymentId } : {}) };
}

export const proposalRoutes: RouteGroup = {
  proposeSpend: ({ req, deps, scope }) => propose(deps, scope, req.body),
};
