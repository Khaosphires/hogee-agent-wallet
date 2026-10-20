/**
 * Builds the sample business (MOCK_SCENARIO=lived) from a fresh store by playing story.ts through the mock's own
 * transitions, in time order, on the mock's clock (store.ts withClock): the plan is committed as a PlanApproval would
 * commit it, the officer funds it, the web searches, terms, SupplierApprovals, delivery check and release go through
 * the same functions the routes use, every payment is a scripted payment that walks to SETTLED, every sale goes through
 * the oracle's recordSale. Nothing is a hand-written balance.
 *
 * Fail closed: every step is re-checked by the code the live path runs (buildSignatureRequest for each signature,
 * spendRefusal for each payment: caps, binding, released total; termsToSchedule through confirmOrderTerms); a step it refuses
 * throws, and the store is never served half built.
 *
 * Honesty: no key signed anything here. Each signature leaves a SIGNATURE trace that says so, no signature request is
 * stored, and no FounderSig other than `seeded-fixture` is recorded. Every hash is a mock label (mock mode never links
 * one to an explorer), and every proposal reads "Sample: …".
 */
import {
  ChatDataPart,
  TERMS_PRESET_MILESTONES,
  deriveJourney,
  journeyFactsOf,
  listOfSearch,
  parseMinor,
  readHistory,
  sha256Bytes,
  type Exception,
  type Hex32,
  type JourneyState,
  type LineKey,
  type OrderTermsInput,
  type PlanDraft,
  type SignatureKind,
  type SourceFacts,
} from "@hogee/core";
import type { MockEnv } from "../env";
import { createException, officerApprove } from "../exceptions";
import { confirmOrderTerms, applyWebApproval, advanceWebOrders, type MockTerms } from "../features/orders";
import { mockWebSearch, mockWebSupplier, startWebSearchAt } from "../features/search";
import { fundFacilityWith } from "../handlers-core";
import { isFailure } from "../result";
import { recordSale } from "../sales";
import { applyMilestoneRelease, applyPlanApproval, buildSignatureRequest } from "../signing";
import { payeeBound, spendRefusal } from "../spend-policy";
import { recordInspection } from "../supplier-order";
import { appendTrace, currentPlan, mockHash, nextId, nowIso, withClock, type MockState, type ScriptedPayment } from "../store";
import { SETTLE_PATH, STEP_MS, advance, createScriptedPayment } from "../transitions";
import { OFFICER_AFTER_MIN, SIGN_AFTER_MIN, STORY, storySales, whenMs, type OrderRef, type SearchRef, type StoryStep } from "./story";

const MINUTE_MS = 60_000;
/** A scripted payment walks SETTLE_PATH one STEP_MS at a time; the builder ticks at each step (so traces stay in time order). */
const SETTLE_STEPS = SETTLE_PATH.length;
/** The executor runs a matured loosening 3 s after it becomes executable (transitions.ts EXECUTOR_DELAY_MS). */
const EXECUTOR_MS = 3_500;
/** What the sample's delivery check "report" says (its sha256 is the evidence hash; the file is made up). */
const CHECK_REPORT = (orderId: string) => `Sample delivery check for ${orderId}: cartons counted and opened, tumblers as ordered. Made up for the demo; not a real inspection.`;
const SAMPLE_BANK = "Sample Bank (made up)";

class SampleRefused extends Error {
  constructor(step: string, why: string) {
    super(`api-mock: the sample business could not be built: ${step} was refused (${why})`);
  }
}

/** What the transcript needs from the second order: the journey's state when its terms were saved and when it was signed. */
export interface OrderMoments {
  readonly termsId: string;
  readonly saved: JourneyState;
  readonly signed: JourneyState;
  /** When Mei saved the terms and signed the order: the transcript's presses carry these times (their UUIDv7 ids). */
  readonly savedAtMs: number;
  readonly signedAtMs: number;
}

export interface BuiltStory {
  readonly commitAtMs: number;
  readonly orders: Readonly<Record<OrderRef, MockTerms>>;
  readonly latest: OrderMoments;
  readonly sales: ReturnType<typeof storySales>;
}

interface Pending {
  readonly atMs: number;
  readonly seq: number;
  readonly run: () => void | Promise<void>;
}

/** A time-ordered queue: the story's steps plus the follow-ups they schedule (settling, cooling, the timelock). */
class Timeline {
  private items: Pending[] = [];
  private seq = 0;

  at(atMs: number, run: Pending["run"]): void {
    this.items.push({ atMs, seq: (this.seq += 1), run });
  }

  async play(tick: (atMs: number) => void): Promise<void> {
    for (;;) {
      this.items.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
      const next = this.items.shift();
      if (!next) return;
      tick(next.atMs);
      await next.run();
    }
  }
}

