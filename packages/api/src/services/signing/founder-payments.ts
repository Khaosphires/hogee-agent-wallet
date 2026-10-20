/**
 * Founder-signed payments (relayed by the worker; the relayer gains no authority, the contracts verify the signature):
 *   MilestoneRelease (refId = orderId): the order's first funded, unreleased non-auto milestone, for its scheduled
 *     amount, with the stored inspection evidence hash. Core evaluateReleaseMilestone must say the chain would
 *     accept it (MilestoneLocked, EvidenceMissing, PayeeCooling, … otherwise).
 *   OwnerSpend (refId = invoiceId): the manual fallback (§8.8) for a stored invoice: the payee it was registered for,
 *     its stored amount, its dedup hash, on the single line that payee is bound to. Core evaluateOwnerSpend must say
 *     the chain would accept it.
 * At submit a POLICY_OK payment row is written for the worker (agent-actions): `release:<exceptionId|requestId>` /
 * `owner:<requestId>`, with trace_id = the signature request id (which holds the signed struct and signature).
 */
import { evaluateOwnerSpend, evaluateReleaseMilestone, formatBu, hashObject, type LineKey } from "@hogee/core";
import { insertRationale } from "@hogee/db";
import type { Hex } from "viem";
import { buildOwnerSpend, buildReleaseMilestone, intentId, lineKeyToLineId, milestoneSettlementId, shortIdToBytes32 } from "../../chain-lib";
import type { ApiDeps, Scope } from "../../context";
import { fail } from "../../http/problem";
import { decisionFailure } from "../loosen";
import { uuidv7 } from "../ids";
import { policyWorld } from "../policy-context";
import { one, pool, rows } from "../sql";
import { appendTrace } from "../traces";
import { row, type SignKind } from "./kinds";
import { toViemMessage, type TypedMessage } from "./typed";

const FOUNDER = { trust: "trusted", sensitivity: "public" } as const;

interface Release {
  readonly orderId: string;
  readonly idx: number;
  readonly amountMinor: string;
  readonly evidenceHash: Hex;
  readonly payeeId: string;
}

async function releasable(deps: ApiDeps, scope: Scope, orderId: string): Promise<Release> {
  const db = pool(deps.db);
  const order = await one<{ payee_id: string }>(db, "select payee_id from escrow_orders where facility_id = $1 and order_id = $2", [scope.facilityId, orderId]);
  if (!order) throw fail("NOT_FOUND", "No such escrow order");
  const [m] = await rows<{ idx: number; amount_minor: string; evidence_hash: string | null }>(
    db,
    `select idx, amount_minor::text as amount_minor, evidence_hash from escrow_milestones
      where facility_id = $1 and order_id = $2 and not auto_release and released_minor = 0 and funded_minor >= amount_minor order by idx limit 1`,
    [scope.facilityId, orderId],
  );
  if (!m) throw fail("CONFLICT", "No milestone of this order is funded and waiting for your release");
  if (!m.evidence_hash) throw fail("CONFLICT", "Upload the inspection evidence first");
  const r: Release = { orderId, idx: Number(m.idx), amountMinor: m.amount_minor, evidenceHash: m.evidence_hash as Hex, payeeId: order.payee_id };
  const d = evaluateReleaseMilestone({ kind: "RELEASE_MILESTONE", origin: FOUNDER, orderId: orderId as never, idx: r.idx, evidenceHash: r.evidenceHash, amountMinor: r.amountMinor }, (await policyWorld(deps, scope)).ctx);
  if (d.verdict === "DENY") throw decisionFailure(d);
  return r;
}

const releaseFields = (r: Release): TypedMessage => ({ orderId: shortIdToBytes32(r.orderId), idx: String(r.idx), amountMinor: r.amountMinor, evidenceHash: r.evidenceHash.toLowerCase() });

const sameFields = (expected: TypedMessage, signed: TypedMessage) => Object.entries(expected).every(([k, v]) => signed[k] === v);

export const milestoneRelease: SignKind = {
  async prepare(deps, scope, refId) {
    const r = await releasable(deps, scope, refId);
    return {
      contract: "MilestoneEscrow",
      title: `Release milestone ${r.idx + 1} of ${r.orderId}`,
      rows: [
        row("Pays", `${formatBu(r.amountMinor)} BU from escrow to ${r.payeeId}`, "loosen"),
        row("Inspection evidence", r.evidenceHash),
        row("Order", r.orderId),
      ],
      fields: releaseFields(r),
    };
  },

  async finalize(deps, scope, req, sig) {
    const signed = req.typed_data_json.message;
    const orderId = Buffer.from(String(signed.orderId).slice(2), "hex").toString("utf8").replace(/\0+$/, "");
    const r = await releasable(deps, scope, orderId);
    if (!sameFields(releaseFields(r), signed)) throw fail("CONFLICT", "The milestone changed since you were asked to sign; request again");
    const world = await policyWorld(deps, scope);
    return {
      call: buildReleaseMilestone({ release: toViemMessage("MilestoneRelease", signed), founder: sig }),
      async commit(q) {
        const exc = await one<{ id: string }>(
          q,
          "select id from exceptions where facility_id = $1 and kind = 'RELEASE_ESCROW_BALANCE' and status = 'OPEN' and payload->>'orderId' = $2 and (payload->>'idx')::int = $3",
          [scope.facilityId, r.orderId, r.idx],
        );
        if (exc) await q.query("update exceptions set status = 'APPROVED', updated_at = now() where facility_id = $1 and id = $2 and status = 'OPEN'", [scope.facilityId, exc.id]);
        const paymentId = `release:${exc?.id ?? req.id}`;
        const decisionId = uuidv7();
        const rationale = { kind: "FOUNDER_MILESTONE_RELEASE", decisionId, signatureRequestId: req.id, orderId: r.orderId, idx: r.idx, amountMinor: r.amountMinor, evidenceHash: r.evidenceHash };
        const rationaleHash = hashObject(rationale);
        await q.query(
          `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, order_id, milestone_idx, amount_minor, invoice_hash, plan_version, state, decision_id, rationale_hash, trace_id)
           values ($1, $2, 'RELEASE_MILESTONE', $3, 'SUPPLIER', $4, $5, $6, $7, $8, $9, $10, 'POLICY_OK', $11, $12, $13)`,
          [paymentId, scope.facilityId, milestoneSettlementId(shortIdToBytes32(r.orderId), r.idx).toLowerCase(), lineKeyToLineId("SUPPLIER"), r.payeeId, r.orderId, r.idx, r.amountMinor, r.evidenceHash.toLowerCase(), world.ctx.planVersion, decisionId, rationaleHash, req.id],
        );
        await insertRationale(q, { facilityId: scope.facilityId, rationaleHash, decisionId, rationale });
        await appendTrace(q, { facilityId: scope.facilityId, traceId: req.id, actor: "founder", kind: "SIGNATURE", summary: `Founder released milestone ${r.idx + 1} of ${r.orderId}; queued for the relayer`, refs: { paymentId, decisionId } });
        return { actionId: paymentId, state: "PENDING" };
      },
    };
  },
};

