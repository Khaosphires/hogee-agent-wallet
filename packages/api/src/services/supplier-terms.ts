/**
 * Supplier terms (VISION-DECISIONS §9). POST /api/orders/terms is the ONLY way a payout account arrives: never chat,
 * listing text or a model. confirm checks, in this order (each refusal names its TERMS_* reason):
 *   1. the candidate is in a READY web search of this facility, orderable and under 7 days old (terms-candidate.ts);
 *   2. the facility's currency is the server's and the MOCK_ONLY channel may pay it;
 *   3. the payee is a company; 4. the account number has the MOCK_ONLY form;
 *   5. the holder names a company and shares a distinctive word with the Reader's seller name (terms-names.ts);
 *   6. sanctions on the holder and the seller (503 when screening cannot run);
 *   7. core termsToSchedule under the CURRENT SUPPLIER limits (origin web);
 *   8. one order per web supplier (TERMS_ALREADY_BOUND).
 * Then one immutable supplier_terms row is written with the channel fixed to MOCK_ONLY ("simulated payout"); the live
 * CONFIRMED row of that supplier, if any, moves to SUPERSEDED (the only update a row ever gets besides → USED, which
 * the SupplierApproval commit makes). An identical CONFIRMED row is returned again instead of a new one.
 */
import { OrderTerms, isPlainName, jcs, payoutAccountHash, webQuoteHash, type MilestoneInput, type OrderTermsInput, type ScheduleRow } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { newId } from "./ids";
import { inTx, one, pool, rows, type Q } from "./sql";
import { HIDDEN_NAME, webCandidateOf } from "./terms-candidate";
import {
  TERMS_ID_RE,
  accountFormatOk,
  payoutAccountOf,
  scheduleRowsOf,
  screenTermsNames,
  supplierLimits,
  termsCurrency,
  termsFailure,
  webSchedule,
} from "./terms-checks";
import { holderMatchesSeller } from "./terms-names";
import { appendTrace } from "./traces";

/** Same bound as a search body (SupplierSearchBody); keeps the integer column in range. */
const MAX_QUANTITY = 100_000;
/**
 * Writer bound (the request-bounds pattern): at most this many new terms rows per facility in TERMS_WINDOW_S. Anyone
 * reads as the founder in DEMO_MODE, so corrections are bounded; an identical body reuses its row and counts nothing.
 */
export const MAX_TERMS_PER_WINDOW = 30;
const TERMS_WINDOW_S = 600;
const PAID_STATES = ["INCLUDED", "FINALIZED", "SETTLEMENT_REQUESTED", "SETTLED", "SETTLEMENT_FAILED"];

/** TERMS_ALREADY_BOUND: one order per web supplier (a re-bind would restart cooling and replace the account). */
export async function requireUnbound(q: Q, scope: Scope, supplierId: string): Promise<void> {
  const bound = await one(
    q,
    `select 1 as x where exists (select 1 from supplier_terms where facility_id = $1 and supplier_id = $2 and status = 'USED')
        or exists (select 1 from escrow_orders where facility_id = $1 and supplier_id = $2)
        or exists (select 1 from payees where facility_id = $1 and id = $2)`,
    [scope.facilityId, supplierId],
  );
  if (bound) throw termsFailure("TERMS_ALREADY_BOUND", "This supplier already has its order; a web supplier gets one order");
}

/** The immutable row. A live row of the supplier that appeared meanwhile (the partial unique index) is TERMS_ALREADY_BOUND. */
async function insertTerms(q: Q, values: unknown[]): Promise<void> {
  try {
    await q.query(
      `insert into supplier_terms (id, facility_id, shortlist_id, supplier_id, chosen_index, currency, quote_total_minor, quantity, terms_json,
         schedule_json, payout_account_ref, payout_account_hash, bank_name, payee_type, quote_hash, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, 'CONFIRMED')`,
      values,
    );
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === "23505") throw termsFailure("TERMS_ALREADY_BOUND", "This supplier's terms were approved meanwhile; a web supplier gets one order");
    throw error;
  }
}

