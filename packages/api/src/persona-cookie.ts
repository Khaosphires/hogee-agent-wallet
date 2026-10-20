/**
 * G0-AUDIT (v-2): the signed `hogee_persona` cookie (core PERSONA_COOKIE), shared by the live API (task 1.12) and
 * P2's api-mock so there is ONE implementation.
 *
 * Value: `<persona>.<exp>.<mac>`; exp = unix seconds (≤ 8 h ahead); mac = base64url HMAC-SHA256(key, "<persona>|<exp>").
 * key = HMAC-SHA256(PERSONA_COOKIE_SECRET, "hogee_persona|<persona>|" + [sha256(OFFICER_TOKEN) for the officer]), so
 * rotating PERSONA_COOKIE_SECRET revokes every cookie and rotating or unsetting OFFICER_TOKEN revokes officer cookies.
 * Anything missing, malformed, forged or expired verifies as the default persona; verify never throws on a cookie.
 *
 * SG-DECISIONS Q1: the default persona, and the only founder persona accepted, is the founder of the server's
 * HOGEE_COUNTRY (SG → founder:mei, MY → founder:rina; ID keeps founder:rina). A valid cookie for another founder
 * verifies as that default, so it never grants the other founder.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { COUNTRY_CODES, PERSONAS, type CountryCode, type Persona } from "@hogee/core";
import { isStrongSecret, sha256 } from "./operator-secrets";

/** Each country's founder persona. ID has no founder of its own and keeps Rina's (unchanged). */
export const FOUNDER_PERSONA_BY_COUNTRY: Readonly<Record<CountryCode, Persona>> = { MY: "founder:rina", ID: "founder:rina", SG: "founder:mei" };

/** The default persona, and the only founder persona accepted, of a server for `country`. Throws on any other value. */
export function defaultPersonaFor(country: CountryCode): Persona {
  if (!(COUNTRY_CODES as readonly string[]).includes(country)) throw new Error("persona: unknown country");
  return FOUNDER_PERSONA_BY_COUNTRY[country];
}

/** The default persona of a caller that names no country (MY, as before Singapore). The live API always names one. */
export const DEFAULT_PERSONA: Persona = defaultPersonaFor("MY");

const isFounderPersona = (persona: Persona): boolean => persona.startsWith("founder:");

export const PERSONA_COOKIE_MAX_TTL_SECONDS = 8 * 60 * 60;
/** Set-Cookie attributes (Hono CookieOptions shape). No Domain: the cookie stays host-only. Add maxAge = ttl. */
export const PERSONA_COOKIE_OPTIONS = { httpOnly: true, sameSite: "Strict", path: "/api" } as const;

export interface PersonaCookieKeys {
  /** PERSONA_COOKIE_SECRET (see parsePersonaCookieSecret). */
  readonly secret: string;
  /** OFFICER_TOKEN; required to sign, and to verify, an officer cookie. */
  readonly officerToken?: string | undefined;
  /** Current time, epoch milliseconds (Date.now()). */
  readonly now: number;
}

export interface VerifyPersonaCookieOptions extends PersonaCookieKeys {
  /** The server's HOGEE_COUNTRY: picks the default and the one founder persona accepted. Unset: MY (DEFAULT_PERSONA). */
  readonly country?: CountryCode;
}

export interface SignPersonaCookieOptions extends PersonaCookieKeys {
  /** 1 .. 28800 (8 h); default 8 h. */
  readonly ttlSeconds?: number;
}

const MAX_VALUE_LENGTH = 128;
const EXP = /^[1-9][0-9]{0,11}$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;

const isPersona = (value: string): value is Persona => (PERSONAS as readonly string[]).includes(value);

function macFor(persona: Persona, exp: number, secret: string, officerToken: string | undefined): string {
  const keyInput = createHmac("sha256", secret).update(`hogee_persona|${persona}|`);
  if (persona === "officer") keyInput.update(sha256(officerToken ?? ""));
  return createHmac("sha256", keyInput.digest()).update(`${persona}|${exp}`).digest("base64url");
}

