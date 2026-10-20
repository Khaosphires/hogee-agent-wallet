/**
 * In-memory state of the mock (one per server process; POST /api/demo/reset rebuilds it).
 * Seeded from fixtures (seed.ts). Seeded records are a static "gallery" of every status: they never move on their own
 * (only records the mock creates or queues itself move through scripted transitions, transitions.ts), but an officer
 * or founder action on one moves it as on any other record. A seeded FOUNDER_SIGNED row carries no founder signature
 * (FounderSig "seeded-fixture").
 */
import { randomUUID } from "node:crypto";
import {
  ZERO_HEX32,
  hashObject,
  parseMinor,
  toMinor,
  type Balances,
  type ChatMessage,
  type EscrowSchedule,
  type Exception,
  type Facility,
  type LineKey,
  type Payment,
  type PaymentState,
  type PlanDraft,
  type PlanRecord,
  type PlanManifest,
  type Pocket,
  type Session,
  type Shortlist,
  type SignatureRequestBody,
  type SignatureRequestResponse,
  type SupplierWithEvidence,
  type TraceEvent,
  type AutonomyStats,
  type CfoSaleIn,
  type PasskeyRegistrationResult,
  type Persona,
} from "@hogee/core";
import type { Address } from "viem";
import { exampleAliases, loadScenario, scenarioDir, type LoadedScenario, type SeedSource } from "./seed";
import type { MockEnv, MockScenario } from "./env";
import { PROFILES, type DemoProfile } from "./profile";

export interface ScriptedPayment {
  payment: Payment;
  /** Present for payments the mock created; seeded payments never move. */
  script?: { readonly startMs: number; readonly stepMs: number; readonly path: readonly PaymentState[]; readonly fundsEscrow?: true };
  /** Side effects already applied (balances, traces), keyed by state. */
  readonly applied: Set<PaymentState>;
}

export interface ShortlistJob {
  shortlist: Shortlist;
  /** READY at this time (ms); undefined for seeded shortlists. */
  readyAtMs?: number;
}

export interface SignatureRequestRecord {
  readonly body: SignatureRequestBody;
  readonly response: SignatureRequestResponse;
  submitted: boolean;
}

/**
 * How a FOUNDER_SIGNED record came to be signed. Only submitSignature (signing.ts) writes `passkey` or `wallet`, after
 * the signature passed the chain's checks; buildState writes `seeded-fixture` for a FOUNDER_SIGNED record in the seed.
 * - passkey: the credential that signed. The officer's approval queues the loosening only while founderKeyFor still
 *   names that key (exceptions.ts officerApprove).
 * - wallet: the HOGEE_MOCK_OWNER_EOA address the ECDSA signature recovered to. Nothing to re-check.
 * - seeded-fixture: an owner-authored status-gallery row (fixtures/scenario-rina/exceptions.json, or core's examples).
 *   No founder key signed it. It stays approvable exactly as before: only the verified officer can approve it, and no
 *   request can create or edit a FOUNDER_SIGNED record (audit run-8 lead, rejected by P1's verifier).
 */
export type FounderSig =
  | { readonly kind: "seeded-fixture" }
  | { readonly kind: "passkey"; readonly credentialId: string }
  | { readonly kind: "wallet"; readonly address: Address };

/** What a real signing handler records: never `seeded-fixture`. */
export type SignedFounderSig = Exclude<FounderSig, { kind: "seeded-fixture" }>;

export interface ScriptedException {
  exception: Exception;
  /** Set when the mock queued it; seeded exceptions keep their status until an officer or founder acts on them. */
  queuedByMock?: boolean;
  executedEffects?: boolean;
  /** Set once the executor found it no longer passes its checks (it stays EXECUTABLE, as a reverted execute would). */
  executeRefused?: boolean;
  /** The signer behind a FOUNDER_SIGNED record (see FounderSig); cleared when a stale signature sends it back to OPEN. */
  founderSig?: FounderSig;
}

