/**
 * §26.1 steps 5–6: supplier shortlist, supplier records, escrow schedules and inspection evidence. Everything is
 * facility-scoped. The shortlist is computed in-request from fixtures and checks (no model reads listing text here;
 * the scorer flags imperative text in listings deterministically, T11).
 */
import type { EscrowSchedule, OrderId, ShortlistSpec, SupplierWithEvidence } from "@hogee/core";
import type { SupplierWithOrder } from "@hogee/api-contract";
import { keccak256 } from "viem";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { MAX_UPLOAD_BYTES, type RouteGroup } from "../http/register";
import { chainNow } from "../services/chain";
import { requireServerCountry } from "../services/compile";
import { requireFacility } from "../services/facility";
import { newId } from "../services/ids";
import { computeShortlist, shortlistRow, shortlistView, storeSuppliers, supersedeOldShortlists } from "../services/shortlist";
import { inTx, one, pool, rows, type Q } from "../services/sql";
import { appendTrace } from "../services/traces";
import {
  MAX_OPEN_SHORTLISTS,
  SHORTLIST_WINDOW_S,
  decideShortlist,
  decideUpload,
  inspectionTraceId,
  lockWriter,
  serialized,
  type WriteDecision,
} from "../services/writer-bounds";

const UPLOAD_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** Run-7 bound (services/writer-bounds.ts): reuse an identical recent shortlist. A new spec is never refused (re-check M2). */
async function shortlistDecision(q: Q, scope: Scope, spec: ShortlistSpec): Promise<WriteDecision> {
  const [reusable] = await rows<{ id: string }>(
    q,
    `select id from shortlists where facility_id = $1 and source = 'catalog' and created_at > now() - make_interval(secs => $2)
        and spec_json = $3::jsonb and status in ('PENDING', 'READY') order by created_at desc, id desc limit 1`,
    [scope.facilityId, SHORTLIST_WINDOW_S, JSON.stringify(spec)],
  );
  return decideShortlist(reusable?.id);
}

async function startShortlist(deps: ApiDeps, scope: Scope, spec: ShortlistSpec): Promise<{ requestId: string }> {
  const facility = await requireFacility(pool(deps.db), scope);
  // Audit run-8 (SG-DESIGN fail-open 3): the landed cost applies this server's country pack in the facility's currency,
  // so the server, the founder and the facility must be one country, exactly as compileEnv requires. Refused before
  // anything is priced, reused or stored.
  await requireServerCountry(deps, pool(deps.db), scope, facility, "nothing was priced");
  // Re-check L3: one start per facility at a time, so concurrent starts cannot all pass the reuse check below and each
  // run the outside checks. The decision is made again under the transaction lock before anything is stored.
  return serialized(`shortlist:${scope.facilityId}`, async () => {
    const early = await shortlistDecision(pool(deps.db), scope, spec);
    if ("reuse" in early) return { requestId: early.reuse };
    const requestId = newId("sl");
    // The outside checks run first, holding no pooled client; the transaction below only stores what they produced.
    const { fixtures, outcome: out } = await computeShortlist(deps, facility.currency, requestId, spec);
    return inTx(deps.db, async (q) => {
      await lockWriter(q, "shortlists", scope.facilityId);
      const d = await shortlistDecision(q, scope, spec);
      if ("reuse" in d) return { requestId: d.reuse };
      await q.query("insert into shortlists (id, facility_id, status, spec_json) values ($1, $2, 'PENDING', $3::jsonb)", [requestId, scope.facilityId, JSON.stringify(spec)]);
      await storeSuppliers(q, scope, fixtures);
      if (out.shortlist) {
        await q.query("update shortlists set status = 'READY', result_json = $3::jsonb, shortlist_hash = $4, weights_version = $5, updated_at = now() where facility_id = $1 and id = $2", [
          scope.facilityId,
          requestId,
          JSON.stringify(out.shortlist),
          out.shortlist.shortlistHash,
          out.shortlist.weightsVersion,
        ]);
      } else {
        await q.query("update shortlists set status = 'FAILED', error = $3, updated_at = now() where facility_id = $1 and id = $2", [scope.facilityId, requestId, out.error ?? "failed"]);
      }
      await supersedeOldShortlists(q, scope, "catalog", MAX_OPEN_SHORTLISTS);
      await appendTrace(q, {
        facilityId: scope.facilityId,
        traceId: requestId,
        actor: "reader",
        kind: "TOOL_CALL",
        summary: out.shortlist ? `Shortlist ready: ${out.shortlist.candidates.length} ranked, ${out.shortlist.excluded.length} excluded by hard gates` : "Shortlist failed closed: a supplier check could not run or a listing could not be read",
      });
      return { requestId };
    });
  });
}

