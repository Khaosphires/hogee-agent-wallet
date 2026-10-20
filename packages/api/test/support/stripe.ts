/**
 * Stripe test helpers: events shaped like Stripe's (test mode), signed exactly as Stripe signs them
 * (`Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`). Ids and secrets are generated at runtime;
 * nothing secret is committed.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { StripePort, StripeTestPayment } from "../../src/context";

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

export const stripeIds = {
  event: (): string => `evt_test${hex(12)}`,
  paymentIntent: (): string => `pi_test${hex(12)}`,
  session: (): string => `cs_test_${hex(12)}`,
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The header Stripe would send for `raw`, signed with `secret` at `t` (unix seconds). */
export function signStripe(secret: string, raw: string, t: number = nowSeconds()): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

export interface SaleOptions {
  /** metadata.facilityId; null leaves metadata empty. */
  readonly facilityId: string | null;
  readonly amountMinor?: number;
  readonly currency?: string;
  readonly livemode?: boolean;
  readonly eventId?: string;
  readonly paymentIntentId?: string;
}

export interface TestEvent {
  readonly id: string;
  readonly object: "event";
  readonly type: string;
  readonly livemode: boolean;
  readonly created: number;
  readonly api_version: string;
  readonly data: { readonly object: Record<string, unknown> };
}

const metadataOf = (facilityId: string | null): Record<string, string> => (facilityId === null ? {} : { facilityId });

export function stripeEvent(type: string, object: Record<string, unknown>, o: { eventId?: string; livemode?: boolean } = {}): TestEvent {
  return { id: o.eventId ?? stripeIds.event(), object: "event", type, livemode: o.livemode ?? false, created: nowSeconds(), api_version: "2025-09-30.clover", data: { object } };
}

export function paymentIntentSucceeded(o: SaleOptions): TestEvent {
  const amount = o.amountMinor ?? 50_000;
  return stripeEvent(
    "payment_intent.succeeded",
    {
      id: o.paymentIntentId ?? stripeIds.paymentIntent(),
      object: "payment_intent",
      amount,
      amount_received: amount,
      currency: o.currency ?? "myr",
      livemode: o.livemode ?? false,
      status: "succeeded",
      metadata: metadataOf(o.facilityId),
    },
    o,
  );
}

export function checkoutSessionCompleted(o: SaleOptions & { readonly paymentStatus?: string }): TestEvent {
  return stripeEvent(
    "checkout.session.completed",
    {
      id: stripeIds.session(),
      object: "checkout.session",
      mode: "payment",
      amount_total: o.amountMinor ?? 50_000,
      currency: o.currency ?? "myr",
      livemode: o.livemode ?? false,
      payment_status: o.paymentStatus ?? "paid",
      payment_intent: o.paymentIntentId ?? stripeIds.paymentIntent(),
      metadata: metadataOf(o.facilityId),
    },
    o,
  );
}

export interface PostOptions {
  /** Signing time (unix seconds); default now. */
  readonly t?: number;
  /** Sent instead of a computed header; null sends no Stripe-Signature header at all. */
  readonly header?: string | null;
  /** Applied to the raw body AFTER signing (a tampered body). */
  readonly tamper?: (raw: string) => string;
}

/** POSTs `event` (or a raw string) to /api/webhooks/stripe signed with `secret`. */
export async function postStripe(app: Hono, event: TestEvent | string, secret: string, o: PostOptions = {}): Promise<Response> {
  const raw = typeof event === "string" ? event : JSON.stringify(event);
  const header = o.header === undefined ? signStripe(secret, raw, o.t) : o.header;
  const body = o.tamper ? o.tamper(raw) : raw;
  return app.request("/api/webhooks/stripe", {
    method: "POST",
    headers: { "content-type": "application/json", ...(header === null ? {} : { "stripe-signature": header }) },
    body,
  });
}

/** A StripePort that records its calls and answers a fresh test PaymentIntent id (or throws `fail`). */
export function fakeStripe(fail?: Error): StripePort & { readonly calls: StripeTestPayment[] } {
  const calls: StripeTestPayment[] = [];
  return {
    calls,
    async createTestPayment(p) {
      calls.push(p);
      if (fail) throw fail;
      return { paymentIntentId: stripeIds.paymentIntent() };
    },
  };
}
