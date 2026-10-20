/**
 * POST /api/signatures/request and /:id/submit for every kind (project.md §8.7, §26.6).
 * Typed data uses P1's struct definitions (@hogee/chain hogeeTypes) and the custom Hogee domain, and the digest is a
 * real EIP-712 hash of exactly that typed data, so the UI can recompute it independently (§13.1 principle 5).
 * Mock-only shortcut: planHash/linesHash are JCS keccak commitments, not the chain's abi encodings (§26.7). Every
 * SupplierApproval's scheduleHash is the chain's abi encoding (eip712 scheduleHash), since the browser recomputes it
 * from the milestone rows (web: run-9; catalog: re-check review LOW 2).
 * Submitted signatures pass the chain's checks (signature-check.ts) against the founder's key (store.ts founderKeyFor).
 */
import { hashTypedData, hexToBytes, isAddressEqual } from "viem";
import { LOOSEN_KINDS as HOGEE_KINDS, chainTagOf, hogeeDomain, hogeeTypes, scheduleHash, toBytes32Tag, VERIFYING_CONTRACT_OF } from "./eip712";
import {
  ZERO_HEX32,
  catalogMilestoneRows,
  exampleInvoice,
  formatBu,
  hashObject,
  lineIdOf,
  parseMinor,
  type ChainAction,
  type DisplayModel,
  type Exception,
  type Hex32,
  type PlanDraft,
  type SignatureKind,
  type SignatureRequestBody,
  type SignatureRequestResponse,
  type SignatureSubmitBody,
  type TypedData,
} from "@hogee/core";
import {
  appendTrace,
  commitPlanLedger,
  currentPlan,
  founderKeyFor,
  mockAddress,
  mockHash,
  mockNow,
  nextId,
  nowUnix,
  type MockState,
  type SignatureRequestRecord,
  type SignedFounderSig,
} from "./store";
import { createScriptedPayment } from "./transitions";
import { supplierOrderFor } from "./supplier-order";
import { demoPayoutHash } from "./payees";
import type { MockCountry } from "./profile";
import { founderSignRefusal, founderSigned } from "./exceptions";
import { ownerEoaRoleError, type MockEnv } from "./env";
import { isFailure, type Failure } from "./result";
import { recoverEcdsaSigner, verifyPasskeyAssertion } from "./signature-check";
import { escrowFundingRefusal } from "./spend-policy";
import { TERMS_ID_RE, applyWebApproval, webApprovalCheck, webApprovalDraft, webTermsOfOrder } from "./features/orders";

const REQUEST_TTL_SECONDS = 900;
type Row = DisplayModel["rows"][number];
type Message = Record<string, string | boolean>;

const bu = (minor: string, currency: string): string => `${formatBu(minor)} (facility: ${currency})`;
const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** API typed-data message (decimal strings) → viem message (bigint for uints). */
function viemMessage(kind: SignatureKind, message: Message): Record<string, unknown> {
  return Object.fromEntries(
    hogeeTypes[kind].map((f) => {
      const v = message[f.name];
      return [f.name, f.type.startsWith("uint") && typeof v === "string" ? BigInt(v) : v];
    }),
  );
}

interface Draft {
  readonly title: string;
  readonly message: Message;
  readonly rows: Row[];
}

/**
 * The facility's draft `refId`, or why it can't be signed. A country-switch preview (country.ts) is stored as a draft
 * too, but it is another country's plan: as live refuses a preview (packages/api signing/plan-approval.ts), a draft
 * whose intent or manifest country is not the facility's (the served demo's) is refused, at request and at submit.
 */
function signablePlanDraft(st: MockState, refId: string): PlanDraft | Failure {
  const draft = st.drafts.get(refId);
  if (!draft) return { code: "NOT_FOUND", message: `No plan draft ${refId}` };
  const country = st.profile.country;
  if (draft.intent.countryCode !== country || draft.manifest.countryCode !== country) {
    return { code: "CONFLICT", message: `A country preview (${draft.manifest.countryCode}) is off-chain only and can't be signed; this facility's plans are ${country}` };
  }
  return draft;
}

