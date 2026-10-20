/**
 * Mock supplier terms (VISION-DECISIONS §5, §9): POST /api/orders/terms and GET /api/orders/terms/:id over the store,
 * mirroring the live API (packages/api services/supplier-terms.ts): the same checks in the same order with the same
 * TERMS_* reasons (the holder check is the API's own pure function), core termsToSchedule under the committed plan's
 * SUPPLIER pocket, the channel fixed to MOCK_ONLY, immutable rows (a correction supersedes; USED once signed).
 * Mock-only shortcuts: no sanctions list (live screens holder and seller, 503 when it cannot); cooling lasts
 * DEMO_TIMELOCK_SECONDS (the mock's one demo delay, default 120 s, as the deployments use); after it, as the live
 * worker, the agent's deposit is a scripted FUND_MILESTONE payment that releases it, and every held milestone (the
 * balance) is escrowed in full by another FUND_MILESTONE that stops at FINALIZED (no payout until the founder's release),
 * applied on the next request (http.ts; no timers).
 */
import { ROUTE_EXAMPLES } from "@hogee/api-contract";
import { holderMatchesSeller } from "@hogee/api";
import {
  MILESTONE_LABELS,
  OrderTerms,
  WEB_PAYOUT_CHANNEL,
  formatBu,
  hashObject,
  isPlainName,
  isWebSupplierId,
  jcs,
  parseMinor,
  payoutAccountHash,
  shortlistHashOf,
  termsToSchedule,
  webMilestoneRows,
  webPayoutRows,
  webQuoteHash,
  type CandidateCard,
  type Hex32,
  type MilestoneInput,
  type OrderTermsInput,
  type ScheduleRow,
  type Shortlist,
  type SupplierSearch,
  type TermsErrorCode,
  type TermsLimits,
} from "@hogee/core";
import { scheduleHash } from "../eip712";
import type { Handlers } from "../http";
import type { Failure } from "../result";
import { appendTrace, currentPlan, mockNow, nextId, nowIso, pocketOf, uuidV7, type MockState, type ScriptedPayment } from "../store";
import { ESCROW_PATH, createScriptedPayment } from "../transitions";
import { outflowRefusal } from "../spend-policy";
import * as searchFeature from "./search";

export const TERMS_ID_RE = /^terms-[0-9a-f-]{36}$/;
const WEB_SUPPLIER_SUFFIX = /^supplier-(w[a-z2-7]{12})$/;
const MAX_AGE_MS = 7 * 86_400_000;
/** The live writer bound (supplier-terms.ts): at most this many new terms rows per TERMS_WINDOW_MS; a reused row counts nothing. */
export const MAX_TERMS_PER_WINDOW = 30;
const TERMS_WINDOW_MS = 600_000;
const MOCK_ONLY_CURRENCIES = ["MYR", "SGD"];
/** The live API's VALIDATION codes (services/terms-checks.ts STATUS_OF); every other TERMS_* code is CONFLICT here. */
const VALIDATION_CODES: ReadonlySet<TermsErrorCode> = new Set([
  "TERMS_COUNT", "TERMS_PCT_RANGE", "TERMS_PCT_SUM", "TERMS_TRIGGER_ORDER", "TERMS_LAST_NOT_INSPECTED", "TERMS_TOTAL_INVALID",
  "TERMS_MILESTONE_ZERO", "TERMS_AUTO_NOT_FIRST", "TERMS_WEB_AUTO_COUNT", "TERMS_UPFRONT_OVER_HALF",
  "TERMS_PAYEE_PERSONAL", "TERMS_ACCOUNT_FORMAT", "TERMS_HOLDER_MISMATCH",
]);

export const termsRefusal = (code: TermsErrorCode, message: string, idx?: number): Failure => ({
  code: VALIDATION_CODES.has(code) ? "VALIDATION" : code === "TERMS_SANCTIONS" ? "FORBIDDEN" : "CONFLICT",
  message,
  details: { reason: code, ...(idx === undefined ? {} : { idx }) },
});

