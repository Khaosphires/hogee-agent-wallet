/**
 * Live adapters behind the ApiDeps ports: supplier checks (@hogee/checks; a check that cannot run throws, so the
 * shortlist fails closed; one validator per registry id kind), the pg-boss sender (send only: no maintenance, no schedules in the web process), the
 * Stripe TEST-mode payment port (sk_test_ keys only; the sale itself arrives as a signed webhook) and the logger
 * (JSON lines, URLs redacted, errors reduced to their name and first line).
 */
import { getFx, screenSanctions, validateSSM, validateUEN, validateUSCC, type ValidationResult } from "@hogee/checks";
import { PgBoss } from "pg-boss";
import { redactText, shortErrorReason } from "../chain-lib";
import type { ApiJob, ApiLogger, ChecksPort, QueuePort, RegistryKind, StripePort } from "../context";
import { ConfigError } from "../http/problem";

/** One offline validator per registry id kind (packages/checks). */
export type RegistryValidators = { readonly [K in RegistryKind]: (id: string) => ValidationResult };

/**
 * validateRegistryId, exhaustive per kind (SG-DESIGN §4 fail-open 4): uscc → USCC, ssm → SSM, uen → UEN. Any other
 * kind throws, so it is refused until it has its own validator and is never read as SSM. Only `valid === true` counts.
 */
export function registryValidator(v: RegistryValidators): ChecksPort["validateRegistryId"] {
  return (kind, id) => {
    switch (kind) {
      case "uscc":
        return { valid: v.uscc(id).valid === true };
      case "ssm":
        return { valid: v.ssm(id).valid === true };
      case "uen":
        return { valid: v.uen(id).valid === true };
      default: {
        const unknown: never = kind;
        throw new Error(`no validator for registry id kind ${JSON.stringify(String(unknown).slice(0, 32))}`);
      }
    }
  };
}

export const LIVE_REGISTRY_VALIDATORS: RegistryValidators = { uscc: validateUSCC, ssm: validateSSM, uen: validateUEN };

export const liveChecks: ChecksPort = {
  screenSanctions: async (name) => ({ hit: (await screenSanctions(name)).hit }),
  validateRegistryId: registryValidator(LIVE_REGISTRY_VALIDATORS),
  fx: (pair, date) => getFx(pair, date),
};

export function bossQueue(connectionString: string, log: ApiLogger): QueuePort & { stop(): Promise<void> } {
  let started: Promise<PgBoss> | undefined;
  const boss = () =>
    (started ??= (async () => {
      const b = new PgBoss({ connectionString, schema: "pgboss", application_name: "hogee-api", max: 2, supervise: false, schedule: false, migrate: false });
      b.on("error", (error: unknown) => log.warn("pgboss_error", { error }));
      await b.start();
      return b;
    })());
  return {
    async send(job: ApiJob, data = {}) {
      await (await boss()).send(job, { ...data });
    },
    async stop() {
      if (started) await (await started).stop({ graceful: true, timeout: 5_000 });
    },
  };
}

const STRIPE_API = "https://api.stripe.com/v1";

/** Stripe test mode only: a live key is refused at start-up (the variable is named, the value never echoed). */
export function stripePort(secretKey: string | undefined, fetchImpl: typeof fetch = fetch): StripePort | null {
  if (!secretKey) return null;
  if (!/^(sk|rk)_test_[A-Za-z0-9]{8,}$/.test(secretKey)) throw new ConfigError("STRIPE_SECRET_KEY must be a Stripe TEST-mode key (sk_test_…)");
  const auth = `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
  return {
    async createTestPayment(p) {
      const body = new URLSearchParams({
        amount: p.amountMinor.toString(),
        currency: p.currency.toLowerCase(),
        confirm: "true",
        payment_method: "pm_card_visa",
        "payment_method_types[]": "card",
        "metadata[facilityId]": p.facilityId,
      });
      const res = await fetchImpl(`${STRIPE_API}/payment_intents`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded", "idempotency-key": p.idempotencyKey },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => ({}))) as { id?: unknown; livemode?: unknown; error?: { code?: unknown } };
      if (!res.ok || typeof json.id !== "string") throw new Error(`stripe_error:${typeof json.error?.code === "string" ? json.error.code : res.status}`);
      if (json.livemode !== false) throw new Error("stripe_error:livemode");
      return { paymentIntentId: json.id };
    },
  };
}

const SECRET_KEYS = /secret|token|key|password|authorization|cookie/i;

function clean(fields: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (SECRET_KEYS.test(k)) continue;
    out[k] = v instanceof Error ? shortErrorReason(v, 200) : typeof v === "string" ? redactText(v).slice(0, 500) : v;
  }
  return out;
}

export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): ApiLogger {
  const emit = (level: string, event: string, fields?: Readonly<Record<string, unknown>>) => {
    try {
      write(JSON.stringify({ ts: new Date().toISOString(), level, svc: "hogee-api", event, ...clean(fields) }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
    } catch {
      write(JSON.stringify({ level, svc: "hogee-api", event }));
    }
  };
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f), error: (e, f) => emit("error", e, f) };
}
