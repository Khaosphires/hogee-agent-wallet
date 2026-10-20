/** Handlers: exceptions, proposals, control, autonomy, evidence, webhook, eval and demo routes. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { exampleE1AttackRow, exampleInvoice, type LineKey } from "@hogee/core";
import type { Handlers } from "./http";
import { ATTACKS } from "./attacks";
import { evidenceBundle, evidenceFile, evidenceRuns } from "./evidence";
import { fiscoAnchor, fiscoFile, fiscoPacks } from "./fisco";
import { REQUESTER_HEADER, createException, denyException, founderSignatureFor, officerApprove, vetoException } from "./exceptions";
import { buildSignatureRequest } from "./signing";
import { spendRefusal } from "./spend-policy";
import { appendTrace, currentPlan, mockHash, nextId, resetState, type MockState } from "./store";
import { recordSale } from "./sales";
import { autonomyOf } from "./autonomy";
import { createScriptedPayment } from "./transitions";
import { isFailure } from "./result";

type OpsRoutes =
  | "listExceptions" | "createException" | "approveException" | "denyException" | "vetoException" | "proposeSpend"
  | "pause" | "getAutonomyStats" | "listEvidenceRuns" | "exportEvidence" | "getEvidenceRun" | "getEvidenceFile"
  | "listFiscoPacks" | "getFiscoFile" | "getFiscoAnchor"
  | "stripeWebhook" | "evalCase" | "evalPlan" | "evalShortlist" | "demoAttack" | "demoSale"
  | "demoCrashNextBroadcast" | "demoAutonomyStart" | "demoAutonomyStop" | "demoReset";

const STRIPE_TOLERANCE_S = 300;

function verifyStripeSignature(header: string, body: string, secret: string, nowS: number): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || Math.abs(nowS - t) > STRIPE_TOLERANCE_S) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return expected.length === v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

/** Server-side derivation of payee + amount (D6): from the bound invoice or the line's pacing, never the caller. */
function deriveSpend(st: MockState, lineKey: LineKey, invoiceId: string | undefined): { payeeId: string; amountMinor: string } | undefined {
  const line = currentPlan(st)?.manifest.lines.find((l) => l.lineKey === lineKey);
  if (!line) return undefined;
  if (invoiceId !== undefined) {
    return invoiceId === exampleInvoice.invoiceId ? { payeeId: exampleInvoice.payeeId, amountMinor: exampleInvoice.amountMinor } : undefined;
  }
  const payeeId = line.payeeIds[0];
  return payeeId && line.pacing ? { payeeId, amountMinor: line.pacing.amountMinor } : undefined;
}