function planApproval(st: MockState, refId: string): Draft | Failure {
  const draft = signablePlanDraft(st, refId);
  if (isFailure(draft)) return draft;
  const m = draft.manifest;
  const cur = m.displayCurrency;
  const stage1 = m.stages[0];
  const rows: Row[] = [
    { label: "Plan", value: `Version ${m.version}, ${m.countryCode} rules (country pack ${m.countryPackVersion})`, effect: "neutral" },
    { label: "Total budget", value: bu(m.totalMinor, cur), effect: "neutral" },
    ...m.lines.map<Row>((l) => ({
      label: `${l.lineKey} pocket`,
      value: `${bu(l.amountMinor, cur)}; per payment ≤ ${formatBu(l.perTxCapMinor)}; per 7 days ≤ ${formatBu(l.windowCapMinor)}${l.escrowOnly ? "; escrow milestones only" : ""}`,
      effect: "loosen",
    })),
    { label: "Tax reserve", value: `${(m.reserveBps / 100).toFixed(2)}% of every sale is set aside`, effect: "tighten" },
    ...(stage1 ? [{ label: "Released now", value: bu(stage1.releaseMinor, cur), effect: "loosen" } satisfies Row] : []),
    { label: "Agent key", value: `${m.agent.address}, valid until unix ${m.agent.expiresAt}`, effect: "loosen" },
    { label: "Blast radius", value: `${bu(draft.blastRadiusMinor, cur)} at most, even if the AI is fully compromised`, effect: "neutral" },
  ];
  const message: Message = {
    planId: m.planId,
    version: String(m.version),
    prevPlanHash: m.prevPlanHash,
    planHash: hashObject(m),
    countryPackHash: m.countryPackHash,
    linesHash: hashObject(m.lines),
    stagesHash: hashObject(m.stages),
    totalMinor: m.totalMinor,
    reserveBps: String(m.reserveBps),
    agent: m.agent.address,
    agentExpiry: m.agent.expiresAt,
  };
  return { title: `Approve launch plan v${m.version}`, message, rows };
}

/**
 * refId: confirmed web terms (terms-…, VISION-DECISIONS §9: features/orders.ts), or an escrow order id or a shortlisted
 * supplier id, as live (supplier-order.ts supplierOrderFor).
 */
function supplierApproval(st: MockState, refId: string): Draft | Failure {
  if (TERMS_ID_RE.test(refId)) return webApprovalDraft(st, refId, toBytes32Tag, lineIdOf("SUPPLIER"));
  const order = supplierOrderFor(st, refId);
  if ("code" in order) return order;
  const { orderId, schedule, candidate: chosen } = order;
  const shortlist = st.loaded.scenario["shortlist.json"];
  const cur = st.facility.currency;
  const total = schedule.reduce((sum, m) => sum + parseMinor(m.amountMinor), 0n).toString();
  const ordered = [...schedule].sort((a, b) => a.idx - b.idx);
  const rows: Row[] = [
    { label: "Order", value: orderId, effect: "neutral" },
    { label: "Supplier", value: `${chosen.displayName} (#${chosen.rank} of ${shortlist.candidates.length})`, effect: "neutral" },
    { label: "Payee binding", value: `${chosen.supplierId} may be paid from the SUPPLIER pocket, through escrow only, after a cooling period you can veto in`, effect: "loosen" },
    { label: "Payout account", value: `Fingerprint ${chosen.payoutAccountHash}`, effect: "neutral" },
    // The live catalog rows (core builder): the browser reads them back and checks scheduleHash and totalMinor.
    ...catalogMilestoneRows(ordered),
    { label: "Order total", value: bu(total, cur), effect: "neutral" },
  ];
  const message: Message = {
    orderId: toBytes32Tag(orderId),
    supplierId: toBytes32Tag(chosen.supplierId),
    payee: toBytes32Tag(chosen.supplierId),
    payoutAccountHash: chosen.payoutAccountHash,
    lineId: lineIdOf("SUPPLIER"),
    // The chain's abi encoding (as live), not a JCS commitment: the browser recomputes it from the milestone rows.
    scheduleHash: scheduleHash(ordered.map((m) => parseMinor(m.amountMinor)), ordered.map((m) => m.autoRelease)),
    totalMinor: total,
    quoteHash: hashObject(chosen.landedCost),
    shortlistHash: shortlist.shortlistHash ?? ZERO_HEX32,
    chosenIndex: String(Math.max(0, chosen.rank - 1)),
    inspectionRequired: true,
  };
  return { title: `Approve ${chosen.displayName} and its payment schedule`, message, rows };
}

