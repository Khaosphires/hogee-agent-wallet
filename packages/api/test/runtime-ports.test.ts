/** Live adapters: Stripe test-mode port, the redacting logger and the file catalog (P3 data contracts). */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileCatalog, findDataDir } from "../src/runtime/catalog";
import { jsonLogger, stripePort } from "../src/runtime/ports";
import { TEST_PACK_MY, TEST_SUPPLIERS } from "./support/catalog";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("stripePort", () => {
  const key = `sk_test_${"a1".repeat(12)}`;
  it("is null without a key and refuses a live key without echoing it", () => {
    expect(stripePort(undefined)).toBeNull();
    const live = `sk_live_${"b2".repeat(12)}`;
    expect(() => stripePort(live)).toThrow(/STRIPE_SECRET_KEY/);
    try {
      stripePort(live);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(live);
    }
  });

  it("creates a confirmed test PaymentIntent with this facility's metadata and an idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "pi_test_1", livemode: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const port = stripePort(key, fake);
    expect(await port?.createTestPayment({ amountMinor: 5000n, currency: "MYR", facilityId: "fac-rina", idempotencyKey: "demo-sale-1" })).toEqual({ paymentIntentId: "pi_test_1" });
    const body = new URLSearchParams(String(calls[0]?.init.body));
    expect(body.get("metadata[facilityId]")).toBe("fac-rina");
    expect(body.get("currency")).toBe("myr");
    expect((calls[0]?.init.headers as Record<string, string>)["idempotency-key"]).toBe("demo-sale-1");
  });

  it("surfaces only Stripe's error code, never a key", async () => {
    const fake = (async () => new Response(JSON.stringify({ error: { code: "card_declined", message: `bad ${key}` } }), { status: 402 })) as unknown as typeof fetch;
    await expect(stripePort(key, fake)?.createTestPayment({ amountMinor: 1n, currency: "MYR", facilityId: "f", idempotencyKey: "k" })).rejects.toThrow(/^stripe_error:card_declined$/);
  });
});

describe("jsonLogger", () => {
  it("drops secret-named fields and redacts URLs", () => {
    const lines: string[] = [];
    jsonLogger((l) => lines.push(l)).error("x", { officerToken: "t0p", url: "https://rpc.example/v2/abc123", n: 1n });
    const out = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(out.officerToken).toBeUndefined();
    expect(String(out.url)).not.toContain("abc123");
    expect(out.n).toBe("1");
  });
});

describe("fileCatalog", () => {
  it("reads packs and suppliers from P3's data layout; a listing path outside the repo is ignored", async () => {
    const repo = mkdtempSync(join(tmpdir(), "hogee-cat-"));
    const data = join(repo, "data");
    mkdirSync(join(data, "schemas"), { recursive: true });
    mkdirSync(join(data, "country-packs"));
    mkdirSync(join(data, "suppliers", "demo"), { recursive: true });
    mkdirSync(join(data, "suppliers", "raw"), { recursive: true });
    writeFileSync(join(data, "country-packs", "MY.json"), JSON.stringify(TEST_PACK_MY));
    const [a, b] = TEST_SUPPLIERS;
    writeFileSync(join(data, "suppliers", "raw", "a.txt"), "Insulated tumbler listing");
    writeFileSync(join(data, "suppliers", "demo", "A.json"), JSON.stringify({ supplier: { ...a?.supplier, listing: { ...a?.supplier.listing, rawTextRef: "data/suppliers/raw/a.txt" } }, evidence: a?.evidence }));
    writeFileSync(join(data, "suppliers", "demo", "B.json"), JSON.stringify({ ...b?.supplier, listing: { ...b?.supplier.listing, rawTextRef: "../../etc/passwd" } }));
    writeFileSync(join(data, "suppliers", "demo", "C.json"), "{\"not\":\"a supplier\"}");
    expect(findDataDir(undefined, join(data, "suppliers"))).toBe(data);
    const cat = fileCatalog(data, silent);
    expect((await cat.countryPack("MY"))?.countryCode).toBe("MY");
    expect(await cat.countryPack("ID")).toBeNull();
    const s = await cat.suppliers();
    expect(s.map((x) => x.supplier.supplierId)).toEqual(["supplier-a", "supplier-b"]);
    expect(s[0]?.listingText).toBe("Insulated tumbler listing");
    expect(s[0]?.evidence.length).toBeGreaterThan(0);
    expect(s[1]?.listingText).toBeNull(); // declared but unreadable: a shortlist with it fails closed
  });
});