export interface MockTerms {
  readonly termsId: string;
  status: "CONFIRMED" | "SUPERSEDED" | "USED";
  readonly supplierId: string;
  readonly displayName: string;
  readonly listingHost: string;
  readonly searchId: string;
  /** The search's shortlist hash, as SupplierApproval signs it and WEB_TERMS commits to it (mockCandidate). */
  readonly shortlistHash: Hex32;
  readonly chosenIndex: number;
  readonly currency: string;
  readonly totalMinor: string;
  readonly quantity: number;
  readonly milestones: readonly MilestoneInput[];
  readonly schedule: readonly ScheduleRow[];
  readonly account: { readonly channel: string; readonly accountNumber: string; readonly holderName: string };
  readonly payoutAccountHash: Hex32;
  readonly bankName: string;
  readonly createdAt: string;
  orderId: string | null;
  coolingEndsAtMs: number | null;
  /** The bindPayee transaction the SupplierApproval sent (the order card's seal). */
  bindTxHash: Hex32 | null;
  /** Milestone idx → the scripted payment that paid it (auto-released milestones). */
  readonly paid: Map<number, string>;
  /** Milestone idx → the scripted payment that escrowed it (held milestones: funded, released only by the founder). */
  readonly escrowed: Map<number, string>;
}

const STORES = new WeakMap<MockState, Map<string, MockTerms>>();

/** This store's terms (a reset builds a new store, so its terms go with it). */
export function termsStore(st: MockState): Map<string, MockTerms> {
  let m = STORES.get(st);
  if (!m) STORES.set(st, (m = new Map()));
  return m;
}

// ---- the web search the candidate comes from (v-search's mock; the contract example until it lands) ---------------

interface SearchApi {
  mockWebSearch?: (st: MockState, searchId: string) => { readonly search: SupplierSearch; readonly createdAtMs: number; readonly shortlist?: Shortlist | null } | undefined;
  mockWebSupplier?: (st: MockState, supplierId: string) => { readonly sellerName: string; readonly listingHost: string } | undefined;
}
const searchApi = searchFeature as unknown as SearchApi;

interface FoundSearch {
  readonly search: SupplierSearch;
  readonly createdAtMs: number;
  /** The scorer's Shortlist the search stored (null for the contract example, which has none). */
  readonly shortlist: Shortlist | null;
}

function webSearchOf(st: MockState, searchId: string): FoundSearch | undefined {
  const found = searchApi.mockWebSearch?.(st, searchId);
  if (found) return { search: found.search, createdAtMs: found.createdAtMs, shortlist: found.shortlist ?? null };
  // Like getSupplierSearch: the api-contract example's id still answers its example (never a computed search).
  const example = ROUTE_EXAMPLES.getSupplierSearch.res;
  return searchId === example.searchId ? { search: example, createdAtMs: Date.now(), shortlist: null } : undefined;
}

/**
 * The shortlist hash SupplierApproval signs: as live (terms-candidate.ts readySearch), recomputed with shortlistHashOf
 * and equal to the one the search stored, or undefined when they differ. Only the api-contract example, which stores
 * no Shortlist, stands in with a hash of its search id.
 */
function shortlistHashFor(found: FoundSearch): Hex32 | undefined {
  if (!found.shortlist) return found.search.searchId === ROUTE_EXAMPLES.getSupplierSearch.res.searchId ? hashObject({ searchId: found.search.searchId }) : undefined;
  const recomputed = shortlistHashOf(found.shortlist);
  return found.shortlist.shortlistHash?.toLowerCase() === recomputed.toLowerCase() ? recomputed : undefined;
}

export interface MockCandidate {
  readonly card: CandidateCard;
  readonly shortlistHash: Hex32;
  readonly chosenIndex: number;
  readonly sellerName: string;
  readonly listingHost: string;
}

const notOrderable = (why: string) => termsRefusal("TERMS_CANDIDATE", `${why}; search again or pick another supplier`);

