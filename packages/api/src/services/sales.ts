/**
 * §9.2 sales oracle, API half (task 1.12): a VERIFIED Stripe test event (routes/webhooks.ts checks the signature
 * first) becomes at most one sale per payment. Only `payment_intent.succeeded` and a paid `checkout.session.completed`
 * can count; every other event type is acknowledged untouched. A counting event must be test mode, carry THIS
 * facility's id in its metadata (the facility comes from server config, never from the request), be in the
 * facility's currency and have a positive amount of at least one bucket; otherwise it is acknowledged with no effect
 * and an ALERT trace that never echoes the event's own text.
 *
 * Dedupe, all enforced by Postgres uniques inside one transaction:
 *   - per event: sales.stripe_event_id (and, for ignored events, a trace id derived from the event id);
 *   - per payment: sales.id is derived from the PaymentIntent id, so `checkout.session.completed` and
 *     `payment_intent.succeeded` for the same payment record ONE sale (a refunded or zero order never gets a row,
 *     so it never reaches METRIC_ORDERS on-chain).
 *
 * Ids on-chain and in the database are hashes only (§14.1): saleIdHash = keccak256(utf8(event.id)) (SalesOracle,
 * @hogee/chain), sales.id = "sale-" + sha256(PaymentIntent id). The amount is rounded down to SALE_BUCKET_MINOR.
 * The API writes the sales row, an UNSIGNED SalesOracle.recordSale action and an oracle trace; only the worker signs.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { utf8Keccak } from "../chain-lib";
import type { ApiDeps, Scope } from "../context";
import { insertAction, wake } from "./actions";
import { facilityRow } from "./facility";
import { inTx, one, pool, type Q } from "./sql";
import { appendTrace } from "./traces";

/** G0-DECISION (amountBucket = minor units rounded down off-chain): one major unit (RM1.00 for MYR). */
export const SALE_BUCKET_MINOR = 100n;

/** The only event types that can count as a sale. */
export const SALE_EVENT_TYPES: ReadonlySet<string> = new Set(["payment_intent.succeeded", "checkout.session.completed"]);

/** A verified Stripe event (routes/webhooks.ts parses only the envelope). */
export interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly object: unknown;
}

export type WebhookOutcome = { readonly duplicate?: true };

interface Sale {
  readonly kind: "sale";
  readonly paymentIntentId: string;
  readonly bucket: bigint;
}

interface Ignored {
  readonly kind: "ignored";
  readonly reasonCode: string;
  /** Fixed text chosen here, never event content. */
  readonly why: string;
}

const PI_ID = z.string().regex(/^pi_[A-Za-z0-9_]{1,250}$/);
const AMOUNT = z.number().int().refine(Number.isSafeInteger);
const CURRENCY = z.string().regex(/^[a-z]{3}$/);

const PaymentIntent = z.object({
  object: z.literal("payment_intent"),
  id: PI_ID,
  status: z.string(),
  amount_received: AMOUNT,
  currency: CURRENCY,
  livemode: z.boolean(),
  metadata: z.unknown(),
});

const CheckoutSession = z.object({
  object: z.literal("checkout.session"),
  id: z.string().regex(/^cs_[A-Za-z0-9_]{1,250}$/),
  mode: z.string(),
  payment_status: z.string(),
  amount_total: AMOUNT.nullable(),
  currency: CURRENCY.nullable(),
  livemode: z.boolean(),
  payment_intent: z.union([PI_ID, z.object({ id: PI_ID }), z.null()]),
  metadata: z.unknown(),
});

const ignored = (reasonCode: string, why: string): Ignored => ({ kind: "ignored", reasonCode, why });

/** metadata.facilityId as an own string property (no record parsing of untrusted keys such as __proto__). */
function metadataFacility(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null || !Object.hasOwn(metadata, "facilityId")) return null;
  const v = (metadata as { facilityId?: unknown }).facilityId;
  return typeof v === "string" ? v : null;
}