/** The INCLUDED time of a scripted payment (when the chain counted it), or undefined for a seeded one. */
function includedAtMs(sp: ScriptedPayment): number | undefined {
  const s = sp.script;
  const idx = s?.path.indexOf("INCLUDED") ?? -1;
  return s && idx >= 0 ? s.startMs + idx * s.stepMs : undefined;
}

/**
 * Each pocket's windowSpent as the chain's rollingSpent reads it at `atMs`: the line's mined spends of the last
 * windowSeconds (the mock otherwise only adds to it).
 */
export function rollWindows(st: MockState, atMs: number): void {
  const lines = new Map((currentPlan(st)?.manifest.lines ?? []).map((l) => [l.lineKey, l] as const));
  st.balances = {
    ...st.balances,
    pockets: st.balances.pockets.map((p) => {
      const windowMs = Number(lines.get(p.lineKey)?.windowSeconds ?? "0") * 1000;
      const spent = st.payments
        .filter((sp) => sp.payment.lineKey === p.lineKey && (sp.payment.kind === "SPEND" || sp.payment.kind === "OWNER_SPEND") && sp.applied.has("INCLUDED"))
        .filter((sp) => {
          const at = includedAtMs(sp);
          return at !== undefined && at > atMs - windowMs && at <= atMs;
        })
        .reduce((sum, sp) => sum + parseMinor(sp.payment.amountMinor), 0n);
      return { ...p, windowSpent: spent.toString() };
    }),
  };
}

/** A deterministic, plainly made-up company account number for a sample supplier (12 digits, never one repeated digit). */
function sampleAccountNumber(supplierId: string): string {
  const digits = BigInt(mockHash(`sample-account:${supplierId}`)).toString().slice(0, 10);
  return `62${digits}`;
}

/** The founder's signature in the sample's history: checked as a request would be, recorded as made up. */
function sampleSignature(st: MockState, kind: SignatureKind, refId: string, atMs: number, what: string): Hex32 {
  const request = buildSignatureRequest(st, { kind, refId, method: "passkey" }, atMs);
  if (isFailure(request)) throw new SampleRefused(`${kind} ${refId}`, request.message);
  const txHash = mockHash(`tx:sample:${kind}:${refId}`);
  const traceId = nextId(st, "trace");
  appendTrace(st, { traceId, actor: "founder", kind: "SIGNATURE", summary: `Sample history: Mei signed ${what} (${kind}). Made up for the demo: no passkey signed it`, refs: {}, ts: nowIso(atMs) });
  appendTrace(st, { traceId, actor: "worker", kind: "TX", summary: `Relayer submitted the signed ${kind} (sample history)`, refs: { txHash }, ts: nowIso(atMs) });
  return txHash;
}

function draftOf(st: MockState): PlanDraft {
  const draft = st.drafts.get(st.loaded.scenario["plan-draft.json"].draftId);
  if (!draft) throw new SampleRefused("the plan", "no plan draft in the seed");
  return draft;
}

/** The journey's state for the second order's transcript, from the store's own facts (as journey/facts.ts reads them). */
function journeyAt(st: MockState, t: MockTerms, searchId: string, atMs: number): JourneyState {
  const search = mockWebSearch(st, searchId)?.search;
  const milestones = t.orderId ? (st.escrow.get(t.orderId) ?? []) : [];
  const src: SourceFacts = {
    facilityId: st.facility.facilityId,
    persona: st.profile.founderPersona,
    now: nowIso(atMs),
    draftId: draftOf(st).draftId,
    planStatus: currentPlan(st)?.status ?? null,
    founderKeyActive: true,
    list: search ? listOfSearch(search) : null,
    terms: { termsId: t.termsId, supplierId: t.supplierId, status: t.status },
    order:
      t.status === "USED" && t.orderId
        ? {
            orderId: t.orderId,
            supplierId: t.supplierId,
            bound: t.coolingEndsAtMs !== null,
            coolingEndsAt: t.coolingEndsAtMs === null ? null : nowIso(t.coolingEndsAtMs),
            firstPaid: milestones[0]?.released ?? false,
            balancePaid: milestones.length > 0 && milestones.every((m) => m.released),
          }
        : null,
  } as SourceFacts;
  return deriveJourney(journeyFactsOf(src, readHistory([])));
}

/** The payee a story spend goes to: the line's own payee, else one an executed ADD_PAYEE bound to it. */
function payeeOf(st: MockState, lineKey: LineKey): string {
  const line = currentPlan(st)?.manifest.lines.find((l) => l.lineKey === lineKey);
  const added = [...st.exceptions.values()].map((s) => s.exception).find((e): e is Extract<Exception, { kind: "ADD_PAYEE" }> => e.kind === "ADD_PAYEE" && e.status === "EXECUTED" && e.payload.lineKey === lineKey);
  const payeeId = line?.payeeIds[0] ?? added?.payload.payeeId;
  if (!payeeId || !payeeBound(st, lineKey, payeeId)) throw new SampleRefused(`a ${lineKey} payment`, "no payee is bound to the line");
  return payeeId;
}

