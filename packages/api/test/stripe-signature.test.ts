/**
 * Stripe-Signature verification (task 1.12, §9.2) without a database: the exact Stripe scheme (HMAC-SHA256 of
 * "<t>.<raw body>", any matching v1, 300 s tolerance), and the route refusing every unverified body with a generic
 * 400 VALIDATION before it parses JSON or touches the database (the fake deps throw on any database access).
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ApiError } from "@hogee/core";
import { createApiApp } from "../src/app";
import { STRIPE_TOLERANCE_SECONDS, verifyStripeSignature, webhookRoutes } from "../src/routes/webhooks";
import { fakeDeps, randomSecret, type Fake } from "./support/fake-deps";
import { nowSeconds, paymentIntentSucceeded, postStripe, signStripe, stripeEvent } from "./support/stripe";

const RAW = JSON.stringify({ id: "evt_test1", type: "payment_intent.succeeded" });
const hmac = (secret: string, t: number, raw: string) => createHmac("sha256", secret).update(`${t}.${raw}`, "utf8").digest("hex");

describe("verifyStripeSignature", () => {
  const secret = randomSecret();
  const now = Date.now();
  const t = Math.floor(now / 1000);

  it("accepts Stripe's own scheme", () => {
    expect(verifyStripeSignature(signStripe(secret, RAW, t), RAW, secret, now)).toEqual({ ok: true, timestamp: t });
  });

  it("accepts any matching v1 (secret rotation) and ignores other schemes", () => {
    const other = hmac(randomSecret(), t, RAW);
    const header = `t=${t},v0=${other},v1=${other},v1=${hmac(secret, t, RAW)}`;
    expect(verifyStripeSignature(header, RAW, secret, now).ok).toBe(true);
  });

  it("refuses another secret, a tampered body and a v0-only header", () => {
    expect(verifyStripeSignature(signStripe(randomSecret(), RAW, t), RAW, secret, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(signStripe(secret, RAW, t), RAW.replace("succeeded", "SUCCEEDED"), secret, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(signStripe(secret, `${RAW} `, t), RAW, secret, now)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyStripeSignature(`t=${t},v0=${hmac(secret, t, RAW)}`, RAW, secret, now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("binds the timestamp: the same v1 under another t fails", () => {
    const v1 = hmac(secret, t, RAW);
    expect(verifyStripeSignature(`t=${t - 1},v1=${v1}`, RAW, secret, now)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a timestamp more than 300 s old or ahead", () => {
    const tol = STRIPE_TOLERANCE_SECONDS;
    expect(verifyStripeSignature(signStripe(secret, RAW, t - tol), RAW, secret, now).ok).toBe(true);
    expect(verifyStripeSignature(signStripe(secret, RAW, t - tol - 1), RAW, secret, now)).toEqual({ ok: false, reason: "stale" });
    expect(verifyStripeSignature(signStripe(secret, RAW, t + tol + 1), RAW, secret, now)).toEqual({ ok: false, reason: "stale" });
  });

  it("refuses malformed headers", () => {
    const v1 = hmac(secret, t, RAW);
    for (const header of [
      "",
      "garbage",
      `v1=${v1}`,
      `t=${t}`,
      `t=abc,v1=${v1}`,
      `t=-${t},v1=${v1}`,
      `t=0${t},v1=${v1}`,
      `t=${t},t=${t},v1=${v1}`,
      `t=${t},v1=${v1.slice(0, 63)}`,
      `t=${t},v1=${v1}zz`,
      `t=${t},v1=`,
      `t=${t},v1=${v1},${"v1=".padEnd(70, "0")}`,
      `t=${t},${Array.from({ length: 9 }, () => `v1=${v1}`).join(",")}`,
      `t=${t},v1=${v1},x=${"y".repeat(4096)}`,
    ]) {
      expect(verifyStripeSignature(header, RAW, secret, now), header.slice(0, 40)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("refuses everything when no (or a too-short) secret is configured", () => {
    expect(verifyStripeSignature(signStripe("", RAW, t), RAW, undefined, now)).toEqual({ ok: false, reason: "not_configured" });
    expect(verifyStripeSignature(signStripe("", RAW, t), RAW, "", now)).toEqual({ ok: false, reason: "not_configured" });
    expect(verifyStripeSignature(signStripe("short", RAW, t), RAW, "short", now)).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("POST /api/webhooks/stripe without a database", () => {
  const appFor = (f: Fake) => createApiApp(async () => f.deps, webhookRoutes);
  const errorOf = async (res: Response) => ApiError.parse(await res.json()).error;
  const secretOf = (f: Fake) => f.flags.stripeWebhookSecret as string;

  async function expectRejected(f: Fake, res: Response): Promise<void> {
    const text = await res.clone().text();
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe("VALIDATION");
    expect(text).not.toContain(secretOf(f));
  }

  it("400s a wrong signature with a generic message that echoes neither the secret nor the expected signature", async () => {
    const f = fakeDeps();
    const event = paymentIntentSucceeded({ facilityId: "fac-rina" });
    const raw = JSON.stringify(event);
    const t = nowSeconds();
    const res = await postStripe(appFor(f), raw, secretOf(f), { header: signStripe(randomSecret(), raw, t) });
    await expectRejected(f, res.clone());
    const text = await res.text();
    expect(text).not.toContain(hmac(secretOf(f), t, raw));
    expect(f.logs).toContainEqual({ level: "warn", event: "stripe_webhook_rejected", fields: { reason: "mismatch" } });
    expect(JSON.stringify(f.logs)).not.toContain(secretOf(f));
  });

  it("400s a missing header, a stale timestamp and a tampered body", async () => {
    const f = fakeDeps();
    const event = paymentIntentSucceeded({ facilityId: "fac-rina" });
    await expectRejected(f, await postStripe(appFor(f), event, secretOf(f), { header: null }));
    await expectRejected(f, await postStripe(appFor(f), event, secretOf(f), { t: nowSeconds() - 301 }));
    await expectRejected(f, await postStripe(appFor(f), event, secretOf(f), { tamper: (raw) => raw.replace("50000", "99999") }));
    expect(f.jobs).toEqual([]);
  });

  it("400s every webhook while STRIPE_WEBHOOK_SECRET is unset", async () => {
    const f = fakeDeps({ flags: { stripeWebhookSecret: undefined } });
    const res = await postStripe(appFor(f), paymentIntentSucceeded({ facilityId: "fac-rina" }), "");
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe("VALIDATION");
    expect(f.logs).toContainEqual({ level: "warn", event: "stripe_webhook_rejected", fields: { reason: "not_configured" } });
  });

  it("parses JSON only after verifying, and 400s a signed body that is not a Stripe event", async () => {
    const f = fakeDeps();
    expect((await postStripe(appFor(f), "{not json", secretOf(f))).status).toBe(400);
    expect((await postStripe(appFor(f), JSON.stringify({ id: "nope", type: "x" }), secretOf(f))).status).toBe(400);
    expect((await postStripe(appFor(f), "{not json", randomSecret())).status).toBe(400);
  });

  it("acknowledges a verified event of another type without touching anything", async () => {
    const f = fakeDeps();
    const res = await postStripe(appFor(f), stripeEvent("payment_intent.created", { id: "pi_test1", object: "payment_intent" }), secretOf(f));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(f.jobs).toEqual([]);
  });
});