async function getShortlist(deps: ApiDeps, scope: Scope, id: string) {
  const r = await shortlistRow(pool(deps.db), scope, id);
  if (!r) throw fail("NOT_FOUND", "No such shortlist");
  return shortlistView(r);
}

/** G2 (P2 request): the supplier's newest escrow order (SupplierApproval writes it at submit), or null before any. */
async function latestOrderId(deps: ApiDeps, scope: Scope, supplierId: string): Promise<OrderId | null> {
  const r = await one<{ order_id: string }>(
    pool(deps.db),
    "select order_id from escrow_orders where facility_id = $1 and supplier_id = $2 order by created_at desc, order_id desc limit 1",
    [scope.facilityId, supplierId],
  );
  return (r?.order_id as OrderId | undefined) ?? null;
}

async function getSupplier(deps: ApiDeps, scope: Scope, id: string): Promise<SupplierWithOrder> {
  const db = pool(deps.db);
  const s = await one<{ record_json: Record<string, unknown> }>(db, "select record_json from suppliers where facility_id = $1 and supplier_id = $2", [scope.facilityId, id]);
  if (!s) throw fail("NOT_FOUND", "No such supplier");
  const ev = await rows<{ evidence_id: string; criterion: string; tier: string; source_type: string; source_url: string | null; snippet_hash: string | null; value: unknown; taint: unknown }>(
    db,
    "select evidence_id, criterion, tier, source_type, source_url, snippet_hash, value, taint from supplier_evidence where facility_id = $1 and supplier_id = $2 order by evidence_id",
    [scope.facilityId, id],
  );
  const withEvidence = {
    ...(s.record_json as SupplierWithEvidence),
    evidence: ev.map((e) => ({ evidenceId: e.evidence_id, supplierId: id, criterion: e.criterion, tier: e.tier, sourceType: e.source_type, sourceUrl: e.source_url, snippetHash: e.snippet_hash, value: e.value, taint: e.taint })),
  } as SupplierWithEvidence;
  return { ...withEvidence, orderId: await latestOrderId(deps, scope, id) };
}

async function getEscrow(deps: ApiDeps, scope: Scope, orderId: string): Promise<EscrowSchedule> {
  const ms = await rows<{ idx: number; amount_minor: string; funded_minor: string; released_minor: string; auto_release: boolean; evidence_hash: string | null }>(
    pool(deps.db),
    `select idx, amount_minor::text as amount_minor, funded_minor::text as funded_minor, released_minor::text as released_minor, auto_release, evidence_hash
       from escrow_milestones where facility_id = $1 and order_id = $2 order by idx`,
    [scope.facilityId, orderId],
  );
  if (ms.length === 0) throw fail("NOT_FOUND", "No such escrow order");
  return ms.map((m) => ({
    idx: Number(m.idx),
    amountMinor: m.amount_minor,
    funded: m.funded_minor,
    released: BigInt(m.released_minor) > 0n,
    autoRelease: m.auto_release,
    ...(m.evidence_hash ? { evidenceHash: m.evidence_hash as `0x${string}` } : {}),
  }));
}

/**
 * The inspection report's keccak256 goes on the first milestone that needs the founder's release (not autoRelease).
 * The hash is part of the MilestoneRelease the founder signs, so it is frozen once a release is being signed (an
 * unexpired PENDING request for the order) or has been signed (a live RELEASE_MILESTONE payment for the milestone):
 * the founder persona is anyone, and a later upload would otherwise void the founder's signature.
 */
/**
 * The milestone an upload may set ($1 facility, $2 order, $3 chain now): the first unreleased one needing the founder's
 * release, unless a release holds it. A request counts while unexpired in chain time, as submit judges it.
 */