/** Checks 1–8 of the header, then the row. Returns the terms as GET /api/orders/terms/:id serves them. */
export async function confirmOrderTerms(deps: ApiDeps, scope: Scope, input: OrderTermsInput): Promise<OrderTerms> {
  const db = pool(deps.db);
  if (input.quantity > MAX_QUANTITY) throw fail("VALIDATION", `The quantity can be at most ${MAX_QUANTITY.toLocaleString("en")}`);
  const c = await webCandidateOf(deps, db, scope, input.searchId, input.supplierId);
  const currency = await termsCurrency(deps, db, scope);
  const p = input.payout;
  if (p.payeeType !== "company") throw termsFailure("TERMS_PAYEE_PERSONAL", "Hogee pays suppliers only into a company account, never a personal one");
  if (!accountFormatOk(p.accountNumber)) throw termsFailure("TERMS_ACCOUNT_FORMAT", "That account number is not a usable bank account number");
  // The body schema refuses these already (core isPlainName); checked again for any caller that skips it.
  if (!isPlainName(p.bankName)) throw fail("VALIDATION", "The bank name must not contain invisible or control characters");
  if (!isPlainName(p.holderName)) throw termsFailure("TERMS_HOLDER_MISMATCH", "The account holder must not contain invisible or control characters");
  if (!holderMatchesSeller(p.holderName, c.sellerName)) {
    throw termsFailure("TERMS_HOLDER_MISMATCH", "The account holder must be a company whose name matches the seller on the listing");
  }
  await screenTermsNames(deps, [p.holderName, c.sellerName]);
  const totalMinor = BigInt(input.totalMinor);
  const schedule = webSchedule(totalMinor, input.milestones, await supplierLimits(deps, scope));
  await requireUnbound(db, scope, input.supplierId);

  const account = payoutAccountOf(p);
  const accountHash = payoutAccountHash(account);
  const milestones: MilestoneInput[] = input.milestones.map((m) => ({ bps: m.bps, trigger: m.trigger }));
  const termsId = await inTx(deps.db, async (q) => {
    // One decision per facility at a time: the bound check, the reuse and the supersede see the same rows.
    await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`supplier-terms:${scope.facilityId}`]);
    await requireUnbound(q, scope, input.supplierId);
    const same = await one<{ id: string }>(
      q,
      `select id from supplier_terms where facility_id = $1 and supplier_id = $2 and status = 'CONFIRMED' and shortlist_id = $3
          and quote_total_minor = $4 and quantity = $5 and terms_json = $6::jsonb and payout_account_hash = $7 and bank_name = $8`,
      [scope.facilityId, input.supplierId, c.shortlistId, input.totalMinor, input.quantity, JSON.stringify(milestones), accountHash, p.bankName],
    );
    if (same) return same.id;
    const recent = await one<{ n: number }>(q, "select count(*)::int as n from supplier_terms where facility_id = $1 and created_at > now() - make_interval(secs => $2)", [
      scope.facilityId,
      TERMS_WINDOW_S,
    ]);
    if ((recent?.n ?? 0) >= MAX_TERMS_PER_WINDOW) throw fail("CONFLICT", "Too many changes to the terms in the last 10 minutes; nothing was saved. Try again in a few minutes");
    const id = newId("terms");
    const quoteHash = webQuoteHash({
      termsId: id,
      supplierId: input.supplierId,
      shortlistHash: c.shortlistHash,
      chosenIndex: c.chosenIndex,
      currency,
      totalMinor: input.totalMinor,
      milestones,
      payeeType: p.payeeType,
      payoutAccountHash: accountHash,
    });
    await q.query("update supplier_terms set status = 'SUPERSEDED', updated_at = now() where facility_id = $1 and supplier_id = $2 and status = 'CONFIRMED'", [
      scope.facilityId,
      input.supplierId,
    ]);
    await insertTerms(q, [
      id,
      scope.facilityId,
      c.shortlistId,
      input.supplierId,
      c.chosenIndex,
      currency,
      input.totalMinor,
      input.quantity,
      JSON.stringify(milestones),
      JSON.stringify(scheduleRowsOf(milestones, schedule)),
      jcs(account),
      accountHash,
      p.bankName,
      p.payeeType,
      quoteHash,
    ]);
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: id,
      actor: "founder",
      kind: "PROPOSAL",
      summary: `Founder confirmed terms for ${input.supplierId}: ${schedule.amounts.length} milestones, simulated payout account ending ${p.accountNumber.slice(-4)}; nothing is paid before the SupplierApproval and its cooling`,
    });
    return id;
  });
  return readOrderTerms(deps, scope, termsId);
}

interface TermsRow {
  id: string;
  shortlist_id: string;
  supplier_id: string;
  currency: string;
  quote_total_minor: string;
  quantity: number;
  terms_json: MilestoneInput[];
  schedule_json: ScheduleRow[];
  payout_account_ref: string;
  payout_account_hash: string;
  status: "CONFIRMED" | "SUPERSEDED" | "USED";
  order_id: string | null;
  created_at: Date;
}

/** The card's (wording-checked) seller name from the stored search; "(name hidden)" when there is none. */
async function displayNameOf(q: Q, scope: Scope, shortlistId: string, supplierId: string): Promise<string> {
  const r = await one<{ name: unknown }>(
    q,
    `select c->>'displayName' as name from shortlists s, jsonb_array_elements(coalesce(s.search_json->'candidates', '[]'::jsonb)) c
      where s.facility_id = $1 and s.id = $2 and c->>'supplierId' = $3 limit 1`,
    [scope.facilityId, shortlistId, supplierId],
  );
  return typeof r?.name === "string" && r.name.length > 0 && r.name.length <= 120 ? r.name : HIDDEN_NAME;
}