/** Signs a persona cookie value. Throws on caller misuse (weak secret, officer without a strong token, bad ttl). */
export function signPersonaCookie(persona: Persona, opts: SignPersonaCookieOptions): string {
  const ttl = opts.ttlSeconds ?? PERSONA_COOKIE_MAX_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > PERSONA_COOKIE_MAX_TTL_SECONDS) {
    throw new Error(`persona cookie ttl must be 1..${PERSONA_COOKIE_MAX_TTL_SECONDS} s`);
  }
  if (!isPersona(persona)) throw new Error("unknown persona");
  if (!Number.isFinite(opts.now)) throw new Error("persona cookie: now must be epoch milliseconds");
  if (!isStrongSecret(opts.secret)) throw new Error("PERSONA_COOKIE_SECRET is missing or weak");
  if (persona === "officer" && !isStrongSecret(opts.officerToken)) {
    throw new Error("cannot sign an officer cookie: OFFICER_TOKEN is missing or weak");
  }
  const exp = Math.floor(opts.now / 1000) + ttl;
  return `${persona}.${exp}.${macFor(persona, exp, opts.secret, opts.officerToken)}`;
}

/**
 * The persona a cookie value proves, or the default persona (the founder of `opts.country`) for anything missing,
 * malformed, forged or expired, and for a valid cookie of another country's founder. Throws only on caller misuse
 * (an unknown `opts.country`), never on the cookie.
 */
export function verifyPersonaCookie(value: string | null | undefined, opts: VerifyPersonaCookieOptions): Persona {
  const fallback = opts.country === undefined ? DEFAULT_PERSONA : defaultPersonaFor(opts.country);
  const proven = provenPersona(value, opts);
  if (proven === null) return fallback;
  return isFounderPersona(proven) && proven !== fallback ? fallback : proven;
}

/** The persona a cookie value proves by its MAC, or null. Never throws. */
function provenPersona(value: string | null | undefined, opts: PersonaCookieKeys): Persona | null {
  try {
    if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return null;
    const [persona = "", expRaw = "", mac = "", ...rest] = value.split(".");
    if (rest.length > 0 || !isPersona(persona) || !EXP.test(expRaw) || !MAC.test(mac)) return null;
    if (!isStrongSecret(opts.secret) || !Number.isFinite(opts.now)) return null;
    const exp = Number(expRaw);
    const nowSeconds = Math.floor(opts.now / 1000);
    if (exp <= nowSeconds || exp > nowSeconds + PERSONA_COOKIE_MAX_TTL_SECONDS) return null;
    if (persona === "officer" && !isStrongSecret(opts.officerToken)) return null;
    // Compare the canonical base64url text (equal length, ASCII), so the final character's padding bits count too.
    const expected = macFor(persona, exp, opts.secret, opts.officerToken);
    return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? persona : null;
  } catch {
    // Bad input from a client must never surface as a 500; fail closed to the default persona.
    return null;
  }
}

/**
 * PERSONA_COOKIE_SECRET: required when DEMO_MODE=1 (the only mode that mints persona cookies), no default. A set
 * but weak value throws in any mode. Call at startup and per request (rotation without restart).
 */
export function parsePersonaCookieSecret(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const secret = env.PERSONA_COOKIE_SECRET;
  if (secret === undefined || secret === "") {
    if (env.DEMO_MODE?.trim() === "1") {
      throw new Error("PERSONA_COOKIE_SECRET is required when DEMO_MODE=1 (e.g. $(openssl rand -hex 32))");
    }
    return undefined;
  }
  if (!isStrongSecret(secret)) {
    throw new Error(
      "PERSONA_COOKIE_SECRET must be 32..256 chars, no surrounding whitespace, no placeholder text, ≥12 distinct chars",
    );
  }
  return secret;
}
