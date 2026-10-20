/**
 * POST /api/demo/sale (DEMO_MODE=1 only, demo task 11): creates and confirms a Stripe TEST-mode PaymentIntent for
 * THIS facility (scope from server config) in its currency. Nothing is recorded here: the sale arrives through the
 * real path, Stripe's signed webhook (routes/webhooks.ts). Without STRIPE_SECRET_KEY the route answers 503.
 *
 * Rate limited per server (audit run-9 lead 4): every demo sale becomes a recorded sale the oracle key signs, on the
 * nonce sequence settlement confirmations share, and wakes cfo-guard. Anyone reads as the founder in DEMO_MODE, so at
 * most DEMO_SALE_RATE_PER_MIN valid requests a minute reach the database and Stripe (in-process, like the chat
 * limiter); past it a 429 UPSTREAM {reason RATE_LIMITED, scope server} with Retry-After, logged, never traced (no
 * effect happened, and a refused caller cannot grow the trace table).
 */
import type { Context } from "hono";
import { parseMinor } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { RATE_WINDOW_MS, WindowCounter, retryAfterSeconds, setRetryAfter } from "../http/rate-limit";
import type { RouteGroup } from "../http/register";
import { facilityRow } from "../services/facility";
import { newId } from "../services/ids";
import { SALE_BUCKET_MINOR } from "../services/sales";
import { RATE_LIMITED } from "../services/refusals";
import { pool } from "../services/sql";

/** Stripe's largest amount (8 digits of minor units). */
export const DEMO_SALE_MAX_MINOR = 99_999_999n;
/** Demo sales a minute per server. */
export const DEMO_SALE_RATE_PER_MIN = 6;
const SERVER_KEY = "server";

/** A Stripe error's own code (e.g. amount_too_small) for the log; never its message, which can quote a masked key. */
function stripeCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : error instanceof Error ? error.name : "unknown";
}

function checkAmount(amountMinor: string): bigint {
  const amount = parseMinor(amountMinor);
  if (amount < SALE_BUCKET_MINOR || amount > DEMO_SALE_MAX_MINOR) {
    throw fail("VALIDATION", `A demo sale is between ${SALE_BUCKET_MINOR} and ${DEMO_SALE_MAX_MINOR} minor units (smaller sales round to a zero bucket)`);
  }
  return amount;
}

/** Counts one demo sale, or throws the 429 (nothing counted) when this server's minute is used up. */
function admit(c: Context, deps: ApiDeps, limiter: WindowCounter): void {
  const now = deps.clock();
  const wait = limiter.waitMs(SERVER_KEY, now);
  if (wait === 0) {
    limiter.hit(SERVER_KEY, now);
    return;
  }
  deps.log.warn("demo_sale_rate_limited", { scope: "server" });
  setRetryAfter(c, wait);
  const seconds = retryAfterSeconds(wait);
  throw fail("UPSTREAM", `Too many demo sales; try again in ${seconds} s`, { status: 429, details: { reason: RATE_LIMITED, scope: "server", retryAfterSeconds: seconds } });
}

async function demoSale(c: Context, deps: ApiDeps, scope: Scope, amountMinor: string, limiter: WindowCounter): Promise<{ paymentIntentId: string }> {
  const stripe = deps.stripe;
  if (!stripe) throw fail("UPSTREAM", "Stripe test mode is not configured: set STRIPE_SECRET_KEY to a Stripe test-mode key to create demo sales", { status: 503 });
  const amount = checkAmount(amountMinor);
  admit(c, deps, limiter);
  const facility = await facilityRow(pool(deps.db), scope);
  if (!facility) throw fail("NOT_FOUND", "The loan officer has not opened the facility yet");
  try {
    const { paymentIntentId } = await stripe.createTestPayment({ amountMinor: amount, currency: facility.currency, facilityId: scope.facilityId, idempotencyKey: newId("demo-sale") });
    deps.log.info("stripe_demo_sale_created", { amountMinor });
    return { paymentIntentId };
  } catch (error: unknown) {
    deps.log.warn("stripe_demo_sale_failed", { reason: stripeCode(error) });
    throw fail("UPSTREAM", "Stripe could not create the test payment; try again shortly");
  }
}

/** The demo-sale group of one app: its limiter is per app (so per server), unless a test injects one. */
export function demoSaleRoutes(opts: { readonly limiter?: WindowCounter } = {}): RouteGroup {
  const limiter = opts.limiter ?? new WindowCounter(DEMO_SALE_RATE_PER_MIN, RATE_WINDOW_MS, 1);
  return {
    demoSale: ({ req, deps, scope, c }) => demoSale(c, deps, scope, req.body.amountMinor, limiter),
  };
}