/** A seed record as the store holds it: a FOUNDER_SIGNED one is marked as the fixture gallery's, never as signed. */
function seededException(exception: Exception): ScriptedException {
  return exception.status === "FOUNDER_SIGNED" ? { exception, founderSig: { kind: "seeded-fixture" } } : { exception };
}

export interface ChatSession {
  messages: ChatMessage[];
  turn: number;
}

export interface FounderKey extends PasskeyRegistrationResult {
  readonly founderId: string;
}

/**
 * The sample business (MOCK_SCENARIO=lived; scenario-lived/): what its builder leaves for the reads that need more than
 * the ledger. Undefined in every other scenario. Everything in it is sample data (mock mode only).
 */
export interface SampleBusiness {
  /** When the builder ran (ms); every sample date is relative to it. */
  readonly builtAtMs: number;
  /** When the sample plan was committed: the agent's mandate starts here (autonomy startedAt). */
  readonly commitAtMs: number;
  /** The sample's Shopee sales, oldest first (ids sale-sample-<day>-<n>, no tx), already recorded in the balances. */
  readonly sales: readonly CfoSaleIn[];
  /** Σ sales: the balances' revenue right after the build (anything above it is a demo sale recorded since). */
  readonly revenueMinor: bigint;
  /** The history a new chat session starts with (fresh message and action ids each call; store.ts mints it once per store). */
  readonly transcript: (st: MockState) => ChatMessage[];
  /** Chat sessions a POST started with that history so far (openChat counts and caps them; a GET counts nothing). */
  seededChats: number;
}

export interface MockState {
  /** The demo this store serves (HOGEE_COUNTRY): Mei for SG, Rina for MY. */
  readonly profile: DemoProfile;
  /**
   * The scenario served (activeScenario: MOCK_SCENARIO unless the demo-data switch chose another): the seeded demo, a
   * fresh founder at the start of the chat journey (freshState), or the sample business (lived, built from fresh).
   */
  readonly scenario: MockScenario;
  readonly loaded: LoadedScenario;
  readonly baseSession: Session;
  facility: Facility;
  readonly drafts: Map<string, PlanDraft>;
  plans: PlanRecord[];
  readonly shortlists: Map<string, ShortlistJob>;
  readonly suppliers: Map<string, SupplierWithEvidence>;
  balances: Balances;
  payments: ScriptedPayment[];
  traces: TraceEvent[];
  readonly exceptions: Map<string, ScriptedException>;
  autonomy: AutonomyStats & { running: boolean; lastTickMs: number; pacingSlot: number };
  readonly escrow: Map<string, EscrowSchedule>;
  readonly chats: Map<string, ChatSession>;
  readonly signatures: Map<string, SignatureRequestRecord>;
  readonly founderKeys: Map<string, FounderKey>;
  /** Credential ids the loan officer rejected (founder-enrolment.ts): such a key never signs, registers or is approved. */
  readonly rejectedFounderKeys: Set<string>;
  readonly salesSeen: Set<string>;
  /** Spend intents already paid: `<lineKey>:slot:<n>` and `invoice:<id>` (on-chain DuplicateIntent / DuplicateInvoice). */
  readonly usedIntents: Set<string>;
  crashArmed: boolean;
  counter: number;
  blockBase: number;
  /** MOCK_SCENARIO=lived only (SampleBusiness). */
  sample?: SampleBusiness;
  /** Traces and chat messages the store held once built (or seeded since): more means the demo was used (usedSinceBuilt). */
  baseline: { traces: number; messages: number };
  /**
   * Random per store build (buildState; the fresh and lived stores keep their build's): salts what must never repeat
   * across builds although the counter restarts, e.g. a submit's tx (signing.ts; run-10 re-check W-3).
   */
  readonly buildNonce: string;
}

let state: MockState | undefined;
let stateKey: string | undefined;
/** The demo-data switch's choice (demo-data.ts), valid only while MOCK_SCENARIO is still the one it was made under. */
let chosen: { readonly under: MockScenario; readonly scenario: MockScenario } | undefined;