interface Normalised {
  readonly livemode: boolean;
  readonly facilityId: string | null;
  readonly paid: boolean;
  readonly currency: string | null;
  readonly amount: number | null;
  readonly paymentIntentId: string | null;
}

function normalise(event: StripeEvent): Normalised | null {
  if (event.type === "payment_intent.succeeded") {
    const p = PaymentIntent.safeParse(event.object);
    if (!p.success) return null;
    const o = p.data;
    return { livemode: o.livemode, facilityId: metadataFacility(o.metadata), paid: o.status === "succeeded", currency: o.currency, amount: o.amount_received, paymentIntentId: o.id };
  }
  const s = CheckoutSession.safeParse(event.object);
  if (!s.success) return null;
  const o = s.data;
  const pi = o.payment_intent === null ? null : typeof o.payment_intent === "string" ? o.payment_intent : o.payment_intent.id;
  return { livemode: o.livemode, facilityId: metadataFacility(o.metadata), paid: o.mode === "payment" && o.payment_status === "paid", currency: o.currency, amount: o.amount_total, paymentIntentId: pi };
}

/** What a counting-type event means for this facility: one bucketed sale, or why it is ignored. */
export function interpretSaleEvent(event: StripeEvent, facility: { readonly facilityId: string; readonly currency: string }): Sale | Ignored {
  if (event.livemode !== false) return ignored("STRIPE_LIVEMODE", "a live-mode event (only Stripe test mode is accepted)");
  const n = normalise(event);
  if (!n) return ignored("STRIPE_UNREADABLE", "the payment object is not in the expected shape");
  if (n.livemode) return ignored("STRIPE_LIVEMODE", "a live-mode payment (only Stripe test mode is accepted)");
  if (n.facilityId !== facility.facilityId) return ignored("STRIPE_OTHER_FACILITY", "the payment is not for this facility");
  if (!n.paid) return ignored("STRIPE_UNPAID", "the payment is not paid");
  if (n.currency === null || n.currency.toUpperCase() !== facility.currency.toUpperCase()) return ignored("STRIPE_CURRENCY", `the payment is not in ${facility.currency}`);
  if (n.amount === null || n.amount <= 0) return ignored("STRIPE_ZERO_AMOUNT", "a zero or negative amount never counts as an order");
  const bucket = (BigInt(n.amount) / SALE_BUCKET_MINOR) * SALE_BUCKET_MINOR;
  if (bucket === 0n) return ignored("STRIPE_BELOW_BUCKET", `the amount is below one bucket (${SALE_BUCKET_MINOR} minor)`);
  if (n.paymentIntentId === null) return ignored("STRIPE_NO_PAYMENT", "no PaymentIntent to count the sale against");
  return { kind: "sale", paymentIntentId: n.paymentIntentId, bucket };
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
/** One sale per payment: the sales row id is a hash of the PaymentIntent id (the raw id is never stored). */
export const saleIdForPayment = (paymentIntentId: string): string => `sale-${sha256(`hogee:stripe-payment:${paymentIntentId}`)}`;
/** The trace of an event that did not count (its id doubles as the per-event dedupe key for ignored events). */
const ignoredTraceId = (eventId: string): string => `stripe-${sha256(`hogee:stripe-event:${eventId}`).slice(0, 40)}`;
const lockTrace = (q: Q, facilityId: string, traceId: string) => q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`trace:${facilityId}:${traceId}`]);

async function seenBefore(q: Q, facilityId: string, eventId: string): Promise<boolean> {
  const hit = await one(
    q,
    `select 1 from sales where facility_id = $1 and stripe_event_id = $2
     union all select 1 from traces where facility_id = $1 and trace_id = $3 limit 1`,
    [facilityId, eventId, ignoredTraceId(eventId)],
  );
  return hit !== undefined;
}

