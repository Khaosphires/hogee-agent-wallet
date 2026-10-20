// G0-AUDIT (v-2): operator secrets (OFFICER_TOKEN, PERSONA_COOKIE_SECRET) must be strong, and the officer token is
// compared in constant time.
import { describe, expect, it } from "vitest";
import { OfficerToken, ROUTE_EXAMPLES } from "@hogee/api-contract";
import { isStrongSecret, officerTokenMatches } from "../src/index";

// 40 chars, 16 distinct: strong.
// Passes every strength rule (40 distinct characters) yet is plainly not a real secret.
const STRONG = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
const PLACEHOLDER = (ROUTE_EXAMPLES.setPersona.req.body as { officerToken: string }).officerToken;

describe("isStrongSecret", () => {
  it("accepts a random 32..256-char secret", () => {
    expect(isStrongSecret(STRONG)).toBe(true);
    expect(isStrongSecret("abcdefghijkl".repeat(3).slice(0, 32))).toBe(true);
    expect(isStrongSecret(STRONG.repeat(7).slice(0, 256))).toBe(true);
  });

  it.each([
    ["32 spaces", " ".repeat(32)],
    ["one repeated char", "a".repeat(32)],
    ["11 distinct chars", "abcdefghijk".repeat(3)],
    ["31 chars", STRONG.slice(0, 31)],
    ["257 chars", STRONG.repeat(7).slice(0, 257)],
    ["a trailing newline", `${STRONG}\n`],
    ["a leading space", ` ${STRONG}`],
    ["the published placeholder", PLACEHOLDER],
    ["'not-a-secret'", `${STRONG}-not-a-secret`],
    ["'EXAMPLE' (any case)", `${STRONG}EXAMPLE`],
  ])("rejects %s", (_label, value) => {
    expect(isStrongSecret(value)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isStrongSecret(undefined)).toBe(false);
    expect(isStrongSecret(null)).toBe(false);
    expect(isStrongSecret(12345678901234567890123456789012)).toBe(false);
  });
});

describe("officerTokenMatches", () => {
  it("matches the configured token", () => {
    expect(officerTokenMatches(STRONG, STRONG)).toBe(true);
  });

  it("rejects a different token of the same length", () => {
    expect(officerTokenMatches(`${STRONG.slice(0, -1)}0`, STRONG)).toBe(false);
  });

  it("rejects a token of a different length (no length-based throw)", () => {
    expect(officerTokenMatches(`${STRONG}0`, STRONG)).toBe(false);
    expect(officerTokenMatches("", STRONG)).toBe(false);
  });

  it("fails closed when OFFICER_TOKEN is unset", () => {
    expect(officerTokenMatches(STRONG, undefined)).toBe(false);
  });

  it.each([
    ["32 spaces", " ".repeat(32)],
    ["'a' x 32", "a".repeat(32)],
    ["the published placeholder", PLACEHOLDER],
    ["a 257-char token", STRONG.repeat(7).slice(0, 257)],
    ["a trailing newline", `${STRONG}\n`],
    ["31 chars", STRONG.slice(0, 31)],
  ])("fails closed when OFFICER_TOKEN is weak (%s), even on an exact match", (_label, weak) => {
    expect(officerTokenMatches(weak, weak)).toBe(false);
  });

  it("rejects a non-string given token", () => {
    expect(officerTokenMatches(undefined as unknown as string, STRONG)).toBe(false);
  });

  it("uses the same 32..256 bounds as the api-contract OfficerToken schema", () => {
    const min = STRONG.slice(0, 32);
    expect(OfficerToken.safeParse(min).success).toBe(true);
    expect(officerTokenMatches(min, min)).toBe(true);
    expect(OfficerToken.safeParse(min.slice(1)).success).toBe(false);
    expect(officerTokenMatches(min.slice(1), min.slice(1))).toBe(false);
    const max = STRONG.repeat(7).slice(0, 256);
    expect(OfficerToken.safeParse(max).success).toBe(true);
    expect(officerTokenMatches(max, max)).toBe(true);
    expect(OfficerToken.safeParse(`${max}0`).success).toBe(false);
  });
});