function milestoneRelease(st: MockState, refId: string): Draft | Failure {
  const schedule = st.escrow.get(refId);
  if (!schedule) return { code: "NOT_FOUND", message: `No escrow order ${refId}` };
  const m = schedule.find((x) => !x.released && !x.autoRelease);
  if (!m) return { code: "CONFLICT", message: "No milestone of this order waits for your release" };
  const web = webTermsOfOrder(st, refId);
  if (web && (web.coolingEndsAtMs ?? Infinity) > Date.now()) return { code: "PayeeCooling", message: "The supplier is still cooling; nothing can be released yet", contractError: { name: "PayeeCooling" } };
  // As the chain: a web order's held milestone is released out of escrow, so the agent's funding must have landed.
  if (web && m.funded !== m.amountMinor) return { code: "CONFLICT", message: "The balance is not in escrow yet; the agent escrows it right after the cooling period" };
  // Only the recorded inspection is signed, as live (founder-payments releasable): no upload, no release (H-4).
  const evidenceHash = m.evidenceHash;
  if (!evidenceHash) return { code: "CONFLICT", message: "Upload the inspection evidence first" };
  // A catalog balance is funded by its release (mock shortcut, applyMilestoneRelease): that funding is checked as
  // fundMilestone checks it (run-10 re-check W-1), here at request and again at submit (signedDrift rebuilds this).
  const funding = m.funded !== m.amountMinor ? escrowFundingRefusal(st, "SUPPLIER", m.amountMinor) : undefined;
  if (funding) return { code: funding.reasonCode, message: `Not released: ${funding.summary}`, contractError: { name: funding.reasonCode } };
  const cur = st.facility.currency;
  const rows: Row[] = [
    { label: "Release", value: `${bu(m.amountMinor, cur)} to the supplier (milestone ${m.idx})`, effect: "loosen" },
    { label: "Inspection evidence", value: evidenceHash, effect: "neutral" },
  ];
  const message: Message = { orderId: toBytes32Tag(refId), idx: String(m.idx), amountMinor: m.amountMinor, evidenceHash };
  return { title: "Release the escrow balance", message, rows };
}

function releaseExceptionOf(st: MockState, orderId: string): Extract<Exception, { kind: "RELEASE_ESCROW_BALANCE" }> | undefined {
  for (const { exception } of st.exceptions.values()) {
    if (exception.kind === "RELEASE_ESCROW_BALANCE" && exception.payload.orderId === orderId) return exception;
  }
  return undefined;
}

/**
 * LoosenRequest{kind, target, aux, newValue} per G0-DECISIONS §2. ADD_PAYEE's newValue is the payee's payout hash from
 * the demo's payee accounts (payees.ts, the API's catalog), so it is undefined for a payee the demo has not onboarded.
 */
