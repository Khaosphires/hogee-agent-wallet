// G0-AUDIT (v-2): the signed persona cookie shared by the live API (task 1.12) and P2's api-mock.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PERSONA_COOKIE_MAX_TTL_SECONDS,
  PERSONA_COOKIE_OPTIONS,
  parsePersonaCookieSecret,
  signPersonaCookie,
  verifyPersonaCookie,
} from "../src/index";
import { DEFAULT_PERSONA, defaultPersonaFor, FOUNDER_PERSONA_BY_COUNTRY } from "../src/persona-cookie";

// Random per run: never commit secret-shaped literals (the gitleaks pre-commit hook rejects them). base64url of 32
// bytes, not hex of 20: isStrongSecret wants ≥12 distinct chars, and 40 hex chars have fewer about 0.11% of the time,
// which failed this file about 0.2% of runs (SECRET and OFFICER_TOKEN). 43 chars from 64 have fewer about 1e-21.
const randomSecret = (): string => randomBytes(32).toString("base64url");
const SECRET = randomSecret();
const OFFICER_TOKEN = randomSecret();
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const HOUR_MS = 3_600_000;
const keys = { secret: SECRET, officerToken: OFFICER_TOKEN };

const officer = () => signPersonaCookie("officer", { ...keys, now: NOW });
const founder = () => signPersonaCookie("founder:rina", { ...keys, now: NOW });

/** Replaces character i with a different base64url character. */
const flip = (value: string, i: number): string => `${value.slice(0, i)}${value[i] === "A" ? "B" : "A"}${value.slice(i + 1)}`;