/** TERMS_CANDIDATE, as live: an orderable web candidate of a READY search under 7 days old. */
export function mockCandidate(st: MockState, searchId: string, supplierId: string, nowMs: number): MockCandidate | Failure {
  const found = webSearchOf(st, searchId);
  if (!found) return { code: "NOT_FOUND", message: "No such supplier search", details: { reason: "TERMS_CANDIDATE" } };
  if (found.search.status !== "READY") return notOrderable("That search is not finished");
  const shortlistHash = shortlistHashFor(found);
  if (!shortlistHash) return notOrderable("That search's stored result is unreadable");
  if (nowMs - found.createdAtMs > MAX_AGE_MS) return notOrderable("That search is more than 7 days old");
  const chosenIndex = found.search.candidates.findIndex((c) => c.supplierId === supplierId);
  const card = found.search.candidates[chosenIndex];
  if (!card || !isWebSupplierId(supplierId) || card.origin !== "web" || !card.unverified || !card.canOrder || card.failedGates.length > 0) return notOrderable("That supplier is not an orderable candidate of the search");
  const seller = searchApi.mockWebSupplier?.(st, supplierId) ?? { sellerName: card.displayName, listingHost: card.listingHost ?? "" };
  return { card, shortlistHash, chosenIndex, sellerName: seller.sellerName, listingHost: seller.listingHost };
}

/** The committed plan's SUPPLIER pocket now, less what open escrow orders still have to fund (as live). */
export function mockLimits(st: MockState): TermsLimits | Failure {
  const plan = currentPlan(st);
  if (!plan || plan.status !== "COMMITTED") return { code: "CONFLICT", message: "No plan is committed yet" };
  const line = plan.manifest.lines.find((l) => l.lineKey === "SUPPLIER" && l.escrowOnly);
  if (!line) return termsRefusal("TERMS_OVER_POCKET", "The committed plan has no escrow-only supplier pocket");
  const pocket = pocketOf(st, "SUPPLIER");
  let open = 0n;
  for (const schedule of st.escrow.values()) for (const m of schedule) if (!m.released) open += parseMinor(m.amountMinor) - parseMinor(m.funded);
  const free = parseMinor(pocket?.available ?? line.amountMinor) - open;
  const window = pocket ? parseMinor(pocket.windowCap) - parseMinor(pocket.windowSpent) : parseMinor(line.windowCapMinor);
  return { freeMinor: free > 0n ? free : 0n, perTxCapMinor: parseMinor(pocket?.perTxCap ?? line.perTxCapMinor), windowCapMinor: window > 0n ? window : 0n };
}

/** core termsToSchedule for a web supplier, or its refusal. */
export function mockSchedule(totalMinor: string, milestones: readonly MilestoneInput[], limits: TermsLimits): ScheduleRow[] | Failure {
  const r = termsToSchedule({ totalMinor: parseMinor(totalMinor), milestones, origin: "web" }, limits);
  if (!r.ok) return termsRefusal(r.code, "These payment terms break a schedule rule", r.idx);
  return milestones.map((m, idx) => ({ idx, trigger: m.trigger, label: MILESTONE_LABELS[m.trigger], amountMinor: (r.amounts[idx] as bigint).toString(), autoRelease: r.autoRelease[idx] as boolean, released: false, txHash: null }));
}

/** The order a web supplier gets (one per supplier): order-w<12>-001. */
export const webOrderIdOf = (supplierId: string): string => `order-${WEB_SUPPLIER_SUFFIX.exec(supplierId)?.[1] ?? "x"}-001`;

const bound = (st: MockState, supplierId: string): boolean =>
  st.escrow.has(webOrderIdOf(supplierId)) || [...termsStore(st).values()].some((t) => t.supplierId === supplierId && t.status === "USED");

/** TERMS_ACCOUNT_FORMAT, as live (accountFormatOk): the MOCK_ONLY bank form, never one repeated digit. */
const accountOk = (n: string): boolean => /^[0-9]{4,34}$/.test(n) && !/^(\d)\1*$/.test(n);

