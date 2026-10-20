/** Handlers: session, chat, plans, passkey, facility, signing, suppliers, escrow, dashboard reads. */
import { createPublicKey } from "node:crypto";
import { setCookie } from "hono/cookie";
import { officerTokenMatches, signPersonaCookie, PERSONA_COOKIE_OPTIONS, PERSONA_COOKIE_MAX_TTL_SECONDS } from "@hogee/api";
import {
  CHAT_HISTORY_WINDOW,
  PERSONA_COOKIE,
  examplePasskeyRegistrationResult,
  parseMinor,
  sha256Bytes,
  type Hex32,
  type PasskeyRegistrationResult,
} from "@hogee/core";
import type { Handlers } from "./http";
import { streamChatTurn } from "./chat";
import { mockChatAction } from "./journey/index";
import { baseDraftIdOf, previewCountry } from "./country";
import { buildSignatureRequest, submitSignature } from "./signing";
import { p256PublicKey } from "./signature-check";
import { recordInspection, supplierWithOrder } from "./supplier-order";
import { addMinor, appendTrace, chatHistory, compareTraces, currentPlan, mockHash, nextId, openChat, sessionFor, type FounderKey, type MockState } from "./store";
import { isFailure } from "./result";

type CoreRoutes =
  | "getSession" | "setPersona" | "getHealth" | "chat" | "getChat" | "draftPlan" | "previewCountry" | "getCurrentPlan"
  | "listPlanVersions" | "passkeyRegisterOptions" | "passkeyRegisterVerify" | "approveFounderKey" | "openFacility"
  | "fundFacility" | "requestSignature" | "submitSignature" | "shortlistSuppliers" | "getShortlist" | "getSupplier"
  | "getEscrow" | "uploadInspection" | "getBalances" | "listPayments" | "getPayment" | "listTraces" | "getTrace";

const PAGE_SIZE = 50;
const SHORTLIST_DELAY_MS = 2_500;

/** The pending/registered founder key; seeded with the core example so the contract example round-trips. */
function founderKeys(st: MockState): Map<string, FounderKey> {
  if (st.founderKeys.size === 0) {
    st.founderKeys.set(examplePasskeyRegistrationResult.credentialId, { ...examplePasskeyRegistrationResult, founderId: st.baseSession.founderId });
  }
  return st.founderKeys;
}

const hex32Of = (b64url: string | undefined): string => `0x${Buffer.from(b64url ?? "", "base64url").toString("hex").padStart(64, "0")}`;

/**
 * The P-256 public key (x, y) of the SPKI DER that @simplewebauthn/browser returns as response.publicKey, or undefined
 * unless it parses as a P-256 key whose point registerFounderKey would accept (p256PublicKey: on the curve, both
 * coordinates below p). The chain refuses any other key, and an approved one would leave the founder unable to sign.
 */
export function keyFromSpki(spkiB64url: unknown): { qx: string; qy: string } | undefined {
  if (typeof spkiB64url !== "string") return undefined;
  try {
    const spki = createPublicKey({ key: Buffer.from(spkiB64url, "base64url"), format: "der", type: "spki" });
    if (spki.asymmetricKeyType !== "ec" || spki.asymmetricKeyDetails?.namedCurve !== "prime256v1") return undefined;
    const { x, y } = spki.export({ format: "jwk" });
    const key = { qx: hex32Of(x), qy: hex32Of(y) };
    return p256PublicKey(key) ? key : undefined;
  } catch {
    return undefined; // not DER SPKI, or a point off the curve (node refuses to read it)
  }
}

/**
 * The officer's funding (POST /api/facility/fund): credited up to the facility cap and the plan total; the mock clamps
 * instead of reverting so the demo can re-run. Returns the (mock) transaction hash.
 */
