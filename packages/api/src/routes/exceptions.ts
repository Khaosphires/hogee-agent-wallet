/**
 * §26.1 step 10 (hard rule 3): the exception console.
 *
 * create (founder): never POLICY_ESCALATION (422: only the server's spend path opens one). Since G2 ExceptionCreate has
 *   no such variant, so schema validation refuses it before this handler; the check here is defence in depth.
 *   Requirements, title and blast radius come from code; a loosening the chain would refuse is refused now with the
 *   mirrored error. `x-hogee-requester: agent` (sent by apps/mcp) records the request as the agent's (run-8 re-check):
 *   the header can only lower the requester to the agent, never raise it.
 * approve: the officer branch runs iff the VERIFIED persona is "officer" (signed cookie; anything else reads as the
 *   founder). Officer: a loosening needs the founder's signature first (then the parked queueLoosen proceeds and the
 *   worker co-signs with the lender key); a stage release needs its gate met on-chain; an escalation is approved as an
 *   officer override (the worker re-checks payee and caps when it executes). Founder: a signature request.
 * deny (officer) is terminal; veto (any persona) cancels a timelocked loosening before it executes. The veto locks the
 *   exception row and decides from the status it moved (audit run-4): a veto that commits right after the officer's
 *   approval still queues the cancelLoosen; the worker reconciles the veto with the chain (relay-calls.ts, sync-veto.ts).
 */
import type { Exception, ExceptionCreate, ExceptionKind, ExceptionStatus, SignMethod } from "@hogee/core";
import type { ApproveExceptionResult } from "@hogee/api-contract";
import type { Context } from "hono";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { insertAction, liveAction, wake } from "../services/actions";
import { committedPlanRow } from "../services/plans";
import { exceptionRows, isTimelockKind, requireException, requiresOf, titleOf, toException, type ExceptionRow } from "../services/exceptions";
import { assertLoosenAllowed, assertStageReleasable } from "../services/loosen";
import { blastRadiusOf, checkCreate, escrowReleaseStillRefusal } from "../services/exception-create";
import { requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import { policyWorld } from "../services/policy-context";
import { inTx, pool, rows } from "../services/sql";
import { appendTrace } from "../services/traces";
import { decideException, lockWriter } from "../services/writer-bounds";
import { requestSignature } from "./signatures";

async function reload(deps: ApiDeps, scope: Scope, id: string): Promise<Exception> {
  return toException(await requireException(pool(deps.db), scope, id));
}

/** Kinds only the server opens (proposals.ts), never a request. */
const SERVER_ONLY_KINDS: ReadonlySet<ExceptionKind> = new Set(["POLICY_ESCALATION"]);

/** Sent by apps/mcp on every call (REQUESTER_HEADERS), as api-mock reads it. */
const REQUESTER_HEADER = "x-hogee-requester";

/** Who opens a request on the founder's session: the agent (through MCP) when the header says so, else the founder. */
type Requester = "founder" | "agent";
const REQUESTER_LABEL: Readonly<Record<Requester, { readonly actor: "founder" | "planner"; readonly label: string }>> = {
  founder: { actor: "founder", label: "Founder" },
  agent: { actor: "planner", label: "Agent" },
};

/** The header can only lower the requester to the agent; any other value (or none) is the founder, never more. */
const requesterOf = (c: Context): Requester => (c.req.header(REQUESTER_HEADER)?.trim().toLowerCase() === "agent" ? "agent" : "founder");

async function createException(deps: ApiDeps, scope: Scope, body: ExceptionCreate, requester: Requester): Promise<Exception> {
  // Defence in depth (G2): the schema no longer admits this kind, but a schema that re-admitted it is still refused here.
  if (SERVER_ONLY_KINDS.has(body.kind)) throw fail("VALIDATION", "A policy escalation is opened only by the server's own spend checks");
  const db = pool(deps.db);
  await requireFacility(db, scope);
  if (!(await committedPlanRow(db, scope))) throw fail("CONFLICT", "No plan is committed yet");
  const world = await policyWorld(deps, scope);
  const row = { kind: body.kind, payload: body.payload as Record<string, unknown> };
  await checkCreate(deps, scope, row, world);
  const id = newId("exc");
  const traceId = newId("trace");
  const requires = requiresOf(body.kind);
  const blast = await blastRadiusOf(deps, scope, row, world);
  const stored = await inTx(deps.db, async (q) => {
    // Audit run-7 (services/writer-bounds.ts): the same OPEN founder request is returned again, and at most
    // MAX_OPEN_FOUNDER_EXCEPTIONS are OPEN per facility. jsonb equality ignores key order. The agent's requests are made
    // on the founder's session, so they count against the same bound and are reused like the founder's own.
    await lockWriter(q, "founder-exceptions", scope.facilityId);
    const [dup] = await rows<{ id: string }>(
      q,
      "select id from exceptions where facility_id = $1 and requested_by in ('founder', 'agent') and status = 'OPEN' and kind = $2 and payload = $3::jsonb order by created_at desc, id limit 1",
      [scope.facilityId, body.kind, JSON.stringify(body.payload)],
    );
    const [open] = await rows<{ n: number }>(q, "select count(*)::int as n from exceptions where facility_id = $1 and requested_by in ('founder', 'agent') and status = 'OPEN'", [scope.facilityId]);
    const d = decideException(dup?.id, open?.n ?? 0);
    if ("reuse" in d) return d.reuse;
    if ("refuse" in d) throw fail("CONFLICT", d.refuse);
    await q.query(
      `insert into exceptions (id, facility_id, kind, title, payload, reason, requested_by, requires_founder, requires_lender, status, blast_radius_minor, trace_id)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, 'OPEN', $10, $11)`,
      [id, scope.facilityId, body.kind, titleOf(body.kind, row.payload), JSON.stringify(body.payload), body.reason, requester, requires.founder, requires.lender, blast.toString(), traceId],
    );
    const who = REQUESTER_LABEL[requester];
    await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: who.actor, kind: "EXCEPTION", summary: `${who.label} requested: ${titleOf(body.kind, row.payload)}`, refs: { exceptionId: id } });
    return id;
  });
  return reload(deps, scope, stored);
}

