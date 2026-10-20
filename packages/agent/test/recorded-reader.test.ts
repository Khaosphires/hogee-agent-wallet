/**
 * Recorded Reader outputs for recorded web search (VISION-DECISIONS §8): data/suppliers/search/reader/<supplierId>.json,
 * so recorded mode needs no model key. Each file is the Reader's own ListingReading for one recorded listing, plus
 * `label: "recorded sample"`, with no LLM call ids. This test:
 * - validates every file against a strict schema of ListingReading (untrusted labels, grounded number fields);
 * - re-runs the real Reader on listingTextOf(result) with a mock model replaying the recorded model output below, and
 *   requires the file to equal that output (so every number is snippet-grounded and every flag and gate recomputed);
 * - requires exactly one file per allow-listed recorded result, and checks each scenario's gates.
 * After editing the recorded search sample or the outputs below, regenerate with
 *   HOGEE_WRITE_RECORDED_READER=1 pnpm --filter @hogee/agent exec vitest run test/recorded-reader.test.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtractedField, Hex32, IMPERATIVE_FLAGS, Minor, RedFlag, SupplierGate, type SupplierGate as Gate } from "@hogee/core";
import { allowedListingUrl, listingTextOf, parseTavilyBody, webSupplierId } from "../../checks/src/websearch";
import { READER_CURRENCIES } from "../src/reader/prefilter";
import { readDocument } from "../src/reader/reader";
import type { StrictListing } from "../src/reader/schemas";
import { guarded, mockHandle, mockModel, textResult } from "./helpers/mock-model";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECORDED = join(REPO, "data", "suppliers", "search", "recorded", "drinkware_food_contact-CN.json");
const READER_DIR = join(REPO, "data", "suppliers", "search", "reader");
const WRITE = process.env.HOGEE_WRITE_RECORDED_READER === "1";

// ---- strict schema of a recorded ListingReading (packages/agent/src/reader/reader.ts + fields.ts) ----------------
const WEB_ID_RE = /^supplier-w[a-z2-7]{12}$/;
const Text = (max: number) => z.string().trim().min(1).max(max);
const HttpsUrl = z.url({ protocol: /^https$/ });
const label = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value, taint: z.strictObject({ trust: z.literal("untrusted"), sensitivity: z.literal("public") }), source: z.string().regex(/^reader:listing:supplier-w[a-z2-7]{12}$/) });
const MoneyField = z.strictObject({ amountMinor: Minor, currency: z.enum(READER_CURRENCIES), unit: z.enum(READER_CURRENCIES), sourceUrl: HttpsUrl, snippetHash: Hex32, method: z.literal("llm") });
const CountField = z.strictObject({ value: z.string().regex(/^(0|[1-9]\d{0,11})$/), unit: Text(32), sourceUrl: HttpsUrl, snippetHash: Hex32, method: z.literal("llm") });
const RecordedReading = z.strictObject({
  label: z.literal("recorded sample"),
  kind: z.literal("listing"),
  docId: z.string().regex(WEB_ID_RE),
  fields: z.strictObject({
    sellerName: label(Text(200)).nullable(),
    productTitle: label(Text(200)).nullable(),
    unitPrice: label(MoneyField).nullable(),
    moq: label(CountField).nullable(),
    leadTimeDays: label(CountField).nullable(),
    certificates: label(z.array(Text(100)).max(20)),
    claimsEscrow: label(z.boolean().nullable()),
  }),
  flags: z.array(z.strictObject({ flag: z.enum(IMPERATIVE_FLAGS), excerpt: z.string().max(120), index: z.int().nonnegative() })),
  redFlags: z.array(RedFlag),
  supplierGates: z.array(SupplierGate),
  dropped: z.array(z.string()).length(0),
  repaired: z.literal(false),
  llmCallIds: z.array(z.string()).length(0),
  extracted: z.record(z.string(), ExtractedField),
});

// ---- the recorded model outputs (what a reader model returned for each listing text) ----------------------------
type Recorded = { readonly output: StrictListing; readonly gates: readonly Gate[] };
const n = (value: string, unit: string, snippet: string) => ({ value, unit, snippet });
const listing = (o: Partial<StrictListing> & Pick<StrictListing, "sellerName" | "productTitle" | "currency" | "unitPrice" | "moq" | "leadTimeDays">): StrictListing => ({
  certificates: [],
  claimsEscrow: null,
  offersOffPlatformDiscount: false,
  addressesAiAgents: false,
  ...o,
});

const MODEL_OUTPUTS: Readonly<Record<string, Recorded>> = {
  "https://www.alibaba.com/product-detail/20oz-Insulated-Stainless-Steel-Tumbler-Custom_1600482713501.html": {
    gates: [],
    output: listing({
      sellerName: "Yongkang Corvane Drinkware Co., Ltd.",
      productTitle: "20oz double-wall vacuum insulated tumbler",
      currency: "USD",
      unitPrice: n("2.35", "USD", "Price: USD 2.35 per piece (FOB Ningbo), 500-1999 pieces."),
      moq: n("500", "pieces", "MOQ: 500 pieces."),
      leadTimeDays: n("25", "days", "Lead time: 25 days after sample approval."),
      certificates: ["LFGB food contact test report", "FDA food contact test report"],
      claimsEscrow: true,
    }),
  },
  "https://tidelume.en.made-in-china.com/product/kQZmLrTxYhVa/China-30oz-Stainless-Steel-Vacuum-Tumbler.html": {
    gates: [],
    output: listing({
      sellerName: "Zhejiang Tidelume Cup Industry Co., Ltd.",
      productTitle: "30oz stainless steel vacuum insulated tumbler with sliding lid",
      currency: "USD",
      unitPrice: n("2.10", "USD", "FOB price: USD 2.10 / piece"),
      moq: n("1,000", "pieces", "Min. order: 1,000 pieces"),
      leadTimeDays: n("30", "days", "Production lead time: 30 days"),
      certificates: ["LFGB and FDA food contact test reports"],
      claimsEscrow: null,
    }),
  },
  "https://www.alibaba.com/product-detail/Wholesale-20oz-Insulated-Tumbler-Factory_1600517390822.html": {
    gates: ["AI_INJECTION"],
    output: listing({
      sellerName: "Hangzhou Veltrix Kitchenware Co., Ltd.",
      productTitle: "20oz insulated tumbler, 304 stainless steel, press-in lid",
      currency: "USD",
      unitPrice: n("2.20", "USD", "Price: USD 2.20 per piece."),
      moq: n("300", "pieces", "MOQ: 300 pieces."),
      leadTimeDays: n("20", "days", "Lead time: 20 days."),
      addressesAiAgents: true,
    }),
  },
  "https://www.globalsources.com/Insulated-tumbler/vacuum-stainless-steel-tumbler-1213486570p.htm": {
    gates: [],
    output: listing({
      sellerName: "Ningbo Ashmere Housewares Co., Ltd.",
      productTitle: "20 oz vacuum insulated stainless steel tumbler with handle and straw lid",
      currency: "USD",
      unitPrice: n("2.60", "USD", "Unit price: USD 2.60 (FOB Ningbo)."),
      moq: n("300", "pieces", "Minimum order: 300 pieces."),
      leadTimeDays: n("20", "days", "Lead time: 20 days."),
      certificates: ["LFGB food contact test report"],
    }),
  },
  "https://glintora.en.made-in-china.com/product/pWsJdLqCvHrN/China-Insulated-Tumbler-20oz.html": {
    gates: ["OFF_PLATFORM_DISCOUNT"],
    output: listing({
      sellerName: "Shenzhen Glintora Cup Co., Ltd.",
      productTitle: "20oz insulated stainless steel tumbler with slide lid",
      currency: "USD",
      unitPrice: n("1.95", "USD", "FOB price: USD 1.95 / piece"),
      moq: n("500", "pieces", "Min. order: 500 pieces"),
      leadTimeDays: n("18", "days", "Lead time: 18 days"),
      claimsEscrow: false,
      offersOffPlatformDiscount: true,
    }),
  },
  "https://detail.1688.com/offer/718304629551.html": {
    gates: [],
    output: listing({
      sellerName: "Jinhua Pellora Vacuum Flask Co., Ltd.",
      productTitle: "20oz 304 stainless steel insulated tumbler",
      currency: "CNY",
      unitPrice: n("16.80", "CNY", "Price: CNY 16.80 per piece, from 200 pieces."),
      moq: n("200", "pieces", "MOQ: 200 pieces."),
      leadTimeDays: n("15", "days", "Lead time: 15 days."),
      certificates: ["GB 4806.9 food contact test report"],
      claimsEscrow: true,
    }),
  },
  "https://www.globalsources.com/Stainless-steel-tumbler/custom-logo-insulated-tumbler-1213509914p.htm": {
    gates: ["AI_INJECTION"],
    output: listing({
      sellerName: "Guangzhou Marrowind Drinkware Co., Ltd.",
      productTitle: "20oz custom logo insulated tumbler, 304 stainless steel",
      currency: "USD",
      unitPrice: n("2.30", "USD", "Unit price: USD 2.30 (FOB Guangzhou)."),
      moq: n("500", "pieces", "Minimum order: 500 pieces."),
      leadTimeDays: n("22", "days", "Lead time: 22 days."),
      addressesAiAgents: true,
    }),
  },
  "https://www.alibaba.com/product-detail/Clearance-20oz-Insulated-Tumbler-Stock_1600539076143.html": {
    gates: [],
    output: listing({
      sellerName: "Yiwu Lumacrest Tumbler Co., Ltd.",
      productTitle: "20oz insulated tumbler, stainless steel, clearance stock",
      currency: "USD",
      unitPrice: n("0.55", "USD", "Price: USD 0.55 per piece."),
      moq: n("1,000", "pieces", "MOQ: 1,000 pieces."),
      leadTimeDays: n("7", "days", "Lead time: 7 days."),
    }),
  },
  "https://starquill.en.alibaba.com/product/1600563318207-822044718/Powder_Coated_20oz_Vacuum_Tumbler.html": {
    gates: [],
    output: listing({
      sellerName: "Wuyi Starquill Steelware Co., Ltd.",
      productTitle: "20oz powder coated vacuum tumbler with straw lid",
      currency: "USD",
      unitPrice: n("2.45", "USD", "Price: USD 2.45 per piece (FOB Ningbo)."),
      moq: n("500", "pieces", "MOQ: 500 pieces."),
      leadTimeDays: n("28", "days", "Lead time: 28 days."),
      certificates: ["FDA food contact test report"],
      claimsEscrow: true,
    }),
  },
};

// ---- helpers --------------------------------------------------------------------------------------------------
const recordedJson = JSON.parse(readFileSync(RECORDED, "utf8")) as { results: { url: string }[] };
/** Every allow-listed recorded result (all of them, not only the first 8 an answer keeps). */
const allowed = recordedJson.results.flatMap((r, i) => (allowedListingUrl(r.url) ? [i] : []));
/** The recorded answer parsed one result at a time, so results beyond the 8-result cap get a reading too. */
const resultAt = (i: number) => {
  const r = parseTavilyBody({ ...recordedJson, results: [recordedJson.results[i]] }, "2026-10-19T08:00:00Z").results[0];
  if (!r) throw new Error(`recorded result ${i} is not allow-listed`);
  return r;
};

