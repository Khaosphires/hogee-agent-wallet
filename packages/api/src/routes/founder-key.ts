/**
 * The loan officer's side of founder-key enrolment (G2, closes security-audit run-4 lead 5; P2's pending-key request).
 *   GET  /api/officer/founder-key/pending → the key awaiting review {credentialId, qx, qy, createdAt}, or null.
 *   POST /api/officer/founder-key/enrolment-code → {code, expiresAt}: a one-time code (services/enrolment.ts) the
 *     officer hands the founder; issuing revokes the previous open code.
 *   POST /api/officer/founder-key/reject {credentialId} → the pending key is REJECTED and the slot is free for a new
 *     enrolment. Never a key registered on-chain (FounderKeyAlreadySet), and never one whose approval is already a
 *     chain action (CONFLICT): the worker may be signing it, and only a REVERTED approval is out of the way.
 */
import type { PendingFounderKey } from "@hogee/core";
import { lockFounder, rejectPendingFounderKey } from "@hogee/db";
import type { RejectFounderKeyResult } from "@hogee/api-contract";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { liveAction } from "../services/actions";
import { founderKeyOnChain } from "../services/chain";
import { issueCode } from "../services/enrolment";
import { newId } from "../services/ids";
import { inTx, one, pool } from "../services/sql";
import { appendTrace } from "../services/traces";
import { alreadySet, requireFounder } from "./passkey";

async function pending(deps: ApiDeps, scope: Scope): Promise<PendingFounderKey | null> {
  const f = await one<{ passkey_credential_id: string | null; qx: string | null; qy: string | null; key_status: string; passkey_registered_at: Date | null; updated_at: Date }>(
    pool(deps.db),
    "select passkey_credential_id, qx, qy, key_status, passkey_registered_at, updated_at from founders where facility_id = $1 and id = $2",
    [scope.facilityId, scope.founderId],
  );
  if (!f || f.key_status !== "PENDING_LENDER" || !f.passkey_credential_id || !f.qx || !f.qy) return null;
  // A key registered before G2 has no registration time; its row's last update is the closest record.
  const createdAt = (f.passkey_registered_at ?? f.updated_at).toISOString();
  return { credentialId: f.passkey_credential_id, qx: f.qx as PendingFounderKey["qx"], qy: f.qy as PendingFounderKey["qy"], createdAt };
}

async function issue(deps: ApiDeps, scope: Scope) {
  await requireFounder(deps, scope);
  return issueCode(deps, scope);
}

async function reject(deps: ApiDeps, scope: Scope, credentialId: string): Promise<RejectFounderKeyResult> {
  const founder = await requireFounder(deps, scope);
  if (founder.key_status === "REGISTERED" || (await founderKeyOnChain(deps)).set) throw alreadySet("A key registered on-chain is never rejected");
  if (founder.passkey_credential_id !== credentialId) throw fail("NOT_FOUND", "No pending founder key with that credential");
  await inTx(deps.db, async (q) => {
    await lockFounder(q, scope.facilityId, scope.founderId);
    if (await liveAction(q, scope.facilityId, "PlanRegistry.registerFounderKey", scope.founderId)) {
      throw fail("CONFLICT", "This key is already approved and on its way to the chain; it can no longer be rejected");
    }
    const rejected = await rejectPendingFounderKey(q, { facilityId: scope.facilityId, founderId: scope.founderId, credentialId, now: new Date(deps.clock()) });
    if (!rejected) throw fail("NOT_FOUND", "No pending founder key with that credential");
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "officer",
      kind: "SIGNATURE",
      summary: "Loan officer rejected the founder's pending passkey; it can never be approved, and a new enrolment needs a new code",
    });
  });
  return { credentialId, status: "REJECTED" };
}

export const founderKeyRoutes: RouteGroup = {
  getPendingFounderKey: ({ deps, scope }) => pending(deps, scope),
  issueEnrolmentCode: ({ deps, scope }) => issue(deps, scope),
  rejectFounderKey: ({ req, deps, scope }) => reject(deps, scope, req.body.credentialId),
};