const WAITING_FOR_EVIDENCE = `m.facility_id = $1 and m.order_id = $2 and m.idx = (
    select min(idx) from escrow_milestones where facility_id = $1 and order_id = $2 and not auto_release and released_minor = 0)
  and not exists (
    select 1 from payments p where p.facility_id = $1 and p.kind = 'RELEASE_MILESTONE' and p.order_id = $2
       and p.milestone_idx = m.idx and p.state not in ('POLICY_DENIED', 'REVERTED', 'CANCELLED'))
  and not exists (
    select 1 from signature_requests s where s.facility_id = $1 and s.kind = 'MilestoneRelease' and s.ref_id = $2
       and s.status = 'PENDING' and s.expires_at >= $3)`;

const NO_MILESTONE = "No escrow milestone of that order is waiting for inspection evidence (or its release is already being signed)";

/**
 * Run-7 bounds (services/writer-bounds.ts): a re-upload of the stored hash writes nothing. A new hash is always stored
 * (the latest upload wins, re-check M1), and only the first MAX_UPLOADS_PER_MILESTONE uploads plus one final event are
 * traced. The milestone row is locked, so concurrent uploads decide one at a time.
 */
async function uploadInspection(deps: ApiDeps, scope: Scope, orderId: string, file: Blob): Promise<{ evidenceHash: `0x${string}` }> {
  if (file.size === 0) throw fail("VALIDATION", "The file is empty");
  if (file.size > MAX_UPLOAD_BYTES) throw fail("VALIDATION", "The file is too large");
  if (!UPLOAD_TYPES.has(file.type)) throw fail("VALIDATION", "Upload a PDF, JPEG or PNG inspection report");
  const now = (await chainNow(deps)).toString();
  // Refuse before hashing the whole file; the transaction below re-checks the same condition.
  const waiting = await one(pool(deps.db), `select 1 from escrow_milestones m where ${WAITING_FOR_EVIDENCE}`, [scope.facilityId, orderId, now]);
  if (!waiting) throw fail("NOT_FOUND", NO_MILESTONE);
  const evidenceHash = keccak256(new Uint8Array(await file.arrayBuffer()));
  const recorded = await inTx(deps.db, async (q) => {
    const [m] = await rows<{ idx: number; evidence_hash: string | null }>(q, `select m.idx, m.evidence_hash from escrow_milestones m where ${WAITING_FOR_EVIDENCE} for update`, [scope.facilityId, orderId, now]);
    if (!m) return false;
    const traceId = inspectionTraceId(orderId, Number(m.idx));
    const [n] = await rows<{ n: number }>(q, "select count(*)::int as n from traces where facility_id = $1 and trace_id = $2", [scope.facilityId, traceId]);
    const d = decideUpload(m.evidence_hash, evidenceHash, n?.n ?? 0);
    if ("unchanged" in d) return true;
    await q.query("update escrow_milestones set evidence_hash = $4, updated_at = now() where facility_id = $1 and order_id = $2 and idx = $3", [scope.facilityId, orderId, m.idx, evidenceHash]);
    const recordedFor = `Inspection evidence recorded for ${orderId}, milestone ${Number(m.idx)}`;
    if (d.trace === "recorded") await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "founder", kind: "PROPOSAL", summary: recordedFor });
    if (d.trace === "last") {
      const summary = `${recordedFor}; further uploads of this milestone replace the stored hash but are not traced`;
      await appendTrace(q, { facilityId: scope.facilityId, traceId, actor: "founder", kind: "PROPOSAL", summary });
    }
    return true;
  });
  if (!recorded) throw fail("NOT_FOUND", NO_MILESTONE);
  return { evidenceHash };
}

export const supplierRoutes: RouteGroup = {
  shortlistSuppliers: ({ req, deps, scope }) => startShortlist(deps, scope, req.body.spec),
  getShortlist: ({ req, deps, scope }) => getShortlist(deps, scope, req.params.id),
  getSupplier: ({ req, deps, scope }) => getSupplier(deps, scope, req.params.id),
  getEscrow: ({ req, deps, scope }) => getEscrow(deps, scope, req.params.orderId),
  uploadInspection: ({ req, deps, scope }) => uploadInspection(deps, scope, req.params.orderId, req.body.file),
};
