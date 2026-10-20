/**
 * §26.1 steps through the live API routes (and the worker via pump), as the UI drives them; only the model is
 * scripted. Each step returns what the evidence needs (action ids, tx hashes, trace ids). Also the few DB reads the
 * cases need (the API has no route for them: chain action rows, payment rows, the latest trace of a kind).
 */
import { randomBytes } from "node:crypto";
import { EnrolmentCodeResult } from "@hogee/api-contract";
import {
  ChainAction,
  exampleShortlistSpec,
  PasskeyRegistrationOptions,
  PasskeyRegistrationResult,
  PendingFounderKey,
  SignatureRequestResponse,
  SpendProposalResult,
  type PlanIntent,
} from "@hogee/core";
import { keccak256, toHex, type Hex } from "viem";
import { toolCall } from "./api-internals";
import { expectOk, Transcript } from "./actions";
import type { Persona, Stack } from "./stack";

export const b64uToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

export interface Http {
  readonly t: Transcript;
  get(who: Persona, label: string, path: string): Promise<{ status: number; json: unknown }>;
  post(who: Persona, label: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

export function http(t: Transcript = new Transcript()): Http {
  return {
    t,
    get: (who, label, path) => t.call(label, "GET", path, who.get(path)),
    post: (who, label, path, body) => t.call(label, "POST", path, who.post(path, body), body),
  };
}

// ---- DB reads -------------------------------------------------------------------------------------

export interface ActionRow {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly txHash: Hex | null;
  readonly revertReason: string | null;
}

export async function actionRow(s: Stack, id: string): Promise<ActionRow | null> {
  const r = await s.db.$client.query<{ id: string; kind: string; state: string; tx_hash: string | null; revert_reason: string | null }>(
    "select id, kind, state, tx_hash, revert_reason from chain_actions where facility_id = $1 and id = $2",
    [s.facilityId, id],
  );
  const x = r.rows[0];
  return x ? { id: x.id, kind: x.kind, state: x.state, txHash: (x.tx_hash as Hex | null) ?? null, revertReason: x.revert_reason } : null;
}

/** The latest product action of `kind` (forced red-team sends, ref_id redteam:*, are never it). */
export async function latestAction(s: Stack, kind: string, refId?: string): Promise<ActionRow | null> {
  const r = await s.db.$client.query<{ id: string }>(
    `select id from chain_actions where facility_id = $1 and kind = $2 and coalesce(ref_id, '') not like 'redteam:%' ${refId ? "and ref_id = $3" : ""} order by created_at desc limit 1`,
    refId ? [s.facilityId, kind, refId] : [s.facilityId, kind],
  );
  return r.rows[0] ? actionRow(s, r.rows[0].id) : null;
}

export async function actionsSince(s: Stack, kind: string, since: Date): Promise<ActionRow[]> {
  const r = await s.db.$client.query<{ id: string }>("select id from chain_actions where facility_id = $1 and kind = $2 and created_at >= $3 order by created_at", [s.facilityId, kind, since]);
  const out: ActionRow[] = [];
  for (const x of r.rows) {
    const a = await actionRow(s, x.id);
    if (a) out.push(a);
  }
  return out;
}

export interface PaymentRow {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly txHash: Hex | null;
  readonly lineKey: string | null;
  readonly payeeId: string;
  readonly amountMinor: string;
  readonly invoiceHash: Hex;
  readonly intentId: Hex;
  readonly decisionId: string | null;
  readonly traceId: string;
  readonly orderId: string | null;
  readonly milestoneIdx: number | null;
  readonly payoutId: string | null;
}

export async function paymentRows(s: Stack, where = "true", values: unknown[] = []): Promise<PaymentRow[]> {
  const r = await s.db.$client.query(
    `select id, kind, state, tx_hash, line_key, payee_id, amount_minor::text as amount_minor, invoice_hash, intent_id, decision_id, trace_id, order_id,
            milestone_idx, payout_id from payments where facility_id = $1 and (${where}) order by created_at, id`,
    [s.facilityId, ...values],
  );
  return r.rows.map((x) => ({
    id: x.id,
    kind: x.kind,
    state: x.state,
    txHash: x.tx_hash,
    lineKey: x.line_key,
    payeeId: x.payee_id,
    amountMinor: x.amount_minor,
    invoiceHash: x.invoice_hash,
    intentId: x.intent_id,
    decisionId: x.decision_id,
    traceId: x.trace_id,
    orderId: x.order_id,
    milestoneIdx: x.milestone_idx === null ? null : Number(x.milestone_idx),
    payoutId: x.payout_id,
  }));
}

export async function payment(s: Stack, id: string): Promise<PaymentRow | null> {
  return (await paymentRows(s, "id = $2", [id]))[0] ?? null;
}

/** The latest trace event matching `where` (e.g. reason_code = 'EXTERNAL_AGENT_KEY_USE'). */
export async function latestTrace(s: Stack, where: string, values: unknown[] = []): Promise<{ traceId: string; summary: string; reasonCode: string | null } | null> {
  const r = await s.db.$client.query<{ trace_id: string; summary: string; reason_code: string | null }>(
    `select trace_id, summary, reason_code from traces where facility_id = $1 and (${where}) order by ts desc, seq desc limit 1`,
    [s.facilityId, ...values],
  );
  const x = r.rows[0];
  return x ? { traceId: x.trace_id, summary: x.summary, reasonCode: x.reason_code } : null;
}

let invoiceSeq = 0;

/**
 * Registers an invoice the way an ingestion step would (there is no ingestion route yet; the API's live tests do the
 * same): a payee, an amount and a dedup hash, with untrusted taint (the values came from a document).
 */
export async function registerInvoice(s: Stack, o: { payeeId: string; amountMinor: string; flags?: string[]; label?: string }): Promise<{ id: string; invoiceHash: Hex }> {
  invoiceSeq += 1;
  const id = `inv-rt-${(o.label ?? "x").toLowerCase().replace(/[^a-z0-9-]/g, "")}-${invoiceSeq}-${Date.now().toString(36)}`;
  const invoiceHash = keccak256(toHex(`${s.facilityId}:${id}`));
  await s.db.$client.query(
    `insert into invoices (id, facility_id, payee_id, amount_minor, invoice_hash, extracted_fields_json, taint, flags, received_at)
     values ($1, $2, $3, $4, $5, '{}'::jsonb, '{"trust":"untrusted","sensitivity":"public"}'::jsonb, $6, now())`,
    [id, s.facilityId, o.payeeId, o.amountMinor, invoiceHash, o.flags ?? []],
  );
  return { id, invoiceHash };
}

// ---- §26.1 steps ------------------------------------------------------------------------------------

export interface Step0 {
  readonly openActionId: string;
  readonly registerActionId: string;
  /** The first-come probes before the real registration (G2, run-4 lead 5), and the registration's trace. */
  readonly enrolment: {
    readonly guessBeforeIssue: EnrolmentProbe;
    readonly wrongCode: EnrolmentProbe;
    readonly noCode: EnrolmentProbe;
    readonly registrationTraceId: string | null;
  };
}

export interface EnrolmentProbe {
  readonly status: number;
  readonly response: unknown;
}

const PASSKEY_OPTIONS = "/api/passkey/register/options";
/** A well-formed code nobody issued (the 24-character base64url shape of EnrolmentCode). */
const guessedCode = (): string => randomBytes(18).toString("base64url");
/** The officer's code is never written into the bundle (the API never traces it either); the transcript says so. */
const NOT_RECORDED = "<the loan officer's one-time code: not recorded>";

/**
 * Step 0: the officer opens the facility and issues a one-time enrolment code; the founder registers a passkey with
 * it; the officer reads the pending key and approves exactly it. Before the real registration, three attempts to take
 * the founder's key slot without the officer's code (a guessed code before any was issued, a wrong code, no code) are
 * recorded: G2 made enrolment code-gated instead of first-come (security-audit run-4 lead 5).
 */
export async function openAndRegister(s: Stack, h: Http): Promise<Step0> {
  const open = expectOk<ChainAction>(await h.post(s.officer, "open facility", "/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 }), "open facility");
  await s.pump();
  const probe = async (label: string, body: unknown): Promise<EnrolmentProbe> => {
    const r = await h.post(s.founder, label, PASSKEY_OPTIONS, body);
    return { status: r.status, response: r.json };
  };
  const guessBeforeIssue = await probe("passkey options with a guessed code, before any code was issued (refused)", { enrolmentCode: guessedCode() });
  const issuedRes = await s.officer.post("/api/officer/founder-key/enrolment-code");
  const issuedJson = (await issuedRes.json()) as unknown;
  h.t.entries.push({ label: "enrolment code", method: "POST", path: "/api/officer/founder-key/enrolment-code", status: issuedRes.status, response: issuedRes.ok ? { code: NOT_RECORDED } : issuedJson });
  const issued = EnrolmentCodeResult.parse(expectOk({ status: issuedRes.status, json: issuedJson }, "enrolment code"));
  const wrongCode = await probe("passkey options with a wrong code (refused)", { enrolmentCode: guessedCode() });
  const noCode = await probe("passkey options without a code (refused)", {});
  const optsRes = await s.founder.post(PASSKEY_OPTIONS, { enrolmentCode: issued.code });
  const optsJson = (await optsRes.json()) as unknown;
  h.t.entries.push({ label: "passkey options", method: "POST", path: PASSKEY_OPTIONS, body: { enrolmentCode: NOT_RECORDED }, status: optsRes.status, response: optsJson });
  const opts = PasskeyRegistrationOptions.parse(expectOk({ status: optsRes.status, json: optsJson }, "passkey options"));
  const reg = PasskeyRegistrationResult.parse(expectOk(await h.post(s.founder, "passkey verify", "/api/passkey/register/verify", s.auth.register(opts.challenge)), "passkey verify"));
  // The officer approves the key the API holds as pending (the console's view), and only if it is the one just registered.
  const pending = PendingFounderKey.nullable().parse(expectOk(await h.get(s.officer, "pending founder key", "/api/officer/founder-key/pending"), "pending founder key"));
  if (!pending || pending.credentialId !== reg.credentialId || pending.qx !== reg.qx || pending.qy !== reg.qy) throw new Error("the pending founder key is not the key the founder just registered");
  const approve = expectOk<ChainAction>(
    await h.post(s.officer, "approve founder key", "/api/officer/founder-key/approve", { founderId: s.founderId, credentialId: pending.credentialId, qx: pending.qx, qy: pending.qy }),
    "approve founder key",
  );
  await s.pump();
  const registered = await latestTrace(s, "kind = 'SIGNATURE' and actor = 'founder' and summary like 'Founder registered a passkey%'");
  return { openActionId: open.actionId, registerActionId: approve.actionId, enrolment: { guessBeforeIssue, wrongCode, noCode, registrationTraceId: registered?.traceId ?? null } };
}

/**
 * Steps 1–2 in one turn: the planner (scripted model, real guard) proposes the intent; code compiles the draft. The
 * intent and the founder's message are the world's country's (Rina's for MY, Mei's for SG) unless given.
 */
export async function chatToDraft(s: Stack, h: Http, sessionId: string, intent: PlanIntent = s.country.planIntent, message: string = s.country.chatMessage): Promise<string> {
  s.agent.queue(toolCall("proposePlanIntent", intent));
  const res = await s.founder.post("/api/chat", { sessionId, message });
  const text = await res.text();
  h.t.entries.push({ label: "chat", method: "POST", path: "/api/chat", body: { sessionId, message }, status: res.status, response: text.slice(0, 4000) });
  if (!res.ok) throw new Error(`chat: HTTP ${res.status} ${text.slice(0, 300)}`);
  const part = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as { type: string; data?: { draftId?: string } })
    .find((c) => c.type === "data-plan-draft");
  const draftId = part?.data?.draftId;
  if (!draftId) throw new Error("the chat turn produced no plan draft");
  return draftId;
}

/** Requests a founder signature, signs it with the passkey and submits it; returns the request and the submit response. */
export async function founderSigns(s: Stack, h: Http, kind: string, refId: string): Promise<{ req: SignatureRequestResponse; submit: { status: number; json: unknown } }> {
  const req = SignatureRequestResponse.parse(expectOk(await h.post(s.founder, `request ${kind}`, "/api/signatures/request", { kind, refId, method: "passkey" }), `request ${kind}`));
  const submit = await h.post(s.founder, `submit ${kind}`, `/api/signatures/${req.requestId}/submit`, { passkey: s.auth.assert(b64uToBytes(req.challengeB64url)) });
  return { req, submit };
}

/** Step 3: Rina signs the plan with her passkey; the relayer submits commitPlan. */
export async function signPlan(s: Stack, h: Http, draftId: string): Promise<{ requestId: string; actionId: string }> {
  const { req, submit } = await founderSigns(s, h, "PlanApproval", draftId);
  const action = expectOk<ChainAction>(submit, "submit PlanApproval");
  await s.pump();
  return { requestId: req.requestId, actionId: action.actionId };
}

export async function fundFacility(s: Stack, h: Http, amountMinor: string): Promise<{ status: number; json: unknown }> {
  const r = await h.post(s.officer, "fund", "/api/facility/fund", { amountMinor });
  await s.pump();
  return r;
}

export async function shortlist(s: Stack, h: Http): Promise<{ requestId: string; shortlist: unknown }> {
  const { requestId } = expectOk<{ requestId: string }>(await h.post(s.founder, "shortlist", "/api/suppliers/shortlist", { spec: exampleShortlistSpec }), "shortlist");
  const r = expectOk<unknown>(await h.get(s.founder, "shortlist result", `/api/suppliers/shortlist/${requestId}`), "shortlist result");
  return { requestId, shortlist: r };
}

export async function propose(s: Stack, h: Http, label: string, body: unknown): Promise<SpendProposalResult> {
  return SpendProposalResult.parse(expectOk(await h.post(s.anon, label, "/api/proposals/spend", body), label));
}

export async function balances(s: Stack, h: Http, label = "balances"): Promise<{ fundedMinor: string; releasedMinor: string; revenueMinor: string; reserveMinor: string; escrowMinor: string; paused: boolean; drift: string; pockets: { lineKey: string; spent: string; available: string; paused: boolean; circuitOpen: boolean; perTxCap: string; windowCap: string }[] }> {
  return expectOk(await h.get(s.founder, label, "/api/balances"), label);
}

/** The founder asks for a loosening/release in the exception console; returns the exception id. */
export async function createException(s: Stack, h: Http, kind: string, payload: unknown, reason: string): Promise<string> {
  return expectOk<{ exceptionId: string }>(await h.post(s.founder, `exception ${kind}`, "/api/exceptions", { kind, payload, reason }), `exception ${kind}`).exceptionId;
}

/** Founder approval of a timelocked exception = a LoosenRequest signature request, signed with the passkey and submitted. */
export async function founderApproves(s: Stack, h: Http, exceptionId: string): Promise<void> {
  const r = expectOk<{ signature: SignatureRequestResponse }>(await h.post(s.founder, "founder approves", `/api/exceptions/${exceptionId}/approve`, {}), "founder approves");
  const sig = SignatureRequestResponse.parse(r.signature);
  expectOk(await h.post(s.founder, "submit LoosenRequest", `/api/signatures/${sig.requestId}/submit`, { passkey: s.auth.assert(b64uToBytes(sig.challengeB64url)) }), "submit LoosenRequest");
}

export async function officerApproves(s: Stack, h: Http, exceptionId: string): Promise<unknown> {
  const r = expectOk(await h.post(s.officer, "officer approves", `/api/exceptions/${exceptionId}/approve`, {}), "officer approves");
  await s.pump();
  return r;
}

export async function exceptionRow(s: Stack, id: string): Promise<{ status: string; loosenId: string | null; traceId: string | null }> {
  const r = await s.db.$client.query<{ status: string; loosen_id: string | null; trace_id: string | null }>("select status, loosen_id, trace_id from exceptions where facility_id = $1 and id = $2", [s.facilityId, id]);
  const x = r.rows[0];
  if (!x) throw new Error(`no exception ${id}`);
  return { status: x.status, loosenId: x.loosen_id, traceId: x.trace_id };
}