function loosenFields(e: Exception, country: MockCountry): { kind: number; target: Hex32; aux: Hex32; newValue: string; summary: string } | undefined {
  const K = HOGEE_KINDS;
  switch (e.kind) {
    case "RAISE_CAP":
      return {
        kind: e.payload.cap === "perTx" ? K.LOOSEN_RAISE_PER_TX_CAP : K.LOOSEN_RAISE_WINDOW_CAP,
        target: lineIdOf(e.payload.lineKey) as Hex32,
        aux: ZERO_HEX32,
        newValue: e.payload.newCapMinor,
        summary: `Raise the ${e.payload.lineKey} ${e.payload.cap === "perTx" ? "per-payment" : "7-day"} cap to ${formatBu(e.payload.newCapMinor)}`,
      };
    case "ADD_PAYEE": {
      const payoutHash = demoPayoutHash(country, e.payload.payeeId);
      if (!payoutHash) return undefined;
      return {
        kind: K.LOOSEN_ADD_PAYEE,
        target: toBytes32Tag(e.payload.payeeId) as Hex32,
        aux: lineIdOf(e.payload.lineKey) as Hex32,
        newValue: BigInt(payoutHash).toString(),
        summary: `Let the agent pay ${e.payload.payeeId} from the ${e.payload.lineKey} pocket`,
      };
    }
    case "EXTEND_EXPIRY":
      return e.payload.target === "agent"
        ? { kind: K.LOOSEN_EXTEND_AGENT_EXPIRY, target: ZERO_HEX32, aux: ZERO_HEX32, newValue: e.payload.newExpiresAt, summary: `Extend the agent key to unix ${e.payload.newExpiresAt}` }
        : { kind: K.LOOSEN_EXTEND_LINE_EXPIRY, target: lineIdOf(e.payload.lineKey) as Hex32, aux: ZERO_HEX32, newValue: e.payload.newExpiresAt, summary: `Extend the ${e.payload.lineKey} pocket to unix ${e.payload.newExpiresAt}` };
    case "MOVE_POCKETS":
      return {
        kind: K.LOOSEN_MOVE_POCKETS,
        target: lineIdOf(e.payload.fromLineKey) as Hex32,
        aux: lineIdOf(e.payload.toLineKey) as Hex32,
        newValue: e.payload.amountMinor,
        summary: `Move ${formatBu(e.payload.amountMinor)} from ${e.payload.fromLineKey} to ${e.payload.toLineKey}`,
      };
    case "UNPAUSE":
      return { kind: K.LOOSEN_UNPAUSE, target: e.payload.lineKey ? (lineIdOf(e.payload.lineKey) as Hex32) : ZERO_HEX32, aux: ZERO_HEX32, newValue: "0", summary: e.payload.lineKey ? `Unpause the ${e.payload.lineKey} pocket` : "Unpause the treasury" };
    case "WITHDRAW_RESERVE":
      return { kind: K.LOOSEN_WITHDRAW_RESERVE, target: toBytes32Tag(e.payload.taxPayeeId) as Hex32, aux: ZERO_HEX32, newValue: e.payload.amountMinor, summary: `Withdraw ${formatBu(e.payload.amountMinor)} of the reserve to ${e.payload.taxPayeeId}` };
    default:
      return undefined;
  }
}

function loosenRequest(st: MockState, refId: string): Draft | Failure {
  const e = st.exceptions.get(refId)?.exception;
  if (!e) return { code: "NOT_FOUND", message: `No exception ${refId}` };
  const f = loosenFields(e, st.profile.country);
  if (!f && e.kind === "ADD_PAYEE") return { code: "CONFLICT", message: "Only an onboarded payee can be added to a line" };
  if (!f) return { code: "CONFLICT", message: `${e.kind} is not a loosening; it resolves without a LoosenRequest` };
  if (!["OPEN", "FOUNDER_SIGNED", "APPROVED"].includes(e.status)) return { code: "CONFLICT", message: `Exception ${refId} is ${e.status}` };
  const rows: Row[] = [
    { label: "Change", value: f.summary, effect: "loosen" },
    { label: "Needs", value: "Your signature, the loan officer's signature, then a waiting time (demo: 120 s) during which you or your loan officer can cancel it", effect: "neutral" },
    { label: "Blast radius", value: bu(e.blastRadiusMinor, st.facility.currency), effect: "neutral" },
  ];
  return { title: e.title, message: { kind: String(f.kind), target: f.target, aux: f.aux, newValue: f.newValue }, rows };
}

function ownerSpend(st: MockState, refId: string): Draft | Failure {
  if (refId !== exampleInvoice.invoiceId) return { code: "NOT_FOUND", message: `No invoice ${refId}` };
  const inv = exampleInvoice;
  const lineKey = st.loaded.scenario["plan-current.json"].manifest.lines.find((l) => l.payeeIds.includes(inv.payeeId))?.lineKey ?? "LOGISTICS";
  const rows: Row[] = [
    { label: "Manual payment", value: `${bu(inv.amountMinor, st.facility.currency)} to ${inv.payeeId} from ${lineKey}`, effect: "loosen" },
    { label: "Invoice", value: inv.invoiceHash, effect: "neutral" },
  ];
  const message: Message = { lineId: lineIdOf(lineKey), payeeId: toBytes32Tag(inv.payeeId), amountMinor: inv.amountMinor, invoiceHash: inv.invoiceHash };
  return { title: "Pay an invoice yourself (manual fallback)", message, rows };
}