interface OwnerSpendPlan {
  readonly lineKey: LineKey;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly intentId: Hex;
}

async function ownerSpendPlan(deps: ApiDeps, scope: Scope, invoiceId: string): Promise<OwnerSpendPlan> {
  const inv = await one<{ payee_id: string; amount_minor: string; invoice_hash: string }>(
    pool(deps.db),
    "select payee_id, amount_minor::text as amount_minor, invoice_hash from invoices where facility_id = $1 and id = $2",
    [scope.facilityId, invoiceId],
  );
  if (!inv) throw fail("NOT_FOUND", "No such invoice");
  const world = await policyWorld(deps, scope);
  const lines = world.ctx.payees.filter((p) => p.payeeId === inv.payee_id).flatMap((p) => p.lineKeys);
  if (lines.length !== 1) throw fail("CONFLICT", lines.length === 0 ? "That payee is not bound to any pocket" : "That payee is bound to several pockets");
  const lineKey = lines[0] as LineKey;
  const invoiceHash = inv.invoice_hash.toLowerCase() as Hex;
  const id = intentId({ planId: world.manifest.planId as Hex, lineId: lineKeyToLineId(lineKey), payeeId: shortIdToBytes32(inv.payee_id), invoiceHash, amountMinor: BigInt(inv.amount_minor) }).toLowerCase() as Hex;
  const plan: OwnerSpendPlan = { lineKey, payeeId: inv.payee_id, amountMinor: inv.amount_minor, invoiceHash, intentId: id };
  const d = evaluateOwnerSpend({ lineKey: lineKey as never, payeeId: plan.payeeId as never, amountMinor: plan.amountMinor, invoiceHash, intentId: id }, world.ctx);
  if (d.verdict === "DENY") throw decisionFailure(d);
  return plan;
}

const ownerFields = (o: OwnerSpendPlan): TypedMessage => ({ lineId: lineKeyToLineId(o.lineKey), payeeId: shortIdToBytes32(o.payeeId), amountMinor: o.amountMinor, invoiceHash: o.invoiceHash });

export const ownerSpend: SignKind = {
  async prepare(deps, scope, refId) {
    const o = await ownerSpendPlan(deps, scope, refId);
    return {
      contract: "Treasury",
      title: "Pay an invoice yourself (manual fallback)",
      rows: [row("Pays", `${formatBu(o.amountMinor)} BU to ${o.payeeId}`, "loosen"), row("From pocket", o.lineKey), row("Invoice", refId)],
      fields: ownerFields(o),
    };
  },

  async finalize(deps, scope, req, sig) {
    const o = await ownerSpendPlan(deps, scope, req.ref_id);
    const signed = req.typed_data_json.message;
    if (!sameFields(ownerFields(o), signed)) throw fail("CONFLICT", "The invoice or plan changed since you were asked to sign; request again");
    const world = await policyWorld(deps, scope);
    return {
      call: buildOwnerSpend({ req: toViemMessage("OwnerSpend", signed), founder: sig }),
      async commit(q) {
        const paymentId = `owner:${req.id}`;
        await q.query(
          `insert into payments (id, facility_id, kind, intent_id, line_key, line_id, payee_id, amount_minor, invoice_hash, plan_version, state, trace_id)
           values ($1, $2, 'OWNER_SPEND', $3, $4, $5, $6, $7, $8, $9, 'POLICY_OK', $10)`,
          [paymentId, scope.facilityId, o.intentId, o.lineKey, lineKeyToLineId(o.lineKey), o.payeeId, o.amountMinor, o.invoiceHash, world.ctx.planVersion, req.id],
        );
        await appendTrace(q, { facilityId: scope.facilityId, traceId: req.id, actor: "founder", kind: "SIGNATURE", summary: `Founder signed a manual payment of ${o.amountMinor} minor to ${o.payeeId}; queued for the relayer`, refs: { paymentId } });
        return { actionId: paymentId, state: "PENDING" };
      },
    };
  },
};
