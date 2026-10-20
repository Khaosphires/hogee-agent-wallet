/**
 * Content-Security-Policy (run-9 hardening, h-web). Pages get a per-request nonce from proxy.ts: scripts run only
 * when they carry it (Next.js puts it on every script it renders) or when such a script loads them ('strict-dynamic'),
 * so an injected inline script, event handler or javascript: URL never runs. No plugins (object-src), no <base>
 * that re-points relative URLs, no framing. 'unsafe-eval' is for `next dev` only (React rebuilds server error stacks
 * with eval); a production build never sends it. Every other route (the API, static files) gets BASE_CSP from
 * next.config.ts.
 */

/** The directives every response carries (next.config.ts), pages included. */
export const BASE_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

// Plain base64 only: a nonce is pasted into the header, so a quote, space or ';' would add a directive.
const NONCE = /^[A-Za-z0-9+/]+={0,2}$/;
const NONCE_BYTES = 16;

/** A fresh 128-bit nonce, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return btoa(String.fromCharCode(...bytes));
}

/** The page policy for one request. Throws on a nonce that is not plain base64. */
export function pageCsp({ nonce, dev }: { nonce: string; dev: boolean }): string {
  if (!NONCE.test(nonce)) throw new Error("CSP nonce must be plain base64");
  const scripts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])];
  return `script-src ${scripts.join(" ")}; ${BASE_CSP}`;
}