export function buildSignatureRequest(st: MockState, body: SignatureRequestBody, nowMs = mockNow()): SignatureRequestResponse | Failure {
  const builders: Record<SignatureKind, (st: MockState, refId: string) => Draft | Failure> = {
    PlanApproval: planApproval,
    SupplierApproval: supplierApproval,
    MilestoneRelease: milestoneRelease,
    LoosenRequest: loosenRequest,
    StageRelease: () => ({ code: "CONFLICT", message: "A stage release is signed by the loan officer in the officer console" }),
    OwnerSpend: ownerSpend,
  };
  const built = builders[body.kind](st, body.refId);
  if ("code" in built) return built;
  const { chainId, deploymentId } = st.baseSession;
  const contract = mockAddress(`${VERIFYING_CONTRACT_OF[body.kind]}:${deploymentId}`);
  const domain = hogeeDomain({ verifyingContract: contract as `0x${string}`, chainTag: toBytes32Tag(chainTagOf(chainId)), deploymentId: toBytes32Tag(deploymentId) });
  const expiresAt = String(Number(nowUnix(nowMs)) + REQUEST_TTL_SECONDS);
  const message: Message = { ...built.message, deploymentId: toBytes32Tag(deploymentId), nonce: String(st.counter + 1), expiry: expiresAt };
  const types = { [body.kind]: hogeeTypes[body.kind].map((f) => ({ name: f.name, type: f.type })) };
  const digest = hashTypedData({
    domain: { ...domain },
    types,
    primaryType: body.kind,
    message: viemMessage(body.kind, message),
  } as Parameters<typeof hashTypedData>[0]) as Hex32;
  const typedData: TypedData = { domain: { ...domain, salt: domain.salt as Hex32 }, types, primaryType: body.kind, message };
  const displayModel: DisplayModel = { title: built.title, kind: body.kind, rows: built.rows, digest, chainId, contract, deploymentId };
  return {
    requestId: nextId(st, "sig"),
    typedData,
    digest,
    challengeB64url: base64Url(hexToBytes(digest as `0x${string}`)),
    displayModel,
    expiresAt,
  };
}

const invalidSignature = (message: string): Failure => ({ code: "InvalidSignature", message, contractError: { name: "InvalidSignature" } });

/** Role addresses the mock knows: the lender's, and the agent key of every plan and draft. */
function roleAddresses(st: MockState): string[] {
  const agents = [...st.plans.map((p) => p.manifest), ...[...st.drafts.values()].map((d) => d.manifest)].map((m) => m.agent.address);
  return [st.facility.lenderAddress, ...agents];
}

type Verified = { readonly signer: SignedFounderSig } | { readonly problem: string };

/** The founder's verified signer when the signature is hers over this request's digest, else why it is refused. */
async function verifyFounderSignature(st: MockState, env: MockEnv, record: SignatureRequestRecord, body: SignatureSubmitBody): Promise<Verified> {
  if ("passkey" in body) {
    const { credentialId } = body.passkey;
    const key = founderKeyFor(st, credentialId);
    if (!key) return { problem: "This passkey is not the founder's registered key" };
    return verifyPasskeyAssertion(body.passkey, key, record.response.challengeB64url)
      ? { signer: { kind: "passkey", credentialId } }
      : { problem: "The passkey signature does not match this approval" };
  }
  if (env.ownerEoaError) return { problem: env.ownerEoaError };
  if (!env.ownerEoa) return { problem: "No wallet is registered for this founder; sign with the passkey" };
  const roleError = ownerEoaRoleError(env.ownerEoa, roleAddresses(st));
  if (roleError) return { problem: roleError };
  const signer = await recoverEcdsaSigner(record.response.digest as `0x${string}`, body.ecdsa.signature as `0x${string}`);
  if (!signer) return { problem: "The wallet signature is malformed" };
  return isAddressEqual(signer, env.ownerEoa)
    ? { signer: { kind: "wallet", address: env.ownerEoa } }
    : { problem: "The wallet signature is not from the founder's registered wallet" };
}