/** POST /api/orders/terms at `nowMs`: the live checks in order, then a new CONFIRMED row (or the identical one already saved). */
export function confirmOrderTerms(st: MockState, input: OrderTermsInput, nowMs: number): MockTerms | Failure {
  if (input.quantity > 100_000) return { code: "VALIDATION", message: "The quantity can be at most 100,000" };
  const c = mockCandidate(st, input.searchId, input.supplierId, nowMs);
  if ("code" in c) return c;
  const currency = st.facility.currency;
  if (!MOCK_ONLY_CURRENCIES.includes(currency)) return termsRefusal("TERMS_CURRENCY", `The facility is in ${currency}; simulated payouts carry MYR or SGD only`);
  const p = input.payout;
  if (p.payeeType !== "company") return termsRefusal("TERMS_PAYEE_PERSONAL", "Hogee pays suppliers only into a company account, never a personal one");
  if (!accountOk(p.accountNumber)) return termsRefusal("TERMS_ACCOUNT_FORMAT", "That account number is not a usable bank account number");
  // As live (the body schema refuses these first): never a name that does not render as what it says.
  if (!isPlainName(p.bankName)) return { code: "VALIDATION", message: "The bank name must not contain invisible or control characters" };
  if (!isPlainName(p.holderName)) return termsRefusal("TERMS_HOLDER_MISMATCH", "The account holder must not contain invisible or control characters");
  if (!holderMatchesSeller(p.holderName, c.sellerName)) return termsRefusal("TERMS_HOLDER_MISMATCH", "The account holder must be a company whose name matches the seller on the listing");
  const limits = mockLimits(st);
  if ("code" in limits) return limits;
  const schedule = mockSchedule(input.totalMinor, input.milestones, limits);
  if ("code" in schedule) return schedule;
  if (bound(st, input.supplierId)) return termsRefusal("TERMS_ALREADY_BOUND", "This supplier already has its order; a web supplier gets one order");
  const account = { channel: WEB_PAYOUT_CHANNEL, accountNumber: p.accountNumber, holderName: p.holderName };
  const milestones = input.milestones.map((m) => ({ bps: m.bps, trigger: m.trigger }));
  const store = termsStore(st);
  const same = [...store.values()].find(
    (t) => t.status === "CONFIRMED" && t.supplierId === input.supplierId && t.searchId === input.searchId && t.totalMinor === input.totalMinor && t.quantity === input.quantity
      && jcs(t.milestones) === jcs(milestones) && jcs(t.account) === jcs(account) && t.bankName === p.bankName,
  );
  if (same) return same;
  const recent = [...store.values()].filter((t) => Date.parse(t.createdAt) > nowMs - TERMS_WINDOW_MS).length;
  if (recent >= MAX_TERMS_PER_WINDOW) return { code: "CONFLICT", message: "Too many changes to the terms in the last 10 minutes; nothing was saved. Try again in a few minutes" };
  for (const t of store.values()) if (t.supplierId === input.supplierId && t.status === "CONFIRMED") t.status = "SUPERSEDED";
  const terms: MockTerms = {
    termsId: `terms-${uuidV7(st, nowMs)}`,
    status: "CONFIRMED",
    supplierId: input.supplierId,
    displayName: c.card.displayName,
    listingHost: c.listingHost,
    searchId: input.searchId,
    shortlistHash: c.shortlistHash,
    chosenIndex: c.chosenIndex,
    currency,
    totalMinor: input.totalMinor,
    quantity: input.quantity,
    milestones,
    schedule,
    account,
    payoutAccountHash: payoutAccountHash(account),
    bankName: p.bankName,
    createdAt: nowIso(nowMs),
    orderId: null,
    coolingEndsAtMs: null,
    bindTxHash: null,
    paid: new Map(),
    escrowed: new Map(),
  };
  store.set(terms.termsId, terms);
  appendTrace(st, { traceId: nextId(st, "trace"), actor: "founder", kind: "PROPOSAL", summary: `Founder confirmed terms for ${terms.supplierId}; nothing is paid before the SupplierApproval and its cooling`, refs: {} });
  return terms;
}

/** The terms as WEB_TERMS commits to them (SupplierApproval.quoteHash): core webQuoteHash, the live API's preimage. */
export const mockQuoteHash = (t: MockTerms): Hex32 =>
  webQuoteHash({
    termsId: t.termsId,
    supplierId: t.supplierId,
    shortlistHash: t.shortlistHash,
    chosenIndex: t.chosenIndex,
    currency: t.currency,
    totalMinor: t.totalMinor,
    milestones: t.milestones,
    payeeType: "company",
    payoutAccountHash: t.payoutAccountHash,
  });

