/**
 * GET /api/session, POST /api/session/persona (demo only), GET /api/health.
 *
 * G0-AUDIT (v-2): the officer persona selects actions the worker performs with the server-held demo lender key, so
 * minting it needs `officerToken` == OFFICER_TOKEN (strength-checked, constant time). Wrong tokens are limited per
 * process (http/persona.ts) and each one leaves an ALERT trace (a lockout leaves one per window, not one per
 * attempt); a refusal never sets a cookie.
 */
import { setCookie } from "hono/cookie";
import { PERSONA_COOKIE, type HealthStatus, type Persona, type Session } from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import type { RouteGroup } from "../http/register";
import { AttemptLimiter } from "../http/persona";
import { fail } from "../http/problem";
import { defaultPersonaFor, PERSONA_COOKIE_MAX_TTL_SECONDS, PERSONA_COOKIE_OPTIONS, signPersonaCookie } from "../persona-cookie";
import { officerTokenMatches } from "../operator-secrets";
import { newId } from "../services/ids";
import { appendTrace } from "../services/traces";

const HEALTH_TIMEOUT_MS = 2_000;

export function sessionOf(deps: ApiDeps, scope: Scope, persona: Persona): Session {
  return {
    persona,
    founderId: scope.founderId,
    facilityId: scope.facilityId,
    mode: "live",
    chainId: deps.deployment.chainId,
    deploymentId: deps.deployment.deploymentId,
  };
}

async function recordRejected(deps: ApiDeps, scope: Scope, reason: "OFFICER_TOKEN_REJECTED" | "OFFICER_TOKEN_LOCKED"): Promise<void> {
  deps.log.warn("officer_token_rejected", { reason });
  try {
    await appendTrace(deps.db, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "officer",
      kind: "ALERT",
      reasonCode: reason,
      summary: reason === "OFFICER_TOKEN_LOCKED" ? "Officer access refused: too many wrong access keys, locked for a while" : "Officer access refused: wrong access key",
    });
  } catch (error: unknown) {
    // The facility row may not exist yet (no trace without a tenant); the refusal itself already happened.
    deps.log.warn("officer_attempt_trace_failed", { error });
  }
}

const within = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS))]);

async function probe(fn: () => Promise<boolean>): Promise<HealthStatus> {
  try {
    return (await within(fn())) ? "ok" : "degraded";
  } catch {
    return "down";
  }
}

export function sessionRoutes(limiter: AttemptLimiter = new AttemptLimiter()): RouteGroup {
  return {
    getSession: ({ deps, scope, persona }) => sessionOf(deps, scope, persona),

    setPersona: async ({ req, deps, scope, c }) => {
      const flags = deps.flags();
      if (!flags.cookieSecret) throw fail("FORBIDDEN", "Persona switching is not configured (PERSONA_COOKIE_SECRET)");
      const body = req.body;
      // Only this server's founder (SG-DECISIONS Q1): the other country's founder would read back as the default.
      if (body.persona !== "officer" && body.persona !== defaultPersonaFor(deps.config.countryCode)) {
        throw fail("FORBIDDEN", "That founder persona does not belong to this server's country");
      }
      if (body.persona === "officer") {
        const now = deps.clock();
        if (limiter.locked(now)) {
          if (limiter.traceLockout(now)) await recordRejected(deps, scope, "OFFICER_TOKEN_LOCKED");
          else deps.log.warn("officer_token_rejected", { reason: "OFFICER_TOKEN_LOCKED" });
          throw fail("FORBIDDEN", "Too many wrong officer access keys; try again later");
        }
        if (!officerTokenMatches(body.officerToken, flags.officerToken)) {
          limiter.fail(now);
          await recordRejected(deps, scope, "OFFICER_TOKEN_REJECTED");
          throw fail("FORBIDDEN", "Officer access key not accepted");
        }
      }
      const value = signPersonaCookie(body.persona, { secret: flags.cookieSecret, officerToken: flags.officerToken, now: deps.clock() });
      setCookie(c, PERSONA_COOKIE, value, { ...PERSONA_COOKIE_OPTIONS, maxAge: PERSONA_COOKIE_MAX_TTL_SECONDS });
      return sessionOf(deps, scope, body.persona);
    },

    getHealth: async ({ deps }) => {
      const [db, chain, presidio] = await Promise.all([
        probe(async () => (await deps.db.$client.query("select 1")).rowCount === 1),
        probe(async () => (await deps.client.getChainId()) === deps.deployment.chainId),
        deps.config.presidioUrl
          ? probe(async () => (await fetch(new URL("/health", deps.config.presidioUrl as string), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok)
          : Promise.resolve<HealthStatus>("degraded"),
      ]);
      return {
        db,
        chain,
        presidio,
        // "degraded": a provider is configured but the server's model budget refuses every further call.
        llm: !deps.agent.configured ? "down" : deps.agent.budget.isOpen() ? "ok" : "degraded",
        payoutRail: deps.config.payoutRail.configured ? "ok" : "down",
      };
    },
  };
}