export function fundFacilityWith(st: MockState, amountMinor: string): Hex32 {
  const total = parseMinor(currentPlan(st)?.manifest.totalMinor ?? st.facility.capMinor);
  const cap = parseMinor(st.facility.capMinor);
  const ceiling = total < cap ? total : cap;
  const funded = parseMinor(st.balances.fundedMinor);
  const want = parseMinor(amountMinor);
  const credit = funded + want > ceiling ? (ceiling > funded ? ceiling - funded : 0n) : want;
  st.balances = { ...st.balances, fundedMinor: addMinor(st.balances.fundedMinor, credit) };
  const txHash = mockHash(`tx:fund:${nextId(st, "fund")}`);
  appendTrace(st, { traceId: nextId(st, "trace"), actor: "officer", kind: "TX", summary: credit > 0n ? "Loan officer funded the facility" : "Funding request: the facility is already funded to its cap", refs: { txHash } });
  return txHash;
}

export const coreHandlers: Pick<Handlers, CoreRoutes> = {
  getSession: ({ st, env, persona }) => sessionFor(st, env, persona),

  setPersona: ({ req, st, env, c }) => {
    const body = req.body;
    if (!env.cookieSecret) return { code: "FORBIDDEN", message: env.cookieSecretError ?? "PERSONA_COOKIE_SECRET is not configured" };
    if (body.persona === "officer" && !officerTokenMatches(body.officerToken, env.officerToken)) {
      return { code: "FORBIDDEN", message: "Officer access code not accepted" };
    }
    // SG-DECISIONS Q1: the only founder is HOGEE_COUNTRY's (SG founder:mei, MY founder:rina); no cookie for the other.
    if (body.persona !== "officer" && body.persona !== st.profile.founderPersona) {
      return { code: "FORBIDDEN", message: `${body.persona} is not this demo's founder (HOGEE_COUNTRY=${st.profile.country}: ${st.profile.founderPersona})` };
    }
    const value = signPersonaCookie(body.persona, { secret: env.cookieSecret, officerToken: env.officerToken, now: Date.now() });
    setCookie(c, PERSONA_COOKIE, value, { ...PERSONA_COOKIE_OPTIONS, maxAge: PERSONA_COOKIE_MAX_TTL_SECONDS });
    return c.json(sessionFor(st, env, body.persona));
  },

  getHealth: () => ({ db: "degraded", chain: "degraded", presidio: "degraded", llm: "degraded", payoutRail: "degraded" }),

  // VISION-DECISIONS §5: a button's structured action goes to the mock journey (v-chat-server; refused until then).
  chat: ({ req, st }) =>
    "action" in req.body ? mockChatAction(st, req.body.sessionId, req.body.action) : streamChatTurn(st, req.body.sessionId, req.body.message),

  // A read, never a write (run-10 v-6): in the lived scenario a session not started yet reads as the sample business's
  // history, which is neither stored nor counted; its first POST starts it with that history (store.ts chatHistory).
  getChat: ({ req, st }) => {
    const messages = chatHistory(st, req.params.sessionId);
    return messages ? messages.slice(-CHAT_HISTORY_WINDOW) : { code: "NOT_FOUND", message: "No chat with this session id yet" };
  },

  // A POST: starts the session if new, a lived one with the sample's history (store.ts openChat), as a chat turn would.
  draftPlan: ({ req, st }) => {
    openChat(st, req.body.sessionId);
    return st.loaded.scenario["plan-draft.json"];
  },

  previewCountry: ({ req, st }) => {
    const base = st.drafts.get(baseDraftIdOf(req.body.draftId));
    if (!base) return { code: "NOT_FOUND", message: `No plan draft ${req.body.draftId}` };
    const preview = previewCountry(base, req.body.country);
    st.drafts.set(preview.draftId, preview);
    return preview;
  },

  getCurrentPlan: ({ st }) => currentPlan(st) ?? { code: "NOT_FOUND", message: "No plan has been committed yet" },
  listPlanVersions: ({ st }) => [...st.plans].sort((a, b) => a.manifest.version - b.manifest.version),

  passkeyRegisterOptions: ({ st }) => ({
    rp: { name: "Hogee", id: "localhost" },
    user: { id: Buffer.from(st.baseSession.founderId).toString("base64url"), name: st.profile.founderName.toLowerCase(), displayName: st.profile.founderName },
    challenge: Buffer.from(mockHash(`challenge:${nextId(st, "reg")}`).slice(2), "hex").toString("base64url"),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
    attestation: "none",
    timeout: 60_000,
  }),

  passkeyRegisterVerify: ({ req, st }) => {
    const keys = founderKeys(st);
    const known = keys.get(req.body.id);
    const fromSpki = keyFromSpki((req.body.response as { publicKey?: unknown }).publicKey);
    const alreadySet = (message: string) => ({ code: "FounderKeyAlreadySet" as const, message, contractError: { name: "FounderKeyAlreadySet" as const } });
    // A credential's key is set once (registerFounderKey is one-time): a replay with the same key returns the
    // record unchanged, and a different key for a known credential is refused, never stored.
    if (known) {
      if (fromSpki && (fromSpki.qx !== known.qx || fromSpki.qy !== known.qy)) return alreadySet("This passkey is already registered with a different public key");
      const { founderId: _founderId, ...result } = known;
      return result;
    }
    if (!fromSpki) return { code: "VALIDATION", message: "The registration has no valid P-256 public key (response.publicKey: DER SPKI, a point on the curve)" };
    if ([...keys.values()].some((k) => k.onchain === "REGISTERED")) return alreadySet("A founder key is already registered on-chain for this facility");
    const result: PasskeyRegistrationResult = { credentialId: req.body.id, qx: fromSpki.qx, qy: fromSpki.qy, onchain: "PENDING_LENDER" };
    keys.set(result.credentialId, { ...result, founderId: st.baseSession.founderId });
    return result;
  },

  approveFounderKey: ({ req, st }) => {
    if (req.body.founderId !== st.baseSession.founderId) return { code: "NOT_FOUND", message: `No founder ${req.body.founderId}` };
    const key = founderKeys(st).get(req.body.credentialId);
    if (!key || key.qx !== req.body.qx || key.qy !== req.body.qy) {
      return { code: "CONFLICT", message: "This is not the founder's pending registration; review the key again" };
    }
    // registerFounderKey runs once per facility: another key already registered is never replaced or joined.
    if ([...founderKeys(st).values()].some((k) => k.onchain === "REGISTERED" && k.credentialId !== key.credentialId)) {
      return { code: "FounderKeyAlreadySet", message: "A founder key is already registered on-chain for this facility", contractError: { name: "FounderKeyAlreadySet" } };
    }
    // registerFounderKey reverts for a key that is not a valid P-256 point (P256.isValidPublicKey); refused here too,
    // so an approved key can always sign. Register verify already refuses one; this covers the seeded placeholder.
    if (!p256PublicKey(key)) {
      return { code: "CONFLICT", message: "This key is not a valid P-256 public key, so the chain would refuse it; reject it and ask the founder to enrol a new passkey", contractError: { name: "InvalidSignature" } };
    }
    const txHash = mockHash(`tx:registerFounderKey:${key.credentialId}`);
    // Approving the registered key again is a no-op for the demo (on-chain a second registerFounderKey reverts): the
    // same tx hash, and no second "registered" trace.
    if (key.onchain !== "REGISTERED") {
      founderKeys(st).set(key.credentialId, { ...key, onchain: "REGISTERED" });
      appendTrace(st, { traceId: nextId(st, "trace"), actor: "officer", kind: "TX", summary: "Loan officer registered the founder's passkey on-chain (demo lender key)", refs: { txHash } });
    }
    return { actionId: nextId(st, "act"), state: "BROADCAST", txHash };
  },

  openFacility: ({ req, st }) => {
    const txHash = mockHash(`tx:openFacility:${nextId(st, "fac")}`);
    st.facility = { ...st.facility, capMinor: req.body.capMinor, reserveFloorBps: req.body.reserveFloorBps, openedTx: txHash };
    appendTrace(st, { traceId: nextId(st, "trace"), actor: "officer", kind: "TX", summary: "Loan officer opened the facility with a cap and a reserve floor", refs: { txHash } });
    return { actionId: nextId(st, "act"), state: "BROADCAST", txHash };
  },

  fundFacility: ({ req, st }) => {
    const txHash = fundFacilityWith(st, req.body.amountMinor);
    return { actionId: nextId(st, "act"), state: "BROADCAST", txHash };
  },

  requestSignature: ({ req, st }) => {
    const res = buildSignatureRequest(st, req.body);
    if (isFailure(res)) return res;
    st.signatures.set(res.requestId, { body: req.body, response: res, submitted: false });
    return res;
  },

  submitSignature: ({ req, st, env }) => {
    const record = st.signatures.get(req.params.id);
    if (!record) return { code: "NOT_FOUND", message: `No signature request ${req.params.id}` };
    return submitSignature(st, env, record, req.body);
  },

  shortlistSuppliers: ({ st }) => {
    const requestId = nextId(st, "sl");
    const seeded = st.loaded.scenario["shortlist.json"];
    st.shortlists.set(requestId, {
      shortlist: { ...seeded, requestId, status: "PENDING", candidates: [], excluded: [], rankStabilityPct: null, shortlistHash: null, failureReason: null },
      readyAtMs: Date.now() + SHORTLIST_DELAY_MS,
    });
    return { requestId };
  },

  getShortlist: ({ req, st }) => st.shortlists.get(req.params.id)?.shortlist ?? { code: "NOT_FOUND", message: `No shortlist ${req.params.id}` },
  getSupplier: ({ req, st }) => supplierWithOrder(st, req.params.id),
  getEscrow: ({ req, st }) => st.escrow.get(req.params.orderId) ?? { code: "NOT_FOUND", message: `No escrow order ${req.params.orderId}` },

  uploadInspection: async ({ req, st }) => {
    const schedule = st.escrow.get(req.params.orderId);
    if (!schedule) return { code: "NOT_FOUND", message: `No escrow order ${req.params.orderId}` };
    const evidenceHash = sha256Bytes(new Uint8Array(await req.body.file.arrayBuffer()));
    recordInspection(st, req.params.orderId, evidenceHash);
    return { evidenceHash };
  },

  getBalances: ({ st }) => st.balances,

  listPayments: ({ req, st }) => {
    const { state, lineKey, cursor } = req.query;
    const all = st.payments.map((p) => p.payment).filter((p) => (!state || p.state === state) && (!lineKey || p.lineKey === lineKey));
    const from = cursor ? all.findIndex((p) => p.paymentId === cursor) + 1 : 0;
    return all.slice(from, from + PAGE_SIZE);
  },

  getPayment: ({ req, st }) => {
    const payment = st.payments.find((p) => p.payment.paymentId === req.params.id)?.payment;
    if (!payment) return { code: "NOT_FOUND", message: `No payment ${req.params.id}` };
    const traces = st.traces.filter((t) => t.traceId === payment.traceId || t.refs.paymentId === payment.paymentId).sort(compareTraces);
    return { ...payment, traces };
  },

  listTraces: ({ req, st }) => {
    const limit = Number(req.query.limit ?? "200");
    const since = req.query.since;
    return [...st.traces].sort(compareTraces).filter((t) => !since || t.ts > since).slice(-limit);
  },

  getTrace: ({ req, st }) => {
    const events = st.traces.filter((t) => t.traceId === req.params.traceId).sort(compareTraces);
    return events.length > 0 ? events : { code: "NOT_FOUND", message: `No trace ${req.params.traceId}` };
  },
};