/** Plays the story into `st` (a fresh store whose scenario is lived), dated relative to `builtAtMs`. */
export async function playStory(st: MockState, env: MockEnv, builtAtMs: number): Promise<BuiltStory> {
  if (st.scenario !== "lived" || st.plans.length > 0 || st.payments.length > 0) throw new SampleRefused("the build", "the store is not a fresh lived store");
  const timeline = new Timeline();
  const searches = new Map<SearchRef, string>();
  const orders = new Map<OrderRef, MockTerms>();
  const slots = new Map<LineKey, number>();
  let latest: OrderMoments | undefined;
  let commitAtMs = 0;

  const settleAt = (atMs: number) => timeline.at(atMs, () => undefined);
  /** Ticks at every step of payments started at `atMs`, so two of them settling together interleave in time order. */
  const settleFrom = (atMs: number) => {
    for (let i = 1; i <= SETTLE_STEPS; i += 1) settleAt(atMs + i * STEP_MS);
  };
  const tick = (atMs: number) =>
    withClock(atMs, () => {
      advance(st, atMs);
      advanceWebOrders(st, atMs);
      rollWindows(st, atMs);
    });

  const steps: Record<StoryStep["kind"], (step: never, atMs: number) => void | Promise<void>> = {
    commit: (_s: Extract<StoryStep, { kind: "commit" }>, atMs) =>
      withClock(atMs, () => {
        const draft = draftOf(st);
        applyPlanApproval(st, draft, sampleSignature(st, "PlanApproval", draft.draftId, atMs, "the plan"));
        commitAtMs = atMs;
      }),
    fund: (s: Extract<StoryStep, { kind: "fund" }>, atMs) => withClock(atMs, () => void fundFacilityWith(st, s.amountMinor)),
    search: async (s: Extract<StoryStep, { kind: "search" }>, atMs) => {
      const out = await startWebSearchAt(st, env, s.quantity, atMs);
      if (isFailure(out)) throw new SampleRefused(`the ${s.ref} supplier search`, out.message);
      searches.set(s.ref, out.searchId);
    },
    "add-payee": (s: Extract<StoryStep, { kind: "add-payee" }>, atMs) => {
      const created = withClock(atMs, () => createException(st, { kind: "ADD_PAYEE", payload: { payeeId: st.profile.ids.packagingPayeeId, lineKey: s.lineKey }, reason: s.reason }, "founder"));
      if (isFailure(created)) throw new SampleRefused("adding the packaging printer", created.message);
      const signAt = atMs + SIGN_AFTER_MIN * MINUTE_MS;
      timeline.at(signAt, () =>
        withClock(signAt, () => {
          const se = st.exceptions.get(created.exceptionId);
          if (!se) throw new SampleRefused("adding the packaging printer", "the request is gone");
          sampleSignature(st, "LoosenRequest", created.exceptionId, signAt, `the request to add a packaging printer`);
          se.exception = { ...se.exception, status: "FOUNDER_SIGNED" };
          se.founderSig = { kind: "seeded-fixture" };
        }),
      );
      const approveAt = signAt + OFFICER_AFTER_MIN * MINUTE_MS;
      timeline.at(approveAt, () =>
        withClock(approveAt, () => {
          const se = st.exceptions.get(created.exceptionId);
          const approved = se ? officerApprove(st, se, env.timelockSeconds) : undefined;
          if (!approved || isFailure(approved)) throw new SampleRefused("the officer's approval", approved ? approved.message : "the request is gone");
          settleAt(approveAt + env.timelockSeconds * 1000 + EXECUTOR_MS);
        }),
      );
    },
    order: (s: Extract<StoryStep, { kind: "order" }>, atMs) => placeOrder(s, atMs),
    "delivery-check": (s: Extract<StoryStep, { kind: "delivery-check" }>, atMs) => {
      const orderId = orders.get(s.order)?.orderId;
      if (!orderId) throw new SampleRefused(`the delivery check of the ${s.order} order`, "no such order");
      withClock(atMs, () => recordInspection(st, orderId, sha256Bytes(new TextEncoder().encode(CHECK_REPORT(orderId))) as Hex32));
      const signAt = atMs + SIGN_AFTER_MIN * MINUTE_MS;
      timeline.at(signAt, () =>
        withClock(signAt, () => {
          sampleSignature(st, "MilestoneRelease", orderId, signAt, `the balance of ${orderId} after the delivery check`);
          applyMilestoneRelease(st, orderId, signAt);
          settleFrom(signAt);
        }),
      );
    },
    spend: (s: Extract<StoryStep, { kind: "spend" }>, atMs) => withClock(atMs, () => spend(s, atMs)),
  };

  function placeOrder(s: Extract<StoryStep, { kind: "order" }>, atMs: number): void {
    const searchId = searches.get(s.search);
    const candidate = searchId ? mockWebSearch(st, searchId)?.search.candidates.find((c) => c.rank === s.rank) : undefined;
    const seller = candidate ? mockWebSupplier(st, candidate.supplierId) : undefined;
    if (!searchId || !candidate || !seller) throw new SampleRefused(`the ${s.ref} order`, `no rank ${s.rank} candidate in the ${s.search} search`);
    const input: OrderTermsInput = {
      supplierId: candidate.supplierId,
      searchId,
      quantity: s.quantity,
      totalMinor: s.totalMinor,
      milestones: TERMS_PRESET_MILESTONES[s.preset].map((m) => ({ ...m })),
      payout: { payeeType: "company", holderName: seller.sellerName, bankName: SAMPLE_BANK, accountNumber: sampleAccountNumber(candidate.supplierId) },
    };
    const terms = withClock(atMs, () => confirmOrderTerms(st, input, atMs));
    if (isFailure(terms)) throw new SampleRefused(`the ${s.ref} order's terms`, terms.message);
    const saved = journeyAt(st, terms, searchId, atMs);
    const signAt = atMs + SIGN_AFTER_MIN * MINUTE_MS;
    timeline.at(signAt, () =>
      withClock(signAt, () => {
        const txHash = sampleSignature(st, "SupplierApproval", terms.termsId, signAt, `the order with the ${s.ref} supplier`);
        applyWebApproval(st, terms.termsId, signAt, env.timelockSeconds, txHash);
        orders.set(s.ref, terms);
        latest = { termsId: terms.termsId, saved, signed: journeyAt(st, terms, searchId, signAt), savedAtMs: atMs, signedAtMs: signAt };
        // After cooling the agent funds the deposit and escrows the balance (advanceWebOrders on the next tick).
        const fundAt = (terms.coolingEndsAtMs ?? signAt) + 1000;
        settleAt(fundAt);
        settleFrom(fundAt);
        settleAt(fundAt + (SETTLE_STEPS + 1) * STEP_MS);
      }),
    );
  }

  function spend(s: Extract<StoryStep, { kind: "spend" }>, atMs: number): void {
    const line = currentPlan(st)?.manifest.lines.find((l) => l.lineKey === s.lineKey);
    const amountMinor = s.amountMinor ?? line?.pacing?.amountMinor;
    if (!line || !amountMinor) throw new SampleRefused(`a ${s.lineKey} payment`, "no amount (an invoice amount or the line's pacing slot)");
    const payeeId = payeeOf(st, s.lineKey);
    // The signed plan's caps, the payee binding and the released and funded total (spend-policy.ts), as Treasury.spend.
    const refusal = spendRefusal(st, s.lineKey, payeeId, amountMinor);
    if (refusal) throw new SampleRefused(`a ${s.lineKey} payment of ${amountMinor}`, refusal.summary);
    const slot = line.pacing ? (slots.get(s.lineKey) ?? 0) + 1 : undefined;
    const sp = createScriptedPayment(st, { kind: "SPEND", lineKey: s.lineKey, payeeId, amountMinor, reason: `Sample: ${s.reason}${slot ? ` (slot ${slot})` : ""}` }, atMs);
    if (slot) slots.set(s.lineKey, slot);
    st.usedIntents.add(slot ? `${s.lineKey}:slot:${slot}` : `invoice:${sp.payment.paymentId}`);
    settleFrom(atMs);
  }

  for (const step of STORY) {
    const atMs = whenMs(builtAtMs, step.at);
    if (atMs >= builtAtMs) throw new SampleRefused(step.kind, "the story step is not in the past");
    timeline.at(atMs, () => steps[step.kind](step as never, atMs));
  }
  const sales = storySales(builtAtMs);
  for (const sale of sales) timeline.at(sale.atMs, () => withClock(sale.atMs, () => recordSale(st, sale.saleId, sale.amountMinor.toString(), sale.atMs)));
  timeline.at(builtAtMs, () => undefined);
  await timeline.play(tick);

  const first = orders.get("first");
  const second = orders.get("second");
  if (!first || !second || !latest) throw new SampleRefused("the orders", "an order was not placed");
  st.autonomy = { ...st.autonomy, pacingSlot: slots.get("ADS") ?? 0 };
  return { commitAtMs, orders: { first, second }, latest, sales };
}

/** The data-order card of an order (core parts.ts orderPart, which core does not export). */
export const orderCard = (termsId: string): ChatDataPart => ChatDataPart.parse({ type: "data-order", id: `order-${termsId}`, data: { termsId } });