/** Verifies a submitted signature (the chain's checks, against founderKeyFor's key), then applies it. */
export async function submitSignature(
  st: MockState,
  env: MockEnv,
  record: SignatureRequestRecord,
  body: SignatureSubmitBody,
  nowMs = Date.now(),
): Promise<ChainAction | Failure> {
  if (record.submitted) return { code: "CONFLICT", message: "This signature request was already used" };
  if (BigInt(nowUnix(nowMs)) > BigInt(record.response.expiresAt)) {
    return { code: "SignatureExpired", message: "The signing request expired; request a new one", contractError: { name: "SignatureExpired" } };
  }
  const verified = await verifyFounderSignature(st, env, record, body);
  if ("problem" in verified) return invalidSignature(verified.problem);
  // Checked again after the await: a parallel submit of the same request may have won.
  if (record.submitted) return { code: "CONFLICT", message: "This signature request was already used" };
  // No await from here on: the check and the queueing below see the same state.
  const queueRefusal = record.body.kind === "LoosenRequest" ? founderSignRefusal(st, record.body.refId) : undefined;
  if (queueRefusal) return queueRefusal;
  const plan = record.body.kind === "PlanApproval" ? signablePlanDraft(st, record.body.refId) : undefined;
  if (isFailure(plan)) return plan;
  // Web terms are re-checked at submit, as live finalize re-plans them (superseded or changed terms are refused).
  const web = record.body.kind === "SupplierApproval" && TERMS_ID_RE.test(record.body.refId) ? webApprovalCheck(st, record.body.refId, nowMs) : undefined;
  if (isFailure(web)) return web;
  const drift = signedDrift(st, record);
  if (drift) return drift;
  record.submitted = true;
  // Salted with the store build's nonce: a store rebuilt later repeats request ids, never this tx (run-10 re-check W-3).
  const txHash = mockHash(`tx:sig:${st.buildNonce}:${record.response.requestId}`);
  const method = "passkey" in body ? "passkey (Touch ID)" : "MetaMask";
  const { kind, refId } = record.body;
  const traceId = nextId(st, "trace");
  appendTrace(st, { traceId, actor: "founder", kind: "SIGNATURE", summary: `Founder signed ${kind} with ${method}`, refs: {} });
  appendTrace(st, { traceId, actor: "worker", kind: "TX", summary: `Relayer submitted the signed ${kind}`, refs: { txHash } });
  if (plan) applyPlanApproval(st, plan, txHash);
  if (kind === "SupplierApproval") {
    if (web) applyWebApproval(st, refId, nowMs, env.timelockSeconds, txHash);
    else applySupplierApproval(st, refId);
  }
  if (kind === "MilestoneRelease") applyMilestoneRelease(st, refId, nowMs);
  if (kind === "LoosenRequest") founderSigned(st, refId, env.timelockSeconds, verified.signer);
  if (kind === "OwnerSpend") {
    const lineKey = st.loaded.scenario["plan-current.json"].manifest.lines.find((l) => l.payeeIds.includes(exampleInvoice.payeeId))?.lineKey ?? "LOGISTICS";
    createScriptedPayment(st, { kind: "OWNER_SPEND", lineKey, payeeId: exampleInvoice.payeeId, amountMinor: exampleInvoice.amountMinor, invoiceHash: exampleInvoice.invoiceHash, reason: "Founder paid the invoice manually", policy: { verdict: "NEEDS_FOUNDER", reasonCode: "OWNER_SIGNED", summary: "Paid with the founder's own signature (manual fallback)" } }, nowMs);
  }
  return { actionId: nextId(st, "act"), state: "BROADCAST", txHash };
}

/** The submits that re-plan the request before applying it, and what a changed field means to the founder. */
const REBUILT_AT_SUBMIT: Partial<Record<SignatureKind, { readonly build: (st: MockState, refId: string) => Draft | Failure; readonly changed: string }>> = {
  SupplierApproval: { build: supplierApproval, changed: "The terms, the shortlist or the plan changed since you were asked to sign; nothing was approved, request again" },
  MilestoneRelease: { build: milestoneRelease, changed: "The payment or its delivery check changed since you were asked to sign; nothing was paid, request again" },
};

/**
 * A SupplierApproval or MilestoneRelease is applied only while re-planning it now gives every field the founder signed
 * (live finalize: CONFLICT otherwise), so a pocket reallocation between request and submit never funds a schedule she
 * did not sign, and a release pays exactly the milestone and check code she signed: a second tab's submit after the
 * first paid it, or evidence re-uploaded since the request, is refused (run-10 re-check W-2). A refusal of the rebuild
 * itself (nothing waits, CapExceeded, ...) is returned as is. Synchronous with the apply that follows, so both see the
 * same store.
 */