export const opsHandlers: Pick<Handlers, OpsRoutes> = {
  listExceptions: ({ req, st }) => [...st.exceptions.values()].map((s) => s.exception).filter((e) => !req.query.status || e.status === req.query.status),

  // The MCP server marks its calls as the agent's. The header can only lower the requester to "agent" (the least
  // trusted), so sending it gains a caller nothing.
  createException: ({ req, st, c }) => createException(st, req.body, c.req.header(REQUESTER_HEADER)?.trim().toLowerCase() === "agent" ? "agent" : "founder"),

  approveException: ({ req, st, env, persona }) => {
    const se = st.exceptions.get(req.params.id);
    if (!se) return { code: "NOT_FOUND", message: `No exception ${req.params.id}` };
    if (persona === "officer") {
      const res = officerApprove(st, se, env.timelockSeconds);
      return isFailure(res) ? res : { outcome: "APPROVED", ...res };
    }
    // Founder branch: never a server signature; return what the founder must sign.
    const e = se.exception;
    if (!["OPEN", "FOUNDER_SIGNED", "APPROVED"].includes(e.status)) return { code: "CONFLICT", message: `Exception ${e.exceptionId} is ${e.status}` };
    const target = founderSignatureFor(e);
    if (!target) return { code: "FORBIDDEN", message: "This exception is decided by the loan officer" };
    const signature = buildSignatureRequest(st, { ...target, method: req.body.method ?? "passkey" });
    if (isFailure(signature)) return signature.code === "NOT_FOUND" ? signature : { code: "CONFLICT", message: signature.message };
    st.signatures.set(signature.requestId, { body: { ...target, method: req.body.method ?? "passkey" }, response: signature, submitted: false });
    return { outcome: "SIGNATURE_REQUIRED", signature };
  },

  denyException: ({ req, st }) => {
    const se = st.exceptions.get(req.params.id);
    return se ? denyException(st, se, req.body.reason) : { code: "NOT_FOUND", message: `No exception ${req.params.id}` };
  },

  vetoException: ({ req, st, persona }) => {
    const se = st.exceptions.get(req.params.id);
    return se ? vetoException(st, se, req.body.reason, persona === "officer" ? "officer" : "founder") : { code: "NOT_FOUND", message: `No exception ${req.params.id}` };
  },

  proposeSpend: ({ req, st }) => {
    const body = req.body;
    const invoiceId = "invoiceId" in body ? body.invoiceId : undefined;
    const derived = deriveSpend(st, body.lineKey, invoiceId);
    const traceId = nextId(st, "trace");
    const deny = (reasonCode: string, summary: string) => {
      appendTrace(st, { traceId, actor: "policy", kind: "DENIAL", summary, verdict: "DENY", reasonCode, refs: {} });
      return { verdict: "DENY" as const, reasonCode, traceId };
    };
    if (!derived) return { code: "NOT_FOUND", message: invoiceId ? `No bound invoice ${invoiceId}` : `${body.lineKey} has no pacing slot in the signed plan` };
    // One payment per pacing slot and per invoice: a retried intent is refused, as Treasury.spend would.
    const slot = "pacingSlot" in body ? body.pacingSlot : undefined;
    const intent = invoiceId !== undefined ? `invoice:${invoiceId}` : `${body.lineKey}:slot:${slot}`;
    if (st.usedIntents.has(intent)) {
      return invoiceId !== undefined
        ? deny("DuplicateInvoice", `Refused: invoice ${invoiceId} was already paid`)
        : deny("DuplicateIntent", `Refused: ${body.lineKey} pacing slot ${slot} was already paid`);
    }
    const refusal = spendRefusal(st, body.lineKey, derived.payeeId, derived.amountMinor);
    if (refusal) return deny(refusal.reasonCode, `Refused: ${refusal.summary}`);
    const sp = createScriptedPayment(st, { kind: "SPEND", lineKey: body.lineKey, payeeId: derived.payeeId, amountMinor: derived.amountMinor, reason: body.reason });
    st.usedIntents.add(intent);
    return { verdict: "AUTO", reasonCode: "WITHIN_PLAN", traceId: sp.payment.traceId, paymentId: sp.payment.paymentId };
  },

  pause: ({ st }) => {
    st.balances = { ...st.balances, paused: true };
    const txHash = mockHash(`tx:pause:${nextId(st, "pause")}`);
    appendTrace(st, { traceId: nextId(st, "trace"), actor: "founder", kind: "TX", summary: "Treasury paused (tighten-only, instant); queued loosenings are cancelled", refs: { txHash } });
    for (const se of st.exceptions.values()) {
      if (se.exception.status === "QUEUED" || se.exception.status === "EXECUTABLE") se.exception = { ...se.exception, status: "CANCELLED" };
    }
    return { actionId: nextId(st, "act"), state: "BROADCAST", txHash };
  },

  // The sample business counts its own records, as the live API counts its rows (autonomy.ts); the others keep their seed.
  getAutonomyStats: ({ st }) => {
    if (st.sample) return autonomyOf(st, st.sample.commitAtMs, Date.now());
    const { running: _r, lastTickMs: _l, pacingSlot: _p, ...stats } = st.autonomy;
    return stats;
  },

  listEvidenceRuns: ({ env }) => evidenceRuns(env).map((r) => r.summary),
  // The live backend builds a new bundle (task 1.16); the mock re-points to the newest recorded one.
  exportEvidence: ({ env }) => {
    const latest = evidenceRuns(env)[0];
    return latest ? { runId: latest.summary.runId } : { code: "CONFLICT", message: "No evidence bundle is available" };
  },
  getEvidenceRun: ({ req, env }) => evidenceBundle(env, req.params.runId) ?? { code: "NOT_FOUND", message: `No evidence run ${req.params.runId}` },
  getEvidenceFile: ({ req, env }) => evidenceFile(env, req.params.runId, req.params.path) ?? { code: "NOT_FOUND", message: `No file ${req.params.path}` },
  // REG-BRIEF (fisco-proof): the FISCO mirror packs of the demo's own Sepolia bundle (fisco.ts).
  listFiscoPacks: ({ env }) => fiscoPacks(env),
  getFiscoFile: async ({ req, env }) => (await fiscoFile(env, req.params.packId, req.params.path)) ?? { code: "NOT_FOUND", message: "No such file in this FISCO mirror pack" },
  getFiscoAnchor: async ({ req, env }) => (await fiscoAnchor(env, req.params.packId)) ?? { code: "NOT_FOUND", message: "This FISCO mirror pack has no Sepolia anchor" },

  stripeWebhook: ({ req, st, env }) => {
    const secret = env.stripeWebhookSecret;
    if (!secret || !verifyStripeSignature(req.headers["stripe-signature"], req.body, secret, Math.floor(Date.now() / 1000))) {
      return { code: "VALIDATION", message: "Stripe-Signature did not verify" };
    }
    const event = JSON.parse(req.body) as { id?: string; type?: string; data?: { object?: { amount_received?: number } } };
    if (!event.id) return { code: "VALIDATION", message: "Event has no id" };
    if (st.salesSeen.has(event.id)) return { duplicate: true };
    const amount = event.data?.object?.amount_received;
    if (event.type === "payment_intent.succeeded" && Number.isInteger(amount) && (amount ?? 0) > 0) recordSale(st, event.id, String(amount));
    else st.salesSeen.add(event.id);
    return {};
  },

  evalCase: ({ st }) => {
    const traceId = nextId(st, "trace");
    appendTrace(st, { traceId, actor: "policy", kind: "DENIAL", summary: `Mock E1 case ${exampleE1AttackRow.caseId}: refused`, verdict: "DENY", reasonCode: "MOCK_EVAL", refs: {} });
    return { executed: false, refusalTraceId: traceId, lossMinor: "0" };
  },
  evalPlan: ({ st }) => {
    const draft = st.loaded.scenario["plan-draft.json"];
    return { intent: draft.intent, draft, turns: 3 };
  },
  evalShortlist: ({ st }) => st.loaded.scenario["shortlist.json"],

  demoAttack: ({ req, st }) => {
    const script = ATTACKS[req.body.attackId];
    if (!script) return { code: "NOT_FOUND", message: `${req.body.attackId} is a scripted task, not an attack` };
    const traceId = nextId(st, "trace");
    const forced = script.revert ? { txHash: mockHash(`tx:${req.body.attackId}:forced:${st.counter}`), revertReason: script.revert } : undefined;
    const refusal = appendTrace(st, {
      traceId,
      actor: script.actor,
      kind: "DENIAL",
      summary: `${script.title}: ${script.refusal}`,
      verdict: "DENY",
      reasonCode: script.revert ?? script.reasonCode ?? "REFUSED",
      refs: forced ? { txHash: forced.txHash } : {},
    });
    return forced ? { refusal, forced } : { refusal };
  },

  demoSale: ({ req, st }) => {
    const paymentIntentId = `pi_mock_${nextId(st, "sale").replace(/[^a-z0-9]/g, "")}`;
    recordSale(st, paymentIntentId, req.body.amountMinor);
    return { paymentIntentId };
  },

  demoCrashNextBroadcast: ({ st }) => {
    st.crashArmed = true;
    return { armed: true };
  },
  demoAutonomyStart: ({ st }) => {
    st.autonomy = { ...st.autonomy, running: true, lastTickMs: 0, startedAt: st.autonomy.agentTxs === 0 ? new Date().toISOString().replace(/\.\d{3}Z$/, "Z") : st.autonomy.startedAt };
    return { running: true };
  },
  demoAutonomyStop: ({ st }) => {
    st.autonomy = { ...st.autonomy, running: false };
    return { running: false };
  },
  demoReset: ({ env }) => {
    resetState(env);
    return { ok: true };
  },
};