/** Traces an ignored event once; a replay (same event id) is a duplicate. */
async function ignore(deps: ApiDeps, scope: Scope, event: StripeEvent, why: Ignored): Promise<{ readonly traced: boolean }> {
  const traceId = ignoredTraceId(event.id);
  const traced = await inTx(deps.db, async (q) => {
    await lockTrace(q, scope.facilityId, traceId);
    if (await one(q, "select 1 from traces where facility_id = $1 and trace_id = $2 limit 1", [scope.facilityId, traceId])) return false;
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId,
      actor: "oracle",
      kind: "ALERT",
      reasonCode: why.reasonCode,
      summary: `Stripe event ignored, no sale recorded: ${why.why}`,
    });
    return true;
  });
  deps.log.info("stripe_event_ignored", { reasonCode: why.reasonCode });
  return { traced };
}

type Recorded = "recorded" | "same-event" | "same-payment";

async function recordSale(deps: ApiDeps, scope: Scope, event: StripeEvent, sale: Sale, currency: string): Promise<Recorded> {
  const saleId = saleIdForPayment(sale.paymentIntentId);
  const saleIdHash = utf8Keccak(event.id).toLowerCase();
  const amountBucket = sale.bucket.toString();
  return inTx(deps.db, async (q): Promise<Recorded> => {
    // Any unique (event id, sale id hash, or the per-payment row id) makes this a no-op: one sale per event and payment.
    const inserted = await q.query(
      `insert into sales (id, facility_id, stripe_event_id, sale_id_hash, amount_bucket) values ($1, $2, $3, $4, $5) on conflict do nothing returning id`,
      [saleId, scope.facilityId, event.id, saleIdHash, amountBucket],
    );
    if (inserted.rowCount !== 1) {
      const prior = await one<{ stripe_event_id: string }>(q, "select stripe_event_id from sales where facility_id = $1 and id = $2", [scope.facilityId, saleId]);
      return prior && prior.stripe_event_id !== event.id ? "same-payment" : "same-event";
    }
    await insertAction(q, { facilityId: scope.facilityId, kind: "SalesOracle.recordSale", refId: saleId, request: { saleId, saleIdHash, amountBucket } });
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: saleId,
      actor: "oracle",
      kind: "TX",
      summary: `Verified Stripe test sale of ${amountBucket} minor ${currency} (bucketed); queued for SalesOracle.recordSale, signed by the oracle key in the worker`,
    });
    return "recorded";
  });
}

/**
 * The effect of a verified event: `{}` (recorded, or acknowledged with no effect) or `{duplicate: true}` (this event,
 * or another event for the same payment, was already handled).
 */
export async function handleStripeEvent(deps: ApiDeps, scope: Scope, event: StripeEvent): Promise<WebhookOutcome> {
  if (!SALE_EVENT_TYPES.has(event.type)) {
    deps.log.info("stripe_event_other_type", { type: event.type.slice(0, 64) });
    return {};
  }
  const db = pool(deps.db);
  const facility = await facilityRow(db, scope);
  if (!facility) {
    // Nothing can be recorded (or traced) before the loan officer opens the facility.
    deps.log.warn("stripe_event_before_facility", { type: event.type });
    return {};
  }
  if (await seenBefore(db, scope.facilityId, event.id)) return { duplicate: true };
  const meaning = interpretSaleEvent(event, { facilityId: scope.facilityId, currency: facility.currency });
  if (meaning.kind === "ignored") return (await ignore(deps, scope, event, meaning)).traced ? {} : { duplicate: true };
  const outcome = await recordSale(deps, scope, event, meaning, facility.currency);
  if (outcome === "same-event") return { duplicate: true };
  if (outcome === "same-payment") {
    await ignore(deps, scope, event, ignored("STRIPE_DUPLICATE_PAYMENT", "this payment is already counted (one payment counts once)"));
    return { duplicate: true };
  }
  await wake(deps, "record-sale");
  await wake(deps, "cfo-guard");
  return {};
}