/**
 * After cooling (and while payments are not paused), as the live worker funds them in index order: the agent pays each
 * auto milestone itself (released once mined) and escrows each held one in full (funded once mined, never released
 * by the agent; the founder's MilestoneRelease with evidence pays it out). A milestone the released total cannot hold
 * yet waits (the chain's fundMilestone would revert), as a paused pocket does.
 */
export function advanceWebOrders(st: MockState, nowMs = mockNow()): void {
  for (const t of termsStore(st).values()) {
    if (t.status !== "USED" || !t.orderId || t.coolingEndsAtMs === null || t.coolingEndsAtMs > nowMs) continue;
    // As the chain: a paused treasury, or a paused or tripped supplier pocket, funds nothing (fundMilestone reverts).
    const pocket = pocketOf(st, "SUPPLIER");
    const held = st.balances.paused || pocket?.paused === true || pocket?.circuitOpen === true;
    if (!held) fundWebMilestones(st, t, nowMs);
    const schedule = st.escrow.get(t.orderId);
    if (!schedule) continue;
    const mined = (by: Map<number, string>, idx: number) => st.payments.find((sp) => sp.payment.paymentId === by.get(idx))?.applied.has("INCLUDED") === true;
    st.escrow.set(
      t.orderId,
      schedule.map((m) => {
        if (m.autoRelease && !m.released && mined(t.paid, m.idx)) return { ...m, funded: m.amountMinor, released: true };
        if (!m.autoRelease && !m.released && m.funded === "0" && mined(t.escrowed, m.idx)) return { ...m, funded: m.amountMinor };
        return m;
      }),
    );
  }
}

/** One FUND_MILESTONE per milestone not funded yet: the deposit pays out (settles), a held milestone stops in escrow. */
function fundWebMilestones(st: MockState, t: MockTerms, nowMs: number): void {
  const fundedNow = (idx: number) => st.escrow.get(t.orderId ?? "")?.[idx]?.funded !== "0";
  for (const row of t.schedule) {
    // As the chain: fundMilestone reverts past the released total; the worker tries again on a later pass.
    if (outflowRefusal(st, row.amountMinor, true)) continue;
    if (row.autoRelease) {
      if (t.paid.has(row.idx)) continue;
      const sp = createScriptedPayment(st, { kind: "FUND_MILESTONE", lineKey: "SUPPLIER", payeeId: t.supplierId, amountMinor: row.amountMinor, reason: `Pay the deposit of ${t.orderId} exactly as pre-signed, by itself after cooling` }, nowMs);
      t.paid.set(row.idx, sp.payment.paymentId);
    } else if (!t.escrowed.has(row.idx) && !fundedNow(row.idx)) {
      const sp = createScriptedPayment(
        st,
        {
          kind: "FUND_MILESTONE",
          lineKey: "SUPPLIER",
          payeeId: t.supplierId,
          amountMinor: row.amountMinor,
          reason: `Escrow milestone ${row.idx + 1} of ${t.orderId} in full, exactly as pre-signed; it is paid out only when the founder releases it with inspection evidence`,
          policy: { verdict: "AUTO", reasonCode: "WITHIN_PLAN", summary: "Within the signed schedule: escrow funding only; nothing leaves escrow without the founder's release" },
          path: ESCROW_PATH,
        },
        nowMs,
      );
      t.escrowed.set(row.idx, sp.payment.paymentId);
    }
  }
}

/** The payment that paid a released milestone: its scripted funding (auto) or the founder's release. */
export function milestonePayment(st: MockState, t: MockTerms, row: Pick<ScheduleRow, "idx" | "amountMinor">): ScriptedPayment | undefined {
  const id = t.paid.get(row.idx);
  return id
    ? st.payments.find((x) => x.payment.paymentId === id)
    : st.payments.find((x) => x.payment.kind === "RELEASE_MILESTONE" && x.payment.payeeId === t.supplierId && x.payment.amountMinor === row.amountMinor);
}

/** The tx that paid a released milestone. */
const paidTx = (st: MockState, t: MockTerms, row: ScheduleRow): `0x${string}` | null => (milestonePayment(st, t, row)?.payment.txHash as `0x${string}` | undefined) ?? null;

