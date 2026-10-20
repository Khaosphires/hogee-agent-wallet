/**
 * POST /api/webhooks/stripe (§9.2, task 1.12). The raw body (route `rawBody`, ≤ 256 KB, read by register.ts) is
 * verified exactly as Stripe signs it BEFORE anything is parsed: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`,
 * HMAC-SHA256 with STRIPE_WEBHOOK_SECRET over "<t>.<raw body>", constant-time compare against every v1, and the
 * timestamp within 300 s of the server clock (either direction). A missing secret, a malformed header, a wrong
 * signature or a stale timestamp all answer the same generic 400 VALIDATION (the reason goes to the server log only;
 * neither the secret nor the expected signature is ever echoed or logged). Only then is the JSON parsed, and the
 * event handled by services/sales.ts (one sale per event and per payment, for this facility only).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { handleStripeEvent, type StripeEvent, type WebhookOutcome } from "../services/sales";

/** Stripe's default tolerance. */
export const STRIPE_TOLERANCE_SECONDS = 300;
/** Stripe's secrets are `whsec_` + 32 bytes; anything this short is a misconfiguration, not a secret. */
const MIN_SECRET_CHARS = 16;
const MAX_HEADER_CHARS = 2048;
/** Stripe sends one v1 per active endpoint secret (two during a rotation). */
const MAX_V1 = 8;
const T_RE = /^[1-9][0-9]{0,11}$/;
const V1_RE = /^[0-9a-fA-F]{64}$/;

export type SignatureVerdict =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: "not_configured" | "malformed" | "mismatch" | "stale" };

function parseHeader(header: string): { readonly t: string; readonly v1: readonly string[] } | null {
  if (header.length > MAX_HEADER_CHARS) return null;
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (t !== null || !T_RE.test(value)) return null;
      t = value;
    } else if (key === "v1") {
      if (!V1_RE.test(value)) return null;
      v1.push(value);
    }
  }
  if (t === null || v1.length === 0 || v1.length > MAX_V1) return null;
  return { t, v1 };
}

/** Stripe's webhook signature check (docs.stripe.com/webhooks/signature), over the exact raw body. */
export function verifyStripeSignature(header: string, rawBody: string, secret: string | undefined, nowMs: number): SignatureVerdict {
  if (!secret || secret.length < MIN_SECRET_CHARS) return { ok: false, reason: "not_configured" };
  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(`${parsed.t}.${rawBody}`, "utf8").digest();
  let matched = false;
  for (const candidate of parsed.v1) matched = timingSafeEqual(expected, Buffer.from(candidate, "hex")) || matched;
  if (!matched) return { ok: false, reason: "mismatch" };
  const t = Number(parsed.t);
  if (Math.abs(Math.floor(nowMs / 1000) - t) > STRIPE_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  return { ok: true, timestamp: t };
}

const Envelope = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9_]{1,250}$/),
  type: z.string().regex(/^[a-z0-9_.]{1,100}$/),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

/** Parsed only after the signature verified. */
function parseEvent(raw: string): StripeEvent {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw fail("VALIDATION", "The Stripe event is not valid JSON");
  }
  const e = Envelope.safeParse(json);
  if (!e.success) throw fail("VALIDATION", "The body is not a Stripe event");
  return { id: e.data.id, type: e.data.type, livemode: e.data.livemode, object: e.data.data.object };
}

async function stripeWebhook(deps: ApiDeps, scope: Scope, header: string, raw: string): Promise<WebhookOutcome> {
  const verdict = verifyStripeSignature(header, raw, deps.flags().stripeWebhookSecret, deps.clock());
  if (!verdict.ok) {
    deps.log.warn("stripe_webhook_rejected", { reason: verdict.reason });
    throw fail("VALIDATION", "The Stripe-Signature header does not verify");
  }
  return handleStripeEvent(deps, scope, parseEvent(raw));
}

export const webhookRoutes: RouteGroup = {
  stripeWebhook: ({ req, deps, scope }) => stripeWebhook(deps, scope, req.headers["stripe-signature"], req.body),
};