/** USED terms: each row's release state and the tx that paid it (funding for an auto milestone, else the release). */
async function mirroredSchedule(q: Q, scope: Scope, orderId: string, confirmed: readonly ScheduleRow[]): Promise<ScheduleRow[]> {
  const ms = await rows<{ idx: number; released: boolean }>(
    q,
    "select idx, released_minor > 0 as released from escrow_milestones where facility_id = $1 and order_id = $2",
    [scope.facilityId, orderId],
  );
  const txs = await rows<{ idx: number; kind: string; tx_hash: string }>(
    q,
    `select milestone_idx as idx, kind::text as kind, tx_hash from payments
      where facility_id = $1 and order_id = $2 and tx_hash is not null and kind in ('FUND_MILESTONE', 'RELEASE_MILESTONE') and state::text = any($3::text[])
      order by created_at desc`,
    [scope.facilityId, orderId, PAID_STATES],
  );
  return confirmed.map((r) => {
    const released = ms.some((m) => Number(m.idx) === r.idx && m.released);
    const tx = txs.find((t) => Number(t.idx) === r.idx && t.kind === (r.autoRelease ? "FUND_MILESTONE" : "RELEASE_MILESTONE"));
    return { ...r, released, txHash: released && tx ? (tx.tx_hash.toLowerCase() as `0x${string}`) : null };
  });
}

/** The bound payee's cooling end (chain-mirrored unix seconds), once the binding is on-chain. */
async function coolingEndsAt(q: Q, scope: Scope, supplierId: string): Promise<string | null> {
  const p = await one<{ cooling_until: string | null }>(
    q,
    "select cooling_until::text as cooling_until from payees where facility_id = $1 and id = $2 and status in ('COOLING', 'BOUND')",
    [scope.facilityId, supplierId],
  );
  return p?.cooling_until ? new Date(Number(p.cooling_until) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : null;
}

/** Chain actions whose transaction has landed (a broadcast one may still revert, so it seals nothing yet). */
const LANDED_ACTION_STATES = ["INCLUDED", "FINALIZED"];

/**
 * The order's Treasury.bindPayee transaction (the founder's SupplierApproval) once it has landed: the order card's seal.
 * Null while it is pending or broadcast, and when it reverted.
 */
async function bindTxHash(q: Q, scope: Scope, orderId: string): Promise<`0x${string}` | null> {
  const a = await one<{ tx_hash: string }>(
    q,
    `select tx_hash from chain_actions
      where facility_id = $1 and kind = 'Treasury.bindPayee' and ref_id = $2 and tx_hash is not null and state::text = any($3::text[])
      order by created_at desc limit 1`,
    [scope.facilityId, orderId, LANDED_ACTION_STATES],
  );
  return a ? (a.tx_hash.toLowerCase() as `0x${string}`) : null;
}

/** GET /api/orders/terms/:id (facility-scoped). */
export async function readOrderTerms(deps: ApiDeps, scope: Scope, termsId: string): Promise<OrderTerms> {
  if (!TERMS_ID_RE.test(termsId)) throw fail("NOT_FOUND", "No such supplier terms");
  const db = pool(deps.db);
  const r = await one<TermsRow>(
    db,
    `select id, shortlist_id, supplier_id, currency, quote_total_minor::text as quote_total_minor, quantity, terms_json, schedule_json,
            payout_account_ref, payout_account_hash, status, order_id, created_at
       from supplier_terms where facility_id = $1 and id = $2`,
    [scope.facilityId, termsId],
  );
  if (!r) throw fail("NOT_FOUND", "No such supplier terms");
  const account = JSON.parse(r.payout_account_ref) as { holderName?: unknown };
  const used = r.status === "USED" && r.order_id !== null;
  return OrderTerms.parse({
    termsId: r.id,
    status: r.status,
    supplierId: r.supplier_id,
    displayName: await displayNameOf(db, scope, r.shortlist_id, r.supplier_id),
    origin: "web",
    currency: r.currency,
    totalMinor: r.quote_total_minor,
    quantity: Number(r.quantity),
    milestones: r.terms_json,
    schedule: used ? await mirroredSchedule(db, scope, r.order_id as string, r.schedule_json) : r.schedule_json,
    payoutAccountHash: r.payout_account_hash,
    holderName: account.holderName,
    orderId: used ? r.order_id : null,
    coolingEndsAt: used ? await coolingEndsAt(db, scope, r.supplier_id) : null,
    bindTxHash: used ? await bindTxHash(db, scope, r.order_id as string) : null,
    createdAt: new Date(r.created_at).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}