/** The scenario served now: the demo-data switch's choice, else MOCK_SCENARIO. */
export function activeScenario(env: MockEnv): MockScenario {
  return chosen && chosen.under === env.scenario ? chosen.scenario : env.scenario;
}

/**
 * The store for this env; rebuilt when the country, the scenario or the seed directory changes (e.g. REPLAY toggled in
 * tests). The lived scenario is fresh here; scenario-lived/ readyState fills it in before the first request is served.
 * It serves Mei (SG) in mock mode only: lived under REPLAY or for another country throws (fail closed).
 */
export function getState(env: MockEnv): MockState {
  const scenario = activeScenario(env);
  const key = `${env.country}|${scenario}|${scenarioDir(env, PROFILES[env.country])}`;
  if (!state || stateKey !== key) {
    if (scenario === "lived" && (env.replayRunId !== undefined || env.country !== "SG")) {
      throw new Error("MOCK_SCENARIO=lived (the sample business) serves Mei (HOGEE_COUNTRY=SG) in mock mode only, never with REPLAY");
    }
    const seeded = buildState(loadScenario(env, env.country));
    state = scenario === "default" ? seeded : freshState(seeded, scenario);
    stateKey = key;
  }
  return state;
}

/**
 * MOCK_SCENARIO=fresh (VISION-DECISIONS §7): the same founder, facility, session and supplier catalog, at the start of
 * the chat journey: no plan, no escrow, no payments, no exceptions, no traces, no chat, no shortlist, revenue 0 and
 * nothing funded or spent. The founder key counts as active (founderKeyActive): the journey skips enrolment, and the
 * founder's pending key signs as in the default demo (founderKeyFor).
 */
export function freshState(seeded: MockState, scenario: "fresh" | "lived" = "fresh"): MockState {
  const b = seeded.balances;
  return {
    ...seeded,
    scenario,
    plans: [],
    shortlists: new Map(),
    balances: { ...b, fundedMinor: "0", releasedMinor: "0", revenueMinor: "0", reserveMinor: "0", escrowMinor: "0", pockets: [], paused: false, drift: 0 },
    payments: [],
    traces: [],
    exceptions: new Map(),
    autonomy: { agentTxs: 0, humanSigs: 0, autoPct: 0, escalatedPct: 0, startedAt: nowIso(), hours: 0, drift: 0, running: false, lastTickMs: 0, pacingSlot: 0 },
    escrow: new Map(),
    chats: new Map(),
    baseline: { traces: 0, messages: 0 },
  };
}

/** JourneyFacts.founderKeyActive in the mock: a registered key, or the fresh and lived scenarios (enrolment skipped). */
export function founderKeyActive(st: MockState): boolean {
  return st.scenario !== "default" || [...st.founderKeys.values()].some((k) => k.onchain === "REGISTERED");
}

/**
 * Rebuilds the store. With `scenario` (the demo-data switch), it serves that scenario from now on, until MOCK_SCENARIO
 * changes or another choice is made; choosing MOCK_SCENARIO's own scenario clears the choice. Without it (the officer's
 * "Reset the demo"), the scenario served now is rebuilt.
 */
export function resetState(env: MockEnv, scenario?: MockScenario): MockState {
  if (scenario !== undefined) chosen = scenario === env.scenario ? undefined : { under: env.scenario, scenario };
  state = undefined;
  return getState(env);
}

/** At most this many chat sessions start with the sample's history: sessions a POST started (openChat; a GET stores nothing). */
export const MAX_SEEDED_CHATS = 200;

/** The sample's history per store, minted once: its ids come from the store's counter, so no later id repeats them. */
const sampleHistories = new WeakMap<SampleBusiness, readonly ChatMessage[]>();

function sampleHistory(st: MockState, sample: SampleBusiness): readonly ChatMessage[] {
  let history = sampleHistories.get(sample);
  if (!history) {
    history = sample.transcript(st);
    sampleHistories.set(sample, history);
  }
  return history;
}

