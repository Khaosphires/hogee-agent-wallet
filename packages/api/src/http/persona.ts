/**
 * Persona of a request (G0-AUDIT v-2): only the HMAC-signed `hogee_persona` cookie counts. Missing, unsigned,
 * tampered, expired or relabelled cookies, a valid cookie of another country's founder, and any cookie when
 * PERSONA_COOKIE_SECRET is unset, read as the founder of the server's HOGEE_COUNTRY (SG-DECISIONS Q1).
 *
 * Officer-token attempts are limited (task 1.12): after MAX_FAILED_ATTEMPTS wrong tokens within the window every
 * officer request is refused, even with the right token, until the window has passed. The limiter is per process
 * (the API serves localhost); each wrong token also leaves a trace event (routes/session.ts), and so does the first
 * refusal of a lockout, at most one per window (audit run-6: a locked-out caller cannot grow the trace table).
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { PERSONA_COOKIE, type CountryCode, type Persona } from "@hogee/core";
import type { RuntimeFlags } from "../context";
import { defaultPersonaFor, verifyPersonaCookie } from "../persona-cookie";

/** `country`: the server's HOGEE_COUNTRY (deps.config.countryCode). */
export function personaOf(c: Context, flags: RuntimeFlags, nowMs: number, country: CountryCode): Persona {
  if (!flags.cookieSecret) return defaultPersonaFor(country);
  return verifyPersonaCookie(getCookie(c, PERSONA_COOKIE), { secret: flags.cookieSecret, officerToken: flags.officerToken, now: nowMs, country });
}

export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Sliding window of failed officer-token attempts. */
export class AttemptLimiter {
  private failures: number[] = [];
  private lockoutTracedAt: number | null = null;

  constructor(
    private readonly max = MAX_FAILED_ATTEMPTS,
    private readonly windowMs = ATTEMPT_WINDOW_MS,
  ) {}

  private prune(nowMs: number): void {
    this.failures = this.failures.filter((t) => nowMs - t < this.windowMs);
  }

  locked(nowMs: number): boolean {
    this.prune(nowMs);
    return this.failures.length >= this.max;
  }

  /** While locked: true for the first refusal of a window (trace it), false for the rest (log only). */
  traceLockout(nowMs: number): boolean {
    if (this.lockoutTracedAt !== null && nowMs - this.lockoutTracedAt < this.windowMs) return false;
    this.lockoutTracedAt = nowMs;
    return true;
  }

  /** Records a failure; returns how many are in the window now. */
  fail(nowMs: number): number {
    this.prune(nowMs);
    this.failures = [...this.failures, nowMs];
    return this.failures.length;
  }
}
