/**
 * G0-AUDIT (v-2): guard in front of /api, used by apps/web/app/api/[...route]/route.ts for every mode
 * (live, mock, replay).
 *
 * - Host allow-list (HOGEE_ALLOWED_HOSTS): a DNS-rebinding page reaches localhost:3000 with its own hostname in
 *   Host, so any Host outside the list is refused.
 * - State-changing methods (anything but GET/HEAD/OPTIONS; every GET route is a read, see routes.test.ts):
 *   Sec-Fetch-Site, when present, must be same-origin or none, and Origin, when present, must be http(s) with
 *   host:port equal to the request's Host (another allowed host is still a different origin). A POST with neither
 *   header passes: browsers send both on cross-site POSTs; non-browser clients (e.g. the Stripe CLI forwarder) don't.
 */
export const DEFAULT_ALLOWED_HOSTS = "localhost:3000,127.0.0.1:3000";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// host[:port]: DNS labels (a-z0-9.-) or the IPv6 loopback [::1]; port 1..65535 without a leading zero.
const HOST_ENTRY = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[::1\\])(?::([1-9][0-9]{0,4}))?$`);
const MAX_PORT = 65535;
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const TRUSTED_FETCH_SITES: ReadonlySet<string> = new Set(["same-origin", "none"]);

/**
 * Parses HOGEE_ALLOWED_HOSTS (comma-separated host[:port]). Unset or blank → localhost:3000, 127.0.0.1:3000.
 * Fails closed: any invalid entry (wildcard, scheme, path, empty entry, bad port) throws at startup.
 */
export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> {
  const source = raw?.trim() ? raw : DEFAULT_ALLOWED_HOSTS;
  const hosts = source.split(",").map((entry) => entry.trim().toLowerCase());
  for (const host of hosts) {
    const match = HOST_ENTRY.exec(host);
    const port = match?.[1];
    if (!match || (port !== undefined && Number(port) > MAX_PORT)) {
      throw new Error(`HOGEE_ALLOWED_HOSTS: invalid entry "${host}" (expected host[:port], e.g. localhost:3000)`);
    }
  }
  return new Set(hosts);
}

function forbidden(message: string): Response {
  return Response.json({ error: { code: "FORBIDDEN", message } }, { status: 403 });
}

/** host[:port] of an http(s) Origin header, or null when it is "null", not http(s) or unparsable. */
function originHost(origin: string): string | null {
  if (origin === "null") return null;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

/** A 403 FORBIDDEN ApiError response when the request is not from an allowed host/origin; otherwise null. */
export function rejectUntrustedRequest(req: Request, allowed: ReadonlySet<string>): Response | null {
  const host = req.headers.get("host")?.trim().toLowerCase();
  if (!host || !allowed.has(host)) return forbidden("Host not allowed");
  if (SAFE_METHODS.has(req.method.toUpperCase())) return null;
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && !TRUSTED_FETCH_SITES.has(site.trim().toLowerCase())) return forbidden("Cross-site request refused");
  const origin = req.headers.get("origin");
  if (origin !== null && originHost(origin) !== host) return forbidden("Cross-origin request refused");
  return null;
}
