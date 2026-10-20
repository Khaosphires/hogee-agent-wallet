// G0-AUDIT (v-2): Host/Origin/Sec-Fetch-Site guard in front of /api (officer token tests: operator-secrets.test.ts).
import { describe, expect, it } from "vitest";
import { ApiError } from "@hogee/core";
import { parseAllowedHosts, rejectUntrustedRequest } from "../src/index";

const ALLOWED = parseAllowedHosts(undefined);
const URL_BASE = "http://localhost:3000/api";

const request = (method: string, headers: Record<string, string>, path = "/session/persona"): Request =>
  new Request(`${URL_BASE}${path}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify({ persona: "officer" }) } : {}),
  });

const expectForbidden = async (res: Response | null): Promise<void> => {
  expect(res).not.toBeNull();
  if (!res) return;
  expect(res.status).toBe(403);
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  const body = ApiError.safeParse(await res.json());
  expect(body.success).toBe(true);
  if (body.success) expect(body.data.error.code).toBe("FORBIDDEN");
};

describe("parseAllowedHosts", () => {
  it("defaults to localhost:3000 and 127.0.0.1:3000 when unset or blank", () => {
    for (const raw of [undefined, "", "   "]) {
      expect([...parseAllowedHosts(raw)].sort()).toEqual(["127.0.0.1:3000", "localhost:3000"]);
    }
  });

  it("trims and lowercases entries; accepts a bare host, a port and [::1]", () => {
    expect([...parseAllowedHosts(" Demo.Hogee.TEST:8443 , localhost , [::1]:3000 ")].sort()).toEqual([
      "[::1]:3000",
      "demo.hogee.test:8443",
      "localhost",
    ]);
  });

  it.each([
    "*",
    "localhost:3000,",
    "http://localhost:3000",
    "localhost:3000/api",
    "localhost:0",
    "localhost:65536",
    "localhost:03000",
    "evil.example:3000:1",
    "-evil.example",
    "evil..example",
    "user@localhost:3000",
    "[::2]:3000",
  ])("throws on the invalid entry %j (fail closed)", (raw) => {
    expect(() => parseAllowedHosts(raw)).toThrow(/HOGEE_ALLOWED_HOSTS/);
  });
});

describe("rejectUntrustedRequest", () => {
  it("lets an allowed GET through", () => {
    expect(rejectUntrustedRequest(request("GET", { host: "localhost:3000" }, "/session"), ALLOWED)).toBeNull();
  });

  it("matches the Host header case-insensitively", () => {
    expect(rejectUntrustedRequest(request("GET", { host: "LocalHost:3000" }, "/session"), ALLOWED)).toBeNull();
  });

  it("rejects a foreign Host (DNS rebinding)", async () => {
    await expectForbidden(rejectUntrustedRequest(request("GET", { host: "rebind.evil.example:3000" }, "/session"), ALLOWED));
    await expectForbidden(rejectUntrustedRequest(request("GET", { host: "localhost:3001" }, "/session"), ALLOWED));
  });

  it("rejects a missing Host", async () => {
    await expectForbidden(rejectUntrustedRequest(request("GET", {}, "/session"), ALLOWED));
  });

  it("rejects a cross-site POST (foreign Origin)", async () => {
    await expectForbidden(
      rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin: "https://evil.example" }), ALLOWED),
    );
    await expectForbidden(
      rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin: "http://localhost:3001" }), ALLOWED),
    );
  });

  it("rejects a same-site POST from another allowed host: Origin must equal the request's Host", async () => {
    const both = parseAllowedHosts("localhost:3000,localhost:3001,127.0.0.1:3000");
    await expectForbidden(
      rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin: "http://localhost:3001" }), both),
    );
    await expectForbidden(
      rejectUntrustedRequest(
        request("POST", { host: "localhost:3000", origin: "http://localhost:3001", "sec-fetch-site": "same-site" }),
        both,
      ),
    );
    await expectForbidden(
      rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin: "http://127.0.0.1:3000" }), both),
    );
  });

  it("rejects a POST whose Sec-Fetch-Site is cross-site or same-site, even without Origin", async () => {
    for (const site of ["cross-site", "same-site", "CROSS-SITE", "bogus"]) {
      await expectForbidden(rejectUntrustedRequest(request("POST", { host: "localhost:3000", "sec-fetch-site": site }), ALLOWED));
    }
  });

  it("lets a POST with Sec-Fetch-Site same-origin or none through", () => {
    for (const site of ["same-origin", "none"]) {
      expect(
        rejectUntrustedRequest(
          request("POST", { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": site }),
          ALLOWED,
        ),
        site,
      ).toBeNull();
    }
  });

  it("lets a same-origin POST through", () => {
    expect(
      rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin: "http://localhost:3000" }), ALLOWED),
    ).toBeNull();
    expect(
      rejectUntrustedRequest(request("POST", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }), ALLOWED),
    ).toBeNull();
  });

  it("lets a Stripe-style POST (no Origin, no Sec-Fetch-Site) through (non-browser clients, e.g. the Stripe CLI forwarder)", () => {
    expect(rejectUntrustedRequest(request("POST", { host: "localhost:3000" }, "/webhooks/stripe"), ALLOWED)).toBeNull();
  });

  it('rejects Origin "null" (sandboxed iframe, file://, opaque redirect)', async () => {
    await expectForbidden(rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin: "null" }), ALLOWED));
  });

  it("rejects a non-http(s) or unparsable Origin", async () => {
    for (const origin of ["file://localhost:3000", "chrome-extension://abcdef", "localhost:3000", "http://"]) {
      await expectForbidden(rejectUntrustedRequest(request("POST", { host: "localhost:3000", origin }), ALLOWED));
    }
  });

  it("ignores Origin and Sec-Fetch-Site on safe methods (Host is still checked)", () => {
    expect(
      rejectUntrustedRequest(
        request("GET", { host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, "/session"),
        ALLOWED,
      ),
    ).toBeNull();
  });

  it("uses the configured allow-list", async () => {
    const custom = parseAllowedHosts("demo.hogee.test");
    expect(
      rejectUntrustedRequest(request("POST", { host: "demo.hogee.test", origin: "https://demo.hogee.test" }), custom),
    ).toBeNull();
    await expectForbidden(rejectUntrustedRequest(request("GET", { host: "localhost:3000" }, "/session"), custom));
  });
});