/**
 * The messages of chat session `sessionId` for a read (GET /api/chat/:id, the journey's facts), or undefined when it has
 * none. A read stores and counts nothing (run-10 v-6: the web's guard checks only Host for a GET, so a GET must be a
 * read): in the lived scenario a session not seen yet reads as the sample business's history, exactly what its first
 * POST will start it with (openChat), and as nothing once MAX_SEEDED_CHATS sessions were started with it.
 */
export function chatHistory(st: MockState, sessionId: string): readonly ChatMessage[] | undefined {
  const have = st.chats.get(sessionId);
  if (have) return have.messages;
  const sample = st.sample;
  return sample && sample.seededChats < MAX_SEEDED_CHATS ? sampleHistory(st, sample) : undefined;
}

/**
 * The chat session `sessionId`, started if new: for POST routes only (a chat turn or press, draftPlan). In the lived
 * scenario a new session starts with the sample business's history (a copy of what chatHistory showed), counted up to
 * MAX_SEEDED_CHATS; that history is not "use". Otherwise, and past the cap, it starts empty.
 */
export function openChat(st: MockState, sessionId: string): ChatSession {
  const have = st.chats.get(sessionId);
  if (have) return have;
  const sample = st.sample && st.sample.seededChats < MAX_SEEDED_CHATS ? st.sample : undefined;
  const session: ChatSession = sample ? { messages: structuredClone([...sampleHistory(st, sample)]), turn: 99 } : { messages: [], turn: 0 };
  if (sample) {
    sample.seededChats += 1;
    st.baseline = { ...st.baseline, messages: st.baseline.messages + session.messages.length };
  }
  st.chats.set(sessionId, session);
  return session;
}

const chatMessageCount = (st: MockState): number => [...st.chats.values()].reduce((n, s) => n + s.messages.length, 0);

/** Whether the demo was used since this store was built: a new trace, a signature request or a chat message since. */
export function usedSinceBuilt(st: MockState): boolean {
  return st.traces.length > st.baseline.traces || st.signatures.size > 0 || chatMessageCount(st) > st.baseline.messages;
}

/** Marks the store as just built (scenario-lived/ calls it when its history is in place). */
export function markBuilt(st: MockState): void {
  st.baseline = { traces: st.traces.length, messages: chatMessageCount(st) };
}

export function seedSources(env: MockEnv): Readonly<Record<string, SeedSource>> {
  return getState(env).loaded.sources;
}

function buildState(loaded: LoadedScenario): MockState {
  const s = loaded.scenario;
  const profile = PROFILES[loaded.country];
  const EXAMPLE_ALIASES = exampleAliases(loaded.country);
  const drafts = new Map<string, PlanDraft>([[s["plan-draft.json"].draftId, s["plan-draft.json"]]]);
  if (!drafts.has(EXAMPLE_ALIASES.draft.draftId)) drafts.set(EXAMPLE_ALIASES.draft.draftId, structuredClone(EXAMPLE_ALIASES.draft));
  const suppliers = new Map(s["suppliers.json"].map((sup) => [sup.supplierId, sup] as const));
  if (!suppliers.has(EXAMPLE_ALIASES.supplier.supplierId)) {
    suppliers.set(EXAMPLE_ALIASES.supplier.supplierId, structuredClone(EXAMPLE_ALIASES.supplier));
  }
  const escrow = new Map(Object.entries(s["escrow.json"]));
  if (!escrow.has(EXAMPLE_ALIASES.escrow.orderId)) {
    escrow.set(EXAMPLE_ALIASES.escrow.orderId, structuredClone(EXAMPLE_ALIASES.escrow.schedule));
  }
  const shortlists = new Map<string, ShortlistJob>([[s["shortlist.json"].requestId, { shortlist: s["shortlist.json"] }]]);
  if (!shortlists.has(EXAMPLE_ALIASES.shortlist.requestId)) {
    shortlists.set(EXAMPLE_ALIASES.shortlist.requestId, { shortlist: structuredClone(EXAMPLE_ALIASES.shortlist) });
  }
  const session = s["session.json"];
  const chats = new Map<string, ChatSession>();
  const seededChatId = chatSessionIdOf(s["chat.json"], profile.sessionId);
  if (seededChatId) chats.set(seededChatId, { messages: s["chat.json"], turn: 99 });
  return {
    profile,
    scenario: "default",
    loaded,
    baseSession: session,
    facility: s["facility.json"],
    drafts,
    plans: [s["plan-current.json"]],
    shortlists,
    suppliers,
    balances: s["balances.json"],
    payments: s["payments.json"].map((payment) => ({ payment, applied: new Set<PaymentState>() })),
    traces: [...s["traces.json"]].sort(compareTraces),
    exceptions: new Map(s["exceptions.json"].map((exception) => [exception.exceptionId, seededException(exception)] as const)),
    autonomy: { ...s["autonomy.json"], running: false, lastTickMs: 0, pacingSlot: 0 },
    escrow,
    chats,
    signatures: new Map(),
    founderKeys: new Map(),
    rejectedFounderKeys: new Set(),
    salesSeen: new Set(),
    usedIntents: new Set(),
    crashArmed: false,
    counter: 0,
    blockBase: 7_400_000,
    baseline: { traces: s["traces.json"].length, messages: s["chat.json"].length },
    buildNonce: randomUUID(),
  };
}

