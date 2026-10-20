/**
 * The page CSP (run-9 hardening, h-web): scripts only from this origin with the request's nonce, no plugins, no
 * <base> hijack, no framing; 'unsafe-eval' only for `next dev`.
 */
import { describe, expect, it } from "vitest";
import { BASE_CSP, newNonce, pageCsp } from "./csp";

const NONCE = "AAECAwQFBgcICQoLDA0ODw==";

const directives = (policy: string): Map<string, string[]> =>
  new Map(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name as string, values]),
  );

describe("the page CSP", () => {
  it("allows only this origin's scripts that carry the request's nonce (and what they load)", () => {
    const d = directives(pageCsp({ nonce: NONCE, dev: false }));
    expect(d.get("script-src")).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("never allows eval or inline scripts in production", () => {
    const policy = pageCsp({ nonce: NONCE, dev: false });
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("unsafe-inline");
  });

  it("allows eval only in development (React rebuilds server error stacks with it)", () => {
    expect(directives(pageCsp({ nonce: NONCE, dev: true })).get("script-src")).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'", "'unsafe-eval'"]);
  });

  it("refuses a nonce that is not plain base64 (it would break out of the directive)", () => {
    for (const bad of ["", "abc' 'unsafe-inline", "a;b", "a b", "nonce\n"]) expect(() => pageCsp({ nonce: bad, dev: false }), bad).toThrow();
  });

  it("keeps every other route's policy (API responses, static files) free of a script allowance", () => {
    const d = directives(BASE_CSP);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.has("script-src")).toBe(false);
  });

  it("makes a fresh 128-bit base64 nonce per call", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(() => pageCsp({ nonce: a, dev: false })).not.toThrow();
  });
});