describe("signPersonaCookie / verifyPersonaCookie", () => {
  it("round-trips both personas", () => {
    expect(verifyPersonaCookie(officer(), { ...keys, now: NOW })).toBe("officer");
    expect(verifyPersonaCookie(founder(), { ...keys, now: NOW })).toBe("founder:rina");
  });

  it("has the format <persona>.<exp>.<base64url MAC>, exp = now + 8 h by default", () => {
    const [persona, exp, mac, ...rest] = officer().split(".");
    expect(rest).toEqual([]);
    expect(persona).toBe("officer");
    expect(Number(exp)).toBe(NOW / 1000 + PERSONA_COOKIE_MAX_TTL_SECONDS);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(PERSONA_COOKIE_MAX_TTL_SECONDS).toBe(8 * 60 * 60);
  });

  it("is valid until exp and founder:rina from exp on", () => {
    const value = signPersonaCookie("officer", { ...keys, now: NOW, ttlSeconds: 60 });
    expect(verifyPersonaCookie(value, { ...keys, now: NOW + 59_999 })).toBe("officer");
    expect(verifyPersonaCookie(value, { ...keys, now: NOW + 60_000 })).toBe("founder:rina");
    expect(verifyPersonaCookie(officer(), { ...keys, now: NOW + 8 * HOUR_MS })).toBe("founder:rina");
  });

  it("refuses a ttl outside 1 s .. 8 h", () => {
    for (const ttlSeconds of [0, -1, 1.5, PERSONA_COOKIE_MAX_TTL_SECONDS + 1, Number.NaN]) {
      expect(() => signPersonaCookie("founder:rina", { ...keys, now: NOW, ttlSeconds }), String(ttlSeconds)).toThrow();
    }
  });

  it("refuses to sign with a weak secret, or an officer cookie without a strong OFFICER_TOKEN", () => {
    expect(() => signPersonaCookie("founder:rina", { secret: "a".repeat(32), now: NOW })).toThrow(/PERSONA_COOKIE_SECRET/);
    expect(() => signPersonaCookie("officer", { secret: SECRET, now: NOW })).toThrow(/OFFICER_TOKEN/);
    expect(() => signPersonaCookie("officer", { secret: SECRET, officerToken: "a".repeat(32), now: NOW })).toThrow(/OFFICER_TOKEN/);
  });

  it("founder cookies do not depend on OFFICER_TOKEN", () => {
    expect(verifyPersonaCookie(founder(), { secret: SECRET, now: NOW })).toBe("founder:rina");
    expect(signPersonaCookie("founder:rina", { secret: SECRET, now: NOW })).toBe(founder());
  });

  it("rotating or unsetting OFFICER_TOKEN revokes issued officer cookies", () => {
    const value = officer();
    expect(verifyPersonaCookie(value, { secret: SECRET, officerToken: randomSecret(), now: NOW })).toBe("founder:rina");
    expect(verifyPersonaCookie(value, { secret: SECRET, now: NOW })).toBe("founder:rina");
    expect(verifyPersonaCookie(value, { secret: SECRET, officerToken: "a".repeat(32), now: NOW })).toBe("founder:rina");
  });

  it("rotating PERSONA_COOKIE_SECRET revokes every cookie", () => {
    const other = { ...keys, secret: randomSecret() };
    expect(verifyPersonaCookie(officer(), { ...other, now: NOW })).toBe("founder:rina");
  });

  it("any tampering → founder:rina", () => {
    const value = officer();
    const [, exp, mac] = value.split(".");
    const macStart = value.length - 43;
    for (let i = macStart; i < value.length - 1; i += 7) expect(verifyPersonaCookie(flip(value, i), { ...keys, now: NOW }), `MAC char ${i}`).toBe("founder:rina");
    expect(verifyPersonaCookie(flip(value, value.length - 1), { ...keys, now: NOW }), "last MAC char (padding bits)").toBe("founder:rina");
    expect(verifyPersonaCookie(`officer.${Number(exp) - 1}.${mac}`, { ...keys, now: NOW }), "exp changed").toBe("founder:rina");
    const [, fExp, fMac] = founder().split(".");
    expect(verifyPersonaCookie(`officer.${fExp}.${fMac}`, { ...keys, now: NOW }), "founder MAC relabelled").toBe("founder:rina");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["unsigned", "officer"],
    ["two parts", "officer.1792108800"],
    ["four parts", `${"officer.1792108800.".padEnd(62, "A")}.x`],
    ["unknown persona", `lender.1792108800.${"A".repeat(43)}`],
    ["non-numeric exp", `officer.soon.${"A".repeat(43)}`],
    ["leading-zero exp", `officer.01792108800.${"A".repeat(43)}`],
    ["short MAC", `officer.1792108800.${"A".repeat(42)}`],
    ["non-base64url MAC", `officer.1792108800.${"+".repeat(43)}`],
    ["huge", `officer.1792108800.${"A".repeat(5000)}`],
  ])("malformed (%s) → founder:rina, never throws", (_label, value) => {
    expect(verifyPersonaCookie(value as string | undefined, { ...keys, now: NOW })).toBe("founder:rina");
  });

  it("an exp further out than 8 h is refused even with a valid-looking MAC", () => {
    const longLived = signPersonaCookie("officer", { ...keys, now: NOW + 2 * HOUR_MS });
    expect(verifyPersonaCookie(longLived, { ...keys, now: NOW - HOUR_MS })).toBe("founder:rina");
  });

  it("fails closed (founder:rina, no throw) on a bad secret or clock at verify time", () => {
    expect(verifyPersonaCookie(officer(), { ...keys, secret: "", now: NOW })).toBe("founder:rina");
    expect(verifyPersonaCookie(officer(), { ...keys, secret: undefined as unknown as string, now: NOW })).toBe("founder:rina");
    expect(verifyPersonaCookie(officer(), { ...keys, now: Number.NaN })).toBe("founder:rina");
  });

  it("cookie attributes: HttpOnly, SameSite=Strict, Path=/api, no Domain", () => {
    expect(PERSONA_COOKIE_OPTIONS).toEqual({ httpOnly: true, sameSite: "Strict", path: "/api" });
  });
});