async function readingFor(i: number) {
  const r = resultAt(i);
  const recorded = MODEL_OUTPUTS[r.url];
  if (!recorded) throw new Error(`no recorded model output for ${r.url}`);
  const model = mockModel([textResult(JSON.stringify(recorded.output))], "claude-haiku-5-5");
  const { guarded: g } = guarded(mockHandle("reader", model));
  const supplierId = webSupplierId(r.url);
  const reading = await readDocument({ kind: "listing", docId: supplierId, text: listingTextOf(r), sourceUrl: r.url }, { model: g });
  // Recorded mode makes no model call, so a recorded reading carries no call-log ids.
  const file = { label: "recorded sample", ...JSON.parse(JSON.stringify(reading)), llmCallIds: [] } as Record<string, unknown>;
  return { r, supplierId, file, gates: recorded.gates };
}

const readFile = (supplierId: string): unknown => JSON.parse(readFileSync(join(READER_DIR, `${supplierId}.json`), "utf8"));

describe("recorded Reader outputs (data/suppliers/search/reader)", () => {
  it.each(allowed)("recorded result %i: the file equals the Reader's own output for its listing text", async (i) => {
    const { supplierId, file } = await readingFor(i);
    if (WRITE) writeFileSync(join(READER_DIR, `${supplierId}.json`), `${JSON.stringify(file, null, 2)}\n`);
    expect(readFile(supplierId)).toEqual(file);
  });

  it.each(allowed)("recorded result %i: strict ListingReading schema, ids and taint labels", async (i) => {
    const { r, supplierId, gates } = await readingFor(i);
    const reading = RecordedReading.parse(readFile(supplierId));
    expect(reading.docId).toBe(supplierId);
    const source = `reader:listing:${supplierId}`;
    for (const f of Object.values(reading.fields)) if (f !== null) expect(f.source).toBe(source);
    for (const f of [reading.fields.unitPrice, reading.fields.moq, reading.fields.leadTimeDays]) {
      expect(f).not.toBeNull();
      expect(f?.value.sourceUrl).toBe(r.url);
    }
    expect(reading.supplierGates).toEqual([...gates].sort());
    expect(reading.redFlags.every((x) => x.source === `listing:${supplierId}`)).toBe(true);
    // Every recorded seller name has a company designator (the payout holder check in §9 needs one to match).
    expect(reading.fields.sellerName?.value).toMatch(/Co\., Ltd\.$/);
  });

  it("has exactly one file per allow-listed recorded result and a model output for each", () => {
    const ids = allowed.map((i) => webSupplierId(resultAt(i).url)).sort();
    expect(new Set(ids).size).toBe(ids.length);
    expect(readdirSync(READER_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort()).toEqual(ids);
    expect(Object.keys(MODEL_OUTPUTS).sort()).toEqual(allowed.map((i) => resultAt(i).url).sort());
  });

  it("covers the scenarios VISION-DECISIONS §8 asks for", async () => {
    const all = await Promise.all(allowed.map(readingFor));
    const gated = (g: Gate) => all.filter((x) => x.gates.includes(g)).length;
    expect(recordedJson.results).toHaveLength(10);
    expect(recordedJson.results.length - allowed.length).toBe(1); // one off-list domain
    expect(all.filter((x) => x.gates.length === 0)).toHaveLength(6); // 5 clean + the price bait
    expect(gated("AI_INJECTION")).toBe(2); // an instruction to the AI, and a request for ID and phone (T33)
    expect(gated("OFF_PLATFORM_DISCOUNT")).toBe(1); // pay a personal account
    const usd = all.flatMap((x) => (x.file.fields as { unitPrice: { value: { currency: string; amountMinor: string } } }).unitPrice.value).filter((p) => p.currency === "USD").map((p) => Number(p.amountMinor));
    const sorted = [...usd].sort((a, b) => a - b);
    const median = ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) + (sorted[Math.ceil((sorted.length - 1) / 2)] ?? 0)) / 2;
    expect(usd.filter((p) => p < 0.3 * median)).toHaveLength(1); // the price bait, under 30 % of the median
  });
});