/** The chat fixture's session id lives in message metadata (P3) or defaults to the founder's (RINA_ / MEI_SESSION_ID). */
function chatSessionIdOf(messages: readonly ChatMessage[], founderSessionId: string): string | undefined {
  for (const m of messages) {
    const meta = (m as { metadata?: { sessionId?: unknown } }).metadata;
    if (typeof meta?.sessionId === "string") return meta.sessionId;
  }
  return messages.length > 0 ? founderSessionId : undefined;
}

export function compareTraces(a: TraceEvent, b: TraceEvent): number {
  return a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1;
}

// ---- ids, hashes, time ---------------------------------------------------------------------------

export function nextId(st: MockState, prefix: string): string {
  st.counter += 1;
  return `${prefix}-mock-${String(st.counter).padStart(4, "0")}`;
}

// A unique mock 32-byte value (real keccak of a label; never presented as a chain hash outside mock mode). In its own
// module so the seed builders can use it without importing the store.
export { mockAddress, mockHash } from "./mock-hash";

let clockMs: number | undefined;

/** The mock's clock: the wall clock, except inside withClock (a scenario builder replaying its history). */
export const mockNow = (): number => clockMs ?? Date.now();

/**
 * Runs `fn` (synchronous, so nothing else runs meanwhile) with the mock's clock at `ms`: the traces, ids and timestamps
 * it makes without an explicit time are dated then. Only scenario-lived/ uses it, to date the sample's history.
 */
export function withClock<T>(ms: number, fn: () => T): T {
  const before = clockMs;
  clockMs = ms;
  try {
    return fn();
  } finally {
    clockMs = before;
  }
}

export const nowIso = (ms = mockNow()): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const nowUnix = (ms = mockNow()): string => String(Math.floor(ms / 1000));