export function orderTermsOf(st: MockState, t: MockTerms): OrderTerms {
  const escrow = t.orderId ? st.escrow.get(t.orderId) : undefined;
  return OrderTerms.parse({
    termsId: t.termsId,
    status: t.status,
    supplierId: t.supplierId,
    displayName: t.displayName,
    origin: "web",
    currency: t.currency,
    totalMinor: t.totalMinor,
    quantity: t.quantity,
    milestones: t.milestones,
    schedule: t.schedule.map((r) => {
      const released = escrow?.[r.idx]?.released === true;
      return { ...r, released, txHash: released ? paidTx(st, t, r) : null };
    }),
    payoutAccountHash: t.payoutAccountHash,
    holderName: t.account.holderName,
    orderId: t.status === "USED" ? t.orderId : null,
    coolingEndsAt: t.status === "USED" && t.coolingEndsAtMs !== null ? nowIso(t.coolingEndsAtMs) : null,
    bindTxHash: t.status === "USED" ? t.bindTxHash : null,
    createdAt: t.createdAt,
  });
}

/**
 * Like the store's example aliases: in the default scenario (a status gallery whose supplier pocket is already used)
 * the api-contract example request and id still answer their example. The fresh and lived scenarios never alias, so
 * the journey always runs the real checks.
 */
const SUBMIT_EXAMPLE = ROUTE_EXAMPLES.submitOrderTerms;
const READ_EXAMPLE = ROUTE_EXAMPLES.getOrderTerms;
const isSubmitExample = (st: MockState, body: unknown): boolean =>
  st.scenario === "default" && JSON.stringify(body) === JSON.stringify(SUBMIT_EXAMPLE.req.body);

export const orderHandlers: Pick<Handlers, "submitOrderTerms" | "getOrderTerms"> = {
  submitOrderTerms: ({ req, st }) => {
    const out = confirmOrderTerms(st, req.body, Date.now());
    if ("code" in out && isSubmitExample(st, req.body)) return SUBMIT_EXAMPLE.res;
    return "code" in out ? out : orderTermsOf(st, out);
  },
  getOrderTerms: ({ req, st }) => {
    advanceWebOrders(st);
    const t = TERMS_ID_RE.test(req.params.id) ? termsStore(st).get(req.params.id) : undefined;
    if (t) return orderTermsOf(st, t);
    if (st.scenario === "default" && req.params.id === READ_EXAMPLE.req.params.id) return READ_EXAMPLE.res;
    return { code: "NOT_FOUND", message: "No such supplier terms" };
  },
};

// ---- the web SupplierApproval (signing.ts calls these for a terms-… refId) -----------------------------------------

type Row = { label: string; value: string; effect: "neutral" | "tighten" | "loosen" };

/** The terms row `termsId` re-checked as live planWebOrder does: CONFIRMED, still a candidate, the schedule under the current pocket. */
export function webApprovalCheck(st: MockState, termsId: string, nowMs = mockNow()): MockTerms | Failure {
  const t = termsStore(st).get(termsId);
  if (!t) return { code: "NOT_FOUND", message: "No such supplier terms" };
  if (t.status === "SUPERSEDED") return termsRefusal("TERMS_SUPERSEDED", "These terms were replaced by newer ones; sign the newest terms");
  if (t.status === "USED") return termsRefusal("TERMS_ALREADY_BOUND", "These terms are already approved; a web supplier gets one order");
  const c = mockCandidate(st, t.searchId, t.supplierId, nowMs);
  if ("code" in c) return c;
  // As live (planWebOrder recomputes quoteHash with the search's current shortlist hash and index).
  if (c.chosenIndex !== t.chosenIndex || c.shortlistHash !== t.shortlistHash) return { code: "CONFLICT", message: "The search result changed since the terms were confirmed; confirm the terms again" };
  if (!holderMatchesSeller(t.account.holderName, c.sellerName)) return termsRefusal("TERMS_HOLDER_MISMATCH", "The account holder no longer matches the seller on the listing");
  const limits = mockLimits(st);
  if ("code" in limits) return limits;
  const schedule = mockSchedule(t.totalMinor, t.milestones, limits);
  if ("code" in schedule) return schedule;
  if (jcs(schedule.map((r) => [r.amountMinor, r.autoRelease])) !== jcs(t.schedule.map((r) => [r.amountMinor, r.autoRelease]))) {
    return { code: "CONFLICT", message: "The schedule changed since the terms were confirmed; confirm the terms again" };
  }
  if (bound(st, t.supplierId)) return termsRefusal("TERMS_ALREADY_BOUND", "This supplier already has its order; a web supplier gets one order");
  return t;
}