async function officerApprove(deps: ApiDeps, scope: Scope, e: ExceptionRow): Promise<ApproveExceptionResult> {
  const traceId = e.trace_id ?? newId("trace");
  if (isTimelockKind(e.kind)) {
    if (e.status === "OPEN") throw fail("CONFLICT", "The founder has not signed this loosening yet");
    if (e.status !== "FOUNDER_SIGNED") throw fail("CONFLICT", `This request is ${e.status.toLowerCase()}`);
    await assertLoosenAllowed(deps, e, (await policyWorld(deps, scope)).ctx);
    const action = await liveAction(pool(deps.db), scope.facilityId, "Treasury.queueLoosen", e.id);
    if (!action) throw fail("CONFLICT", "The founder's signed request is missing");
    await decide(deps, scope, e, "APPROVED", ["FOUNDER_SIGNED"], traceId, "Loan officer approved the loosening; the lender key co-signs and the timelock starts");
    await wake(deps, "relay");
    return { outcome: "APPROVED", exception: await reload(deps, scope, e.id), action };
  }
  if (e.status !== "OPEN") throw fail("CONFLICT", `This request is ${e.status.toLowerCase()}`);
  if (e.kind === "RELEASE_STAGE") {
    const world = await policyWorld(deps, scope);
    await assertStageReleasable(deps, String(e.payload.stageId), world.ctx, world.snapshot.balances.revenueMinor);
    const action = await inTx(deps.db, async (q) => {
      // Like decide(): a deny or another approval that committed since the read above moved the row, so nothing is signed.
      const moved = await q.query("update exceptions set status = 'APPROVED', updated_at = now() where facility_id = $1 and id = $2 and status = 'OPEN'", [scope.facilityId, e.id]);
      if (moved.rowCount !== 1) throw fail("CONFLICT", "This request changed meanwhile; reload it");
      await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "officer", kind: "EXCEPTION", verdict: "NEEDS_OFFICER", summary: "Loan officer approved the stage release; the lender key signs it", refs: { exceptionId: e.id } });
      return insertAction(q, { facilityId: scope.facilityId, kind: "Treasury.releaseStage", refId: e.id, request: { exceptionId: e.id, stageId: e.payload.stageId } });
    });
    await wake(deps, "relay");
    return { outcome: "APPROVED", exception: await reload(deps, scope, e.id), action };
  }
  if (e.kind === "POLICY_ESCALATION") {
    // Traced as an OVERRIDE, never as "within plan"; the worker re-checks payee and caps before it pays.
    await decide(deps, scope, e, "APPROVED", ["OPEN"], traceId, "OFFICER OVERRIDE: the loan officer approved a flagged payment (re-checked against payee and caps before paying)");
    await wake(deps, "agent-actions");
    return { outcome: "APPROVED", exception: await reload(deps, scope, e.id) };
  }
  throw fail("CONFLICT", "This request needs the founder's signature, not the loan officer's");
}

