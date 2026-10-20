/**
 * The one canonical form of a listing URL (re-check keccak LOW 1). A web supplier id is sha256 of this string, so two
 * spellings of one listing (`/x.html`, `/%78.html`, `/a%2fb` vs `/a%2Fb`) must collapse to one form or the same listing
 * would get several ids (duplicate shortlist slots, a second order). checks' allowedListingUrl and core's
 * webSupplierIdOf both go through canonicalListingUrl.
 * WHATWG URL parsing already lowercases the host, applies punycode, drops a default port and removes dot segments
 * (including `%2e` spellings); it leaves percent-escapes in the path as written. canonicalPath finishes the job
 * (RFC 3986 §6.2.2): an escape of an unreserved character is decoded, every other escape gets uppercase hex, and a "%"
 * that starts no escape is written "%25".
 */

/** RFC 3986 §2.3 unreserved characters. */
const UNRESERVED_RE = /^[A-Za-z0-9\-._~]$/;
const ESCAPE_RE = /%([0-9A-Fa-f]{2})/g;
const LONE_PERCENT_RE = /%(?![0-9A-Fa-f]{2})/g;

/** A URL path with its percent-encoding normalised (unreserved decoded, the rest uppercase hex, lone "%" as "%25"). */
export function canonicalPath(path: string): string {
  return path.replace(LONE_PERCENT_RE, "%25").replace(ESCAPE_RE, (_, hex: string) => {
    const ch = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED_RE.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

/**
 * The canonical https listing URL (origin + normalised path; no query, fragment, port or user info), or null when
 * `raw` is not an https URL without port and user info. Idempotent: canonicalListingUrl(c) === c for every result c.
 * Allow-listing the host is the caller's job (checks allowedListingUrl).
 */
export function canonicalListingUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  const path = canonicalPath(url.pathname);
  let out: URL;
  try {
    out = new URL(`${url.origin}${path}`);
  } catch {
    return null;
  }
  // Fail closed if re-parsing moved anything (it should not: decoding unreserved characters makes no new dot segment).
  return out.origin === url.origin && out.pathname === path && out.search === "" && out.hash === "" ? out.href : null;
}