describe("verifyPersonaCookie per country (SG-DECISIONS Q1)", () => {
  const mei = () => signPersonaCookie("founder:mei", { ...keys, now: NOW });
  const at = (country: "MY" | "ID" | "SG") => ({ ...keys, now: NOW, country });

  it("defaults to the founder of the server's country: Mei for SG, Rina for MY and ID (and with no country)", () => {
    expect(FOUNDER_PERSONA_BY_COUNTRY).toEqual({ MY: "founder:rina", ID: "founder:rina", SG: "founder:mei" });
    expect(DEFAULT_PERSONA).toBe("founder:rina");
    expect(verifyPersonaCookie(undefined, at("SG"))).toBe("founder:mei");
    expect(verifyPersonaCookie(undefined, at("MY"))).toBe("founder:rina");
    expect(verifyPersonaCookie(undefined, at("ID"))).toBe("founder:rina");
    expect(verifyPersonaCookie(undefined, { ...keys, now: NOW })).toBe("founder:rina");
  });

  it("accepts only the server country's founder: a valid cookie of the other founder reads as the default", () => {
    expect(verifyPersonaCookie(mei(), at("SG"))).toBe("founder:mei");
    expect(verifyPersonaCookie(founder(), at("SG"))).toBe("founder:mei");
    expect(verifyPersonaCookie(founder(), at("MY"))).toBe("founder:rina");
    expect(verifyPersonaCookie(mei(), at("MY"))).toBe("founder:rina");
    expect(verifyPersonaCookie(mei(), at("ID"))).toBe("founder:rina");
    expect(verifyPersonaCookie(mei(), { ...keys, now: NOW })).toBe("founder:rina");
  });

  it("keeps the officer in every country, and fails closed to the country's founder on anything bad", () => {
    for (const country of ["MY", "ID", "SG"] as const) expect(verifyPersonaCookie(officer(), at(country))).toBe("officer");
    expect(verifyPersonaCookie(flip(officer(), officer().length - 2), at("SG"))).toBe("founder:mei");
    expect(verifyPersonaCookie(mei(), { ...at("SG"), now: NOW + 8 * HOUR_MS })).toBe("founder:mei");
    expect(verifyPersonaCookie(officer(), { ...at("SG"), secret: randomSecret() })).toBe("founder:mei");
    const [, mExp, mMac] = mei().split(".");
    expect(verifyPersonaCookie(`founder:rina.${mExp}.${mMac}`, at("MY")), "Mei's MAC relabelled as Rina").toBe("founder:rina");
    expect(verifyPersonaCookie(`officer.${mExp}.${mMac}`, at("SG")), "Mei's MAC relabelled as officer").toBe("founder:mei");
  });

  it("throws on caller misuse (a country the server cannot have), never on the cookie", () => {
    for (const bad of ["TH", "toString", "__proto__", ""]) {
      expect(() => defaultPersonaFor(bad as never), bad).toThrow(/unknown country/);
      expect(() => verifyPersonaCookie(officer(), { ...keys, now: NOW, country: bad as never }), bad).toThrow(/unknown country/);
    }
  });
});

describe("parsePersonaCookieSecret", () => {
  it("is required when DEMO_MODE=1 (no default)", () => {
    expect(() => parsePersonaCookieSecret({ DEMO_MODE: "1" })).toThrow(/PERSONA_COOKIE_SECRET/);
    expect(() => parsePersonaCookieSecret({ DEMO_MODE: "1", PERSONA_COOKIE_SECRET: "" })).toThrow(/PERSONA_COOKIE_SECRET/);
  });

  it("returns a strong secret", () => {
    expect(parsePersonaCookieSecret({ DEMO_MODE: "1", PERSONA_COOKIE_SECRET: SECRET })).toBe(SECRET);
  });

  it("rejects a weak secret in any mode", () => {
    for (const env of [{ DEMO_MODE: "1" }, {}]) {
      for (const weak of ["a".repeat(32), SECRET.slice(0, 31), `${SECRET}\n`, `example-${SECRET}`]) {
        expect(() => parsePersonaCookieSecret({ ...env, PERSONA_COOKIE_SECRET: weak })).toThrow(/PERSONA_COOKIE_SECRET/);
      }
    }
  });

  it("is optional outside demo mode (no persona cookie is minted then)", () => {
    expect(parsePersonaCookieSecret({})).toBeUndefined();
    expect(parsePersonaCookieSecret({ DEMO_MODE: "0" })).toBeUndefined();
  });

  it("never echoes the secret in its error", () => {
    const weak = "a".repeat(40);
    let message = "";
    try {
      parsePersonaCookieSecret({ DEMO_MODE: "1", PERSONA_COOKIE_SECRET: weak });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/PERSONA_COOKIE_SECRET/);
    expect(message).not.toContain(weak);
  });
});
