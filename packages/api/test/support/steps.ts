/** §26.1 steps as reusable test helpers, each going through the live API (and the worker via pump). */
import { ChainAction, PasskeyRegistrationOptions, PasskeyRegistrationResult, SignatureRequestResponse, examplePlanIntent, type PlanIntent } from "@hogee/core";
import { EnrolmentCodeResult } from "@hogee/api-contract";
import { expect } from "vitest";
import { toolCall, type ScriptedAgent } from "./agent";
import { SoftAuthenticator } from "./authenticator";
import type { World } from "./world";

export async function json<T>(res: Response, schema?: { parse(v: unknown): T }): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const body = JSON.parse(text) as unknown;
  return schema ? schema.parse(body) : (body as T);
}

/** G2: the officer issues a one-time enrolment code (handed to the founder out of band). */
export async function issueEnrolmentCode(w: World): Promise<string> {
  return (await json(await w.officer.post("/api/officer/founder-key/enrolment-code"), EnrolmentCodeResult)).code;
}

/** The founder registers `auth` with `code` (options → verify); the response of verify. */
export async function registerWith(w: World, auth: SoftAuthenticator, code: string): Promise<Response> {
  const opts = await json(await w.founder.post("/api/passkey/register/options", { enrolmentCode: code }), PasskeyRegistrationOptions);
  return w.founder.post("/api/passkey/register/verify", auth.register(opts.challenge));
}

/** Step 0: the officer opens the facility and issues an enrolment code; the founder registers a passkey with it; the officer approves it; it lands. */
export async function openAndRegister(w: World, auth = new SoftAuthenticator()): Promise<SoftAuthenticator> {
  await json(await w.officer.post("/api/facility/open", { capMinor: "1000000", reserveFloorBps: 300 }), ChainAction);
  await w.pump();
  const code = await issueEnrolmentCode(w);
  const opts = await json(await w.founder.post("/api/passkey/register/options", { enrolmentCode: code }), PasskeyRegistrationOptions);
  const reg = await json(await w.founder.post("/api/passkey/register/verify", auth.register(opts.challenge)), PasskeyRegistrationResult);
  await json(await w.officer.post("/api/officer/founder-key/approve", { founderId: w.founderId, credentialId: reg.credentialId, qx: reg.qx, qy: reg.qy }), ChainAction);
  await w.pump();
  return auth;
}

export interface StreamChunk {
  readonly type: string;
  readonly [k: string]: unknown;
}

/** The chunks of an AI SDK UI-message stream (SSE `data:` lines). */
export async function streamChunks(res: Response): Promise<StreamChunk[]> {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)) as StreamChunk);
}

export function expectOk(res: Response): void {
  expect(res.status, `HTTP ${res.status}`).toBeLessThan(300);
}

/**
 * Step 1–2 in one turn: the founder states product, channel, sourcing and budget; the planner proposes the intent.
 * After a committed plan (a replan), VISION-DECISIONS §9 routes free text through the chat router first: it classifies
 * the message as `plan`, which hands it to the planner.
 */
export async function chatToDraft(w: World, agent: ScriptedAgent, sessionId: string, intent: PlanIntent = examplePlanIntent): Promise<string> {
  const committed = await w.live.db.$client.query("select 1 from plans where facility_id = $1 and status = 'COMMITTED' limit 1", [w.facilityId]);
  if (committed.rows.length > 0) agent.queue(toolCall("chooseSkill", { skill: "plan", candidateRanks: null, cfoView: null }));
  agent.queue(toolCall("proposePlanIntent", intent));
  const chunks = await streamChunks(
    await w.founder.post("/api/chat", { sessionId, message: "Malaysian citizen. Custom insulated tumblers (food contact) on Shopee, from China, budget RM10,000." }),
  );
  const part = chunks.find((c) => c.type === "data-plan-draft");
  if (!part) throw new Error(`no draft: ${JSON.stringify(chunks).slice(0, 400)}`);
  return (part.data as { draftId: string }).draftId;
}

export const b64uToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

/** Step 3: request the PlanApproval, sign it with the passkey, submit, and let the worker commit it. */
export async function signPlan(w: World, auth: SoftAuthenticator, draftId: string): Promise<SignatureRequestResponse> {
  const req = await json(await w.founder.post("/api/signatures/request", { kind: "PlanApproval", refId: draftId, method: "passkey" }), SignatureRequestResponse);
  await json(await w.founder.post(`/api/signatures/${req.requestId}/submit`, { passkey: auth.assert(b64uToBytes(req.challengeB64url)) }), ChainAction);
  await w.pump();
  return req;
}