async function decide(deps: ApiDeps, scope: Scope, e: ExceptionRow, to: ExceptionStatus, from: readonly ExceptionStatus[], traceId: string, summary: string, reason?: string): Promise<void> {
  await inTx(deps.db, async (q) => {
    const moved = await q.query(
      "update exceptions set status = $3, decision_reason = coalesce($5, decision_reason), updated_at = now() where facility_id = $1 and id = $2 and status = any($4::exception_status[])",
      [scope.facilityId, e.id, to, from, reason ?? null],
    );
    if (moved.rowCount !== 1) throw fail("CONFLICT", "This request changed meanwhile; reload it");
    await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "officer", kind: "EXCEPTION", summary, refs: { exceptionId: e.id } });
  });
}

async function founderApprove(deps: ApiDeps, scope: Scope, e: ExceptionRow, method: SignMethod): Promise<ApproveExceptionResult> {
  if (e.kind === "RELEASE_STAGE" || e.kind === "POLICY_ESCALATION") throw fail("FORBIDDEN", "The loan officer decides this request");
  if (e.status !== "OPEN") throw fail("CONFLICT", `This request is ${e.status.toLowerCase()}`);
  if (isTimelockKind(e.kind)) return { outcome: "SIGNATURE_REQUIRED", signature: await requestSignature(deps, scope, "LoosenRequest", e.id, method) };
  if (e.kind === "REPLAN") return { outcome: "SIGNATURE_REQUIRED", signature: await requestSignature(deps, scope, "PlanApproval", String(e.payload.draftId), method) };
  // The check code the officer was shown must still be the inspection the release signs (rcfix-officer follow-up).
  const refusal = await escrowReleaseStillRefusal(deps, scope, e.payload);
  if (refusal) throw fail("CONFLICT", refusal);
  return { outcome: "SIGNATURE_REQUIRED", signature: await requestSignature(deps, scope, "MilestoneRelease", String(e.payload.orderId), method) };
}

const VETOABLE: readonly ExceptionStatus[] = ["FOUNDER_SIGNED", "APPROVED", "QUEUED", "EXECUTABLE"];

async function veto(deps: ApiDeps, scope: Scope, id: string, reason: string, persona: string): Promise<Exception> {
  const e = await requireException(pool(deps.db), scope, id);
  if (!isTimelockKind(e.kind)) throw fail("CONFLICT", "Only a timelocked loosening can be vetoed");
  if (!VETOABLE.includes(e.status)) throw fail("CONFLICT", `This request is ${e.status.toLowerCase()}`);
  const traceId = e.trace_id ?? newId("trace");
  await inTx(deps.db, async (q) => {
    // The cancel decision comes from the row as locked here, never from the read above (audit run-4): an officer
    // approval that committed in between may already have let the relay co-sign and broadcast the queueLoosen.
    const locked = await q.query<{ status: ExceptionStatus; loosen_id: string | null }>("select status, loosen_id from exceptions where facility_id = $1 and id = $2 for update", [scope.facilityId, id]);
    const row = locked.rows[0];
    if (!row || !VETOABLE.includes(row.status)) throw fail("CONFLICT", "This request changed meanwhile; reload it");
    await q.query("update exceptions set status = 'CANCELLED', decision_reason = $3, updated_at = now() where facility_id = $1 and id = $2", [scope.facilityId, id, reason]);
    await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: persona === "officer" ? "officer" : "founder", kind: "EXCEPTION", summary: "Loosening vetoed within the timelock", refs: { exceptionId: id } });
    if (row.loosen_id && row.status !== "FOUNDER_SIGNED") {
      await insertAction(q, { facilityId: scope.facilityId, kind: "Treasury.cancelLoosen", refId: id, request: { exceptionId: id, loosenId: row.loosen_id } });
    }
  });
  await wake(deps, "relay");
  return reload(deps, scope, id);
}

async function deny(deps: ApiDeps, scope: Scope, id: string, reason: string): Promise<Exception> {
  const e = await requireException(pool(deps.db), scope, id);
  await decide(deps, scope, e, "DENIED", ["OPEN", "FOUNDER_SIGNED"], e.trace_id ?? newId("trace"), "Loan officer denied the request", reason);
  await wake(deps, "relay"); // a parked queueLoosen is refused (never co-signed)
  return reload(deps, scope, id);
}

export const exceptionRoutes: RouteGroup = {
  listExceptions: async ({ req, deps, scope }) => (await exceptionRows(pool(deps.db), scope, req.query.status)).map(toException),
  createException: ({ req, deps, scope, c }) => createException(deps, scope, req.body, requesterOf(c)),
  approveException: async ({ req, deps, scope, persona }) => {
    const e = await requireException(pool(deps.db), scope, req.params.id);
    return persona === "officer" ? officerApprove(deps, scope, e) : founderApprove(deps, scope, e, req.body.method ?? "passkey");
  },
  denyException: ({ req, deps, scope }) => deny(deps, scope, req.params.id, req.body.reason),
  vetoException: ({ req, deps, scope, persona }) => veto(deps, scope, req.params.id, req.body.reason, persona),
};