function signedDrift(st: MockState, record: SignatureRequestRecord): Failure | undefined {
  const rebuilt = REBUILT_AT_SUBMIT[record.body.kind];
  if (!rebuilt) return undefined;
  const now = rebuilt.build(st, record.body.refId);
  if ("code" in now) return now;
  const signed = record.response.typedData.message;
  if (Object.entries(now.message).every(([k, v]) => signed[k] === v)) return undefined;
  return { code: "CONFLICT", message: rebuilt.changed };
}

/** Commits `draft`, which signablePlanDraft returned in this same synchronous step (the facility's country only). */
export function applyPlanApproval(st: MockState, draft: PlanDraft, txHash: Hex32): void {
  for (const se of st.exceptions.values()) {
    if (se.exception.kind === "REPLAN" && se.exception.payload.draftId === draft.draftId) se.exception = { ...se.exception, status: "EXECUTED" };
  }
  const planHash = hashObject(draft.manifest);
  const existing = st.plans.find((p) => p.planHash === planHash);
  if (existing) {
    existing.txHash = txHash;
    existing.status = "COMMITTED";
    return;
  }
  const prev = currentPlan(st);
  if (prev && prev.manifest.version >= draft.manifest.version) {
    // Re-signing the committed version: record the new tx on the same record instead of a duplicate version.
    prev.txHash = txHash;
    return;
  }
  st.plans = st.plans.map((p) => (p.status === "COMMITTED" ? { ...p, status: "SUPERSEDED" } : p));
  st.plans.push({ manifest: draft.manifest, status: "COMMITTED", planHash, txHash });
  commitPlanLedger(st, draft.manifest);
}

/**
 * Writes the order (a supplier's first one is created now, as live writes it at submit) and funds its auto milestones,
 * each only as fundMilestone allows it (escrowFundingRefusal, in index order so each one counts the one before): one
 * it may not fund stays unfunded (funded "0"), as the web path leaves it (run-10 re-check W-1).
 */
function applySupplierApproval(st: MockState, refId: string): void {
  const order = supplierOrderFor(st, refId);
  if ("code" in order) return;
  const { orderId, schedule, candidate } = order;
  // The agent funds the pre-signed sample and deposit itself (§4 step 6), unless they are already funded.
  const funded = new Set<number>();
  for (const m of schedule.filter((x) => x.autoRelease && x.funded === "0")) {
    if (escrowFundingRefusal(st, "SUPPLIER", m.amountMinor)) continue;
    createScriptedPayment(st, { kind: "FUND_MILESTONE", lineKey: "SUPPLIER", payeeId: candidate.supplierId, amountMinor: m.amountMinor, reason: `Fund milestone ${m.idx} exactly as pre-signed` });
    funded.add(m.idx);
  }
  st.escrow.set(orderId, schedule.map((m) => (funded.has(m.idx) ? { ...m, funded: m.amountMinor } : m)));
}

/** Pays out the order's held milestone (the founder's MilestoneRelease passed its checks in the same synchronous step). */
export function applyMilestoneRelease(st: MockState, orderId: string, nowMs: number): void {
  const schedule = st.escrow.get(orderId);
  const m = schedule?.find((x) => !x.released && !x.autoRelease);
  if (!schedule || !m) return;
  st.escrow.set(orderId, schedule.map((x) => (x.idx === m.idx ? { ...x, released: true, funded: x.amountMinor } : x)));
  const order = supplierOrderFor(st, orderId);
  const web = webTermsOfOrder(st, orderId);
  const payeeId = web ? web.supplierId : "code" in order ? st.profile.ids.supplierAPayeeId : order.candidate.supplierId;
  // A web balance was escrowed in full after cooling; a catalog balance is funded by this same release (mock shortcut).
  const fundsEscrow = m.funded !== m.amountMinor;
  createScriptedPayment(st, { kind: "RELEASE_MILESTONE", lineKey: "SUPPLIER", payeeId, amountMinor: m.amountMinor, reason: "Release the balance after inspection", fundsEscrow }, nowMs);
  const release = releaseExceptionOf(st, orderId);
  const se = release ? st.exceptions.get(release.exceptionId) : undefined;
  if (se) se.exception = { ...se.exception, status: "EXECUTED" };
}
