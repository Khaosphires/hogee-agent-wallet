/**
 * v-search core helpers: the enum-only query (T33), web supplier ids, the web candidate → Supplier mapping, the
 * enquiry template and the runtime wording check (kept equal to scripts/lint-wording).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COUNTRY_NAME,
  DataEnquiry,
  NAME_HIDDEN,
  PRODUCT_CATEGORIES,
  QUERY_BY_CATEGORY,
  WEB_CERT_ISSUER,
  WEB_SUPPLIER_ID_RE,
  buildEnquiry,
  candidateToSupplier,
  canonicalListingUrl,
  cardSafeName,
  passesWording,
  payoutAccountHash,
  supplierQuery,
  webSupplierIdOf,
  type Supplier,
} from "../src/index";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };
const RECORDED = JSON.parse(readFileSync(join(ROOT, "data/suppliers/search/recorded/drinkware_food_contact-CN.json"), "utf8")) as { query: string; results: { url: string }[] };
const READER_IDS = readdirSync(join(ROOT, "data/suppliers/search/reader")).map((f) => f.replace(/\.json$/, ""));

describe("supplierQuery (enum tables only)", () => {
  it("is exactly the recorded sample's query for Mei's drinkware from China", () => {
    expect(supplierQuery({ productCategory: "drinkware_food_contact", buyFrom: "CN" })).toBe("insulated stainless steel tumbler manufacturer China");
    expect(RECORDED.query).toBe(supplierQuery({ productCategory: "drinkware_food_contact", buyFrom: "CN" }));
  });

  it("refuses a category or country without fixed words (never improvised)", () => {
    expect(supplierQuery({ productCategory: "other", buyFrom: "CN" })).toBeNull();
    expect(supplierQuery({ productCategory: "drinkware_food_contact", buyFrom: "ZZ" })).toBeNull();
    expect(supplierQuery({ productCategory: "drinkware_food_contact", buyFrom: "constructor" })).toBeNull();
  });

  it("every possible query is short, plain and wording-clean", () => {
    for (const p of PRODUCT_CATEGORIES) {
      for (const cc of Object.keys(COUNTRY_NAME)) {
        const q = supplierQuery({ productCategory: p, buyFrom: cc });
        if (QUERY_BY_CATEGORY[p] === null) expect(q).toBeNull();
        else {
          expect(q).toMatch(/^[A-Za-z ]{1,200}$/);
          expect(checkText(q ?? "")).toEqual([]);
        }
      }
    }
  });
});

describe("webSupplierIdOf", () => {
  it("names every recorded allow-listed listing exactly as its recorded Reader file (same as checks webSupplierId)", () => {
    const listed = RECORDED.results.filter((r) => !r.url.includes(".example/")).map((r) => webSupplierIdOf(r.url));
    expect(listed).toHaveLength(9);
    expect([...listed].sort()).toEqual([...READER_IDS].sort());
    for (const id of listed) expect(id).toMatch(WEB_SUPPLIER_ID_RE);
  });

  it("refuses a URL that is not canonical https (query, fragment, port, http)", () => {
    for (const bad of ["http://www.alibaba.com/x", "https://www.alibaba.com/x?ref=1", "https://www.alibaba.com/x#a", "https://www.alibaba.com:8443/x", "https://u:p@www.alibaba.com/x", "not a url"]) {
      expect(() => webSupplierIdOf(bad), bad).toThrow();
    }
  });
});

describe("canonicalListingUrl (one form per listing, so one web supplier id)", () => {
  it.each([
    ["https://www.alibaba.com/product-detail/x.html", "https://www.alibaba.com/product-detail/x.html"],
    ["https://www.alibaba.com/product-detail/%78.html", "https://www.alibaba.com/product-detail/x.html"],
    ["https://www.alibaba.com/product-detail/%7ex%2Dy%5f1%2e.html", "https://www.alibaba.com/product-detail/~x-y_1..html"],
    ["https://www.alibaba.com/a%2fb%c3%a9", "https://www.alibaba.com/a%2Fb%C3%A9"],
    ["https://www.alibaba.com/a%2Fb%C3%A9", "https://www.alibaba.com/a%2Fb%C3%A9"],
    ["https://www.alibaba.com/caf\u00e9", "https://www.alibaba.com/caf%C3%A9"],
    ["https://www.alibaba.com/100%", "https://www.alibaba.com/100%25"],
    ["https://www.alibaba.com/a%zz", "https://www.alibaba.com/a%25zz"],
    ["https://WWW.Alibaba.COM/x?spm=1#top", "https://www.alibaba.com/x"],
  ])("%s → %s", (raw, expected) => {
    const canonical = canonicalListingUrl(raw);
    expect(canonical).toBe(expected);
    expect(canonicalListingUrl(canonical ?? "")).toBe(canonical);
  });

  it("refuses what is not an https listing address (http, port, user info, not a URL)", () => {
    for (const bad of ["http://www.alibaba.com/x", "https://www.alibaba.com:8443/x", "https://u:p@www.alibaba.com/x", "not a url", ""]) {
      expect(canonicalListingUrl(bad), bad).toBeNull();
    }
  });

  it("webSupplierIdOf refuses a non-canonical spelling, so an encoded twin can never get a second id", () => {
    expect(() => webSupplierIdOf("https://www.alibaba.com/product-detail/%78.html")).toThrow();
    expect(() => webSupplierIdOf("https://www.alibaba.com/a%2fb")).toThrow();
    expect(webSupplierIdOf("https://www.alibaba.com/a%2Fb")).toMatch(WEB_SUPPLIER_ID_RE);
  });
});

describe("candidateToSupplier", () => {
  const url = "https://www.alibaba.com/product-detail/20oz-Insulated-Stainless-Steel-Tumbler-Custom_1600482713501.html";
  const facts = {
    supplierId: webSupplierIdOf(url),
    displayName: "Yongkang Corvane Drinkware Co., Ltd.",
    country: "CN",
    listingUrl: url,
    rawTextRef: "data/suppliers/search/recorded/drinkware_food_contact-CN.json",
    sourceType: "mock" as const,
    certificates: ["LFGB food contact test report", "LFGB food contact test report", "x".repeat(101)],
    offer: {
      currency: "USD",
      fobUnit: { value: "235", sourceUrl: url, retrievedAt: "2026-10-19T08:00:00Z", snippetHash: `0x${"ab".repeat(32)}` as const, evidence: "tier3" as const, sourceType: "mock" as const },
      moq: 500,
      leadTimeDays: 25,
      freightPerUnit: "31",
      incoterm: "FOB" as const,
    },
  };

  it("maps a web candidate with a sentinel payout, escrow, tier3 certificates and zero metrics", () => {
    const s: Supplier = candidateToSupplier(facts);
    expect(s.xenditTest).toEqual({ channel: "UNSET", accountNumber: "0000", holderName: facts.displayName });
    expect(payoutAccountHash(s.xenditTest)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(s.terms).toEqual({ escrow: true, offPlatformDiscount: false, payeeType: "company" });
    expect(s.certificates).toEqual([{ type: "LFGB food contact test report", issuer: WEB_CERT_ISSUER, ref: facts.supplierId, tier: "tier3" }]);
    expect(s.metrics).toEqual({ rating: 0, responseRate: 0, yearsOnPlatform: 0 });
    expect(s.listing).toEqual({ url, sourceType: "mock", rawTextRef: facts.rawTextRef });
    expect(s.ids).toEqual({});
  });

  it("refuses an id that is not the listing URL's, or a catalog id", () => {
    expect(() => candidateToSupplier({ ...facts, supplierId: "supplier-waaaaaaaaaaaa" })).toThrow(/does not belong/);
    expect(() => candidateToSupplier({ ...facts, supplierId: "supplier-a" })).toThrow(/web supplier id/);
  });
});

describe("buildEnquiry", () => {
  const ids = ["supplier-wktbk5xmzmfob", "supplier-wavk4gkewt3zc"];

  it("asks price, MOQ, lead time, test reports, milestone payments and a company account; wording-clean for every category", () => {
    for (const productCategory of PRODUCT_CATEGORIES) {
      const e = buildEnquiry({ supplierIds: ids, productCategory, quantity: 100_000, currency: "SGD" });
      expect(DataEnquiry.parse(e)).toEqual(e);
      expect(checkText(`${e.subject}\n${e.body}`), productCategory).toEqual([]);
      expect(e.body).toMatch(/unit price at 100,000 pieces/);
      expect(e.body).toMatch(/minimum order quantity/);
      expect(e.body).toMatch(/lead time/);
      expect(e.body).toMatch(/test reports|licence/);
      expect(e.body).toMatch(/deposit when the order is placed, and the balance after the goods are delivered and checked/);
      expect(e.body).toMatch(/company bank account/);
    }
  });

  it("carries only the enums and the quantity: no names, no budget, no founder details", () => {
    const e = buildEnquiry({ supplierIds: ids, productCategory: "drinkware_food_contact", quantity: 1000, currency: "SGD" });
    expect(e.supplierIds).toEqual(ids);
    expect(e.subject).toBe("Quote request: 1,000 insulated stainless steel tumblers");
    expect(e.body).toMatch(/Food-contact test reports/);
    expect(`${e.subject}${e.body}`).not.toMatch(/Mei|Hogee|Corvane|budget|passport|phone|@/i);
    expect(`${e.subject}${e.body}`).not.toMatch(/\bBU\b/);
  });

  it("refuses a quantity or currency outside the contract", () => {
    expect(() => buildEnquiry({ supplierIds: ids, productCategory: "food", quantity: 0, currency: "SGD" })).toThrow(RangeError);
    expect(() => buildEnquiry({ supplierIds: ids, productCategory: "food", quantity: 100_001, currency: "SGD" })).toThrow(RangeError);
    expect(() => buildEnquiry({ supplierIds: ids, productCategory: "food", quantity: 10, currency: "sgd" })).toThrow(RangeError);
    expect(() => buildEnquiry({ supplierIds: [], productCategory: "food", quantity: 10, currency: "SGD" })).toThrow();
  });
});

describe("passesWording (runtime twin of scripts/lint-wording checkText)", () => {
  const samples = [
    "Yongkang Corvane Drinkware Co., Ltd.",
    "Shenzhen Global Trading Co., Ltd.",
    "Trade Assurance supplier",
    "Ningbo Tradewinds Housewares",
    "CERTIFIED factory",
    "certification body",
    "Coin cell maker",
    "Coinage Metals Co.",
    "high yield tumbler",
    "Issue-free delivery",
    "易发行有限公司",
    "交易保障",
    "under_trade",
    "trade2",
    "www.alibaba.com",
    "tradeasia.en.made-in-china.com",
    "programmable money supplies",
    "fine\nline two has a token",
    "plain tumbler maker",
  ];

  it("agrees with checkText on every sample (clean iff no finding)", () => {
    for (const s of samples) expect(passesWording(s), s).toBe(checkText(s).length === 0);
  });

  it("hides a failing or overlong name", () => {
    expect(cardSafeName("Shenzhen Global Trade Co., Ltd.", 120)).toBe(NAME_HIDDEN);
    expect(cardSafeName("A".repeat(121), 120)).toBe(NAME_HIDDEN);
    expect(cardSafeName("  Ningbo Ashmere Housewares Co., Ltd. ", 120)).toBe("Ningbo Ashmere Housewares Co., Ltd.");
    expect(checkText(NAME_HIDDEN)).toEqual([]);
  });
});