const bu = (minor: string, currency: string): string => `${formatBu(minor)} (facility: ${currency})`;

/** What the founder reads and signs for web terms: the live rows and the live hashes (core and the chain's abi encoding). */
export function webApprovalDraft(st: MockState, termsId: string, tag: (label: string) => string, lineId: string): { title: string; message: Record<string, string | boolean>; rows: Row[] } | Failure {
  const terms = webApprovalCheck(st, termsId);
  if ("code" in terms) return terms;
  const orderId = webOrderIdOf(terms.supplierId);
  const rows: Row[] = [
    { label: "Order", value: orderId, effect: "neutral" },
    { label: "Supplier", value: `${terms.displayName}, found by web search`, effect: "neutral" },
    { label: "Found by web search, not verified", value: `Listing on ${terms.listingHost || "a listing site"}. Nobody has checked this seller's registration, certificates or address.`, effect: "loosen" },
    // The live rows (core builders): holder, whole account and bank apart; the browser recomputes both hashes from them.
    ...webPayoutRows({ holderName: terms.account.holderName, accountNumber: terms.account.accountNumber, bankName: terms.bankName }),
    { label: "Order total", value: `${bu(terms.totalMinor, terms.currency)} for ${terms.quantity.toLocaleString("en")} units`, effect: "neutral" },
    ...webMilestoneRows(terms.schedule),
    { label: "Paid from", value: "The supplier pocket, through escrow only", effect: "neutral" },
    { label: "Cooling period", value: "Nothing is paid before it ends; the loan officer can pause every agent payment until then", effect: "neutral" },
  ];
  const message = {
    orderId: tag(orderId),
    supplierId: tag(terms.supplierId),
    payee: tag(terms.supplierId),
    payoutAccountHash: terms.payoutAccountHash,
    lineId,
    // The chain's abi encoding (not the mock's JCS shortcut): the browser recomputes it from the milestone rows.
    scheduleHash: scheduleHash(terms.schedule.map((r) => BigInt(r.amountMinor)), terms.schedule.map((r) => r.autoRelease)),
    totalMinor: terms.totalMinor,
    quoteHash: mockQuoteHash(terms),
    shortlistHash: terms.shortlistHash,
    chosenIndex: String(terms.chosenIndex),
    inspectionRequired: true,
  };
  return { title: `Choose ${terms.displayName} and sign its payment schedule`, message, rows };
}

/** At submit: the terms become USED with their order; the payee cools for `coolingSeconds`, then the agent pays the deposit. */
export function applyWebApproval(st: MockState, termsId: string, nowMs: number, coolingSeconds: number, bindTxHash: Hex32): void {
  const t = termsStore(st).get(termsId);
  if (!t || t.status !== "CONFIRMED") return;
  t.status = "USED";
  t.orderId = webOrderIdOf(t.supplierId);
  t.coolingEndsAtMs = nowMs + coolingSeconds * 1000;
  t.bindTxHash = bindTxHash;
  st.escrow.set(t.orderId, t.schedule.map((r) => ({ idx: r.idx, amountMinor: r.amountMinor, funded: "0", released: false, autoRelease: r.autoRelease })));
  appendTrace(st, { traceId: nextId(st, "trace"), actor: "worker", kind: "TX", summary: `${t.supplierId} bound for ${t.orderId}; it cools before any payment (the officer can pause during cooling)`, refs: {} });
}

/** The web terms behind an escrow order, if it is one. */
export const webTermsOfOrder = (st: MockState, orderId: string): MockTerms | undefined => [...termsStore(st).values()].find((t) => t.orderId === orderId && t.status === "USED");