/** UUIDv7 from a timestamp plus a counter (lowercase, canonical). */
export function uuidV7(st: MockState, ms = mockNow()): string {
  st.counter += 1;
  const ts = ms.toString(16).padStart(12, "0").slice(-12);
  const rand = st.counter.toString(16).padStart(15, "0").slice(-15);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 15).padStart(12, "0")}`;
}

// ---- founder key -----------------------------------------------------------------------------------

/**
 * The key a passkey assertion must verify against. On-chain there is one founder key: once the officer registered it,
 * only that credential signs (approveFounderKey refuses a second one).
 * Mock-only shortcut, NOT chain behaviour (decision (a) of P1's #6 reviews): before the officer registers a key, the
 * chain accepts no founder signature at all, but the demo lets the founder sign with the pending key (PENDING_LENDER),
 * as the UI does right after "Create your passkey first". Since G2 (G0-DECISIONS §11) registering a key takes the
 * officer's one-time enrolment code, and one key is pending at a time, so until the officer's step the pending key is
 * trusted as far as that code is. A key the officer rejected never signs. Consequences:
 *   - what the pending key signs applies at once (a plan committed, a supplier bound, a release), never undone by a
 *     later reject;
 *   - a LoosenRequest it signed waits FOUNDER_SIGNED with that credential recorded; if the key is rejected (or another
 *     one registered) before the officer approves, the approval is refused and the request goes back to OPEN
 *     (exceptions.ts), as on-chain queueLoosen verifies the founder's signature against the registered key.
 */
export function founderKeyFor(st: MockState, credentialId: string): FounderKey | undefined {
  const onchain = [...st.founderKeys.values()].find((k) => k.onchain === "REGISTERED");
  if (onchain) return onchain.credentialId === credentialId ? onchain : undefined;
  if (st.rejectedFounderKeys.has(credentialId)) return undefined;
  return st.founderKeys.get(credentialId);
}

// ---- session -------------------------------------------------------------------------------------

export function sessionFor(st: MockState, env: MockEnv, persona: Persona): Session {
  return { ...st.baseSession, persona, mode: env.replayRunId ? "replay" : "mock" };
}

// ---- traces (hash chain over every event the mock appends) -----------------------------------------

export type NewTrace = Omit<TraceEvent, "seq" | "prevHash" | "hash" | "ts"> & { ts?: string };

export function appendTrace(st: MockState, input: NewTrace): TraceEvent {
  // Next seq after the highest one in this trace (seeded traces may not number from 0).
  const seq = st.traces.reduce((max, t) => (t.traceId === input.traceId && t.seq >= max ? t.seq + 1 : max), 0);
  const prevHash = st.traces.at(-1)?.hash ?? ZERO_HEX32;
  const body = { ...input, ts: input.ts ?? nowIso(), seq, prevHash };
  const event: TraceEvent = { ...body, hash: hashObject(body) };
  st.traces.push(event);
  return event;
}

// ---- balances --------------------------------------------------------------------------------------

export function pocketOf(st: MockState, lineKey: LineKey): Pocket | undefined {
  return st.balances.pockets.find((p) => p.lineKey === lineKey);
}

/** Adds `delta` (may be negative) to a Minor field, never below zero. */
/**
 * What Treasury.commitPlan does to an empty ledger (the fresh scenario's first plan): one pocket per manifest line
 * (allocated = the line amount, nothing spent) and the first stage (gate null) released at commit.
 * A ledger that already has pockets (the default seed, or a replan) is left as it is.
 */
export function commitPlanLedger(st: MockState, manifest: PlanManifest): void {
  if (st.balances.pockets.length > 0) return;
  const pockets: Pocket[] = manifest.lines.map((l) => ({
    lineKey: l.lineKey,
    allocated: l.amountMinor,
    spent: "0",
    available: l.amountMinor,
    perTxCap: l.perTxCapMinor,
    windowCap: l.windowCapMinor,
    windowSpent: "0",
    validUntil: l.validUntil,
    paused: false,
    circuitOpen: false,
  }));
  const first = manifest.stages.find((x) => x.gate === null);
  st.balances = {
    ...st.balances,
    pockets,
    releasedMinor: first ? addMinor(st.balances.releasedMinor, parseMinor(first.releaseMinor)) : st.balances.releasedMinor,
  };
}

export function addMinor(value: string, delta: bigint): string {
  const next = parseMinor(value) + delta;
  return toMinor(next < 0n ? 0n : next);
}

export function updatePocket(st: MockState, lineKey: LineKey, update: (p: Pocket) => Pocket): void {
  st.balances = { ...st.balances, pockets: st.balances.pockets.map((p) => (p.lineKey === lineKey ? update(p) : p)) };
}

export function currentPlan(st: MockState): PlanRecord | undefined {
  return [...st.plans].reverse().find((p) => p.status === "COMMITTED") ?? st.plans.at(-1);
}
