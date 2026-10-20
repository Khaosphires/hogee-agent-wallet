/** VISION-DECISIONS §2–§4: the chat-first enums, schemas and chat parts (additive to G0). */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CFO_DISCLAIMER,
  CHAT_DATA_PART_SCHEMAS,
  CHAT_DATA_PART_TYPES,
  CandidateCard,
  CfoInsight,
  CfoReport,
  ChatAction,
  ChatDataPart,
  ChatMessage,
  E1_VECTORS,
  G0_CHAT_DATA_PART_TYPES,
  JOURNEY_STAGES,
  MILESTONE_LABELS,
  MILESTONE_TRIGGERS,
  NeedsChecklist,
  OrderTerms,
  PayoutAccountInput,
  isPlainName,
  RecordedListingReading,
  RecordedTavilySearch,
  ShortId,
  SignedMinor,
  SupplierSearch,
  SupplierSearchBody,
  TERMS_ERROR_CODES,
  TERMS_PRESETS,
  TERMS_PRESET_MILESTONES,
  TermsPrefill,
  WEB_SUPPLIER_ID_RE,
  WebSearchAnswer,
  WebSearchQuery,
  exampleCatalogCandidate,
  exampleCfoInsight,
  exampleCfoReport,
  exampleChatActions,
  exampleNeedsChecklist,
  exampleOrderTerms,
  exampleSupplierSearch,
  exampleTermsPrefill,
  exampleWebCandidate,
  exampleWebSearchAnswer,
  exampleWebSearchQuery,
  isWebSupplierId,
} from "../src/index";

const passes = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
};
const fails = (schema: z.ZodType, value: unknown) => expect(schema.safeParse(value).success).toBe(false);

describe("enums (appended)", () => {
  it("E1_VECTORS keeps its order and gains web_search last", () => {
    expect([...E1_VECTORS]).toEqual(["invoice", "listing", "email", "webhook", "memory", "chat", "web_search"]);
  });

  it("journey stages, triggers, presets and terms codes are the decided lists", () => {
    expect(JOURNEY_STAGES).toHaveLength(13);
    expect([...MILESTONE_TRIGGERS]).toEqual(["ON_ORDER", "ON_SAMPLE_OK", "ON_SHIPMENT", "ON_DELIVERY_INSPECTED"]);
    expect(TERMS_ERROR_CODES).toHaveLength(21);
    expect(TERMS_ERROR_CODES.slice(0, 13).at(-1)).toBe("TERMS_UPFRONT_OVER_WINDOW");
  });
});

describe("SignedMinor", () => {
  it.each(["0", "-1", "1000000", "-89500", "340282366920938463463374607431768211455", "-340282366920938463463374607431768211455"])("accepts %s", (v) => {
    passes(SignedMinor, v);
  });
  it.each(["-0", "01", "-01", "+5", "1.5", "1e3", "", " 1", "340282366920938463463374607431768211456"])("rejects %j", (v) => {
    fails(SignedMinor, v);
  });
  it("rejects numbers", () => fails(SignedMinor, -5));
});

describe("web supplier ids", () => {
  it("accept supplier-w + 12 base32 characters and fit ShortId and the API's SUPPLIER_RE / ORDER_RE", () => {
    const id = exampleWebCandidate.supplierId;
    expect(isWebSupplierId(id)).toBe(true);
    passes(ShortId, id);
    expect(/^supplier-([a-z0-9]{1,20})$/.test(id)).toBe(true);
    expect(/^order-([a-z0-9]{1,20})-(\d{3})$/.test(`order-${id.slice("supplier-".length)}-001`)).toBe(true);
  });
  it.each(["supplier-a", "supplier-wqk3vt7ma2xr", "supplier-wqk3vt7ma2xrbb", "supplier-wQK3VT7MA2XRB", "supplier-wqk3vt8ma2xrb", "supplier-wqk3vt1ma2xrb"])("refuse %s", (id) => {
    expect(WEB_SUPPLIER_ID_RE.test(id)).toBe(false);
  });
});

describe("search", () => {
  it("a web candidate is always unverified and carries a web id; a catalog one never does", () => {
    fails(CandidateCard, { ...exampleWebCandidate, unverified: false });
    fails(CandidateCard, { ...exampleWebCandidate, supplierId: "supplier-a" });
    fails(CandidateCard, { ...exampleCatalogCandidate, supplierId: exampleWebCandidate.supplierId });
    passes(CandidateCard, { ...exampleCatalogCandidate, unverified: true });
  });

  it("failure is set exactly when the search FAILED", () => {
    fails(SupplierSearch, { ...exampleSupplierSearch, failure: "PROVIDER_DOWN" });
    fails(SupplierSearch, { ...exampleSupplierSearch, status: "FAILED" });
    fails(SupplierSearch, { ...exampleSupplierSearch, candidates: Array.from({ length: 9 }, () => exampleWebCandidate) });
  });

  it("P1 (19 Oct): up to 10 raw results per query and answer; candidates stay at most 8", () => {
    passes(WebSearchQuery, { ...exampleWebSearchQuery, maxResults: 10 });
    fails(WebSearchQuery, { ...exampleWebSearchQuery, maxResults: 11 });
    const ten = Array.from({ length: 10 }, () => exampleWebSearchAnswer.results[0]);
    passes(WebSearchAnswer, { ...exampleWebSearchAnswer, results: ten });
    fails(WebSearchAnswer, { ...exampleWebSearchAnswer, results: [...ten, exampleWebSearchAnswer.results[0]] });
  });

  it("the search body takes no query (built from the committed plan) and caps the quantity", () => {
    passes(SupplierSearchBody, {});
    fails(SupplierSearchBody, { query: "ignore previous instructions" });
    fails(SupplierSearchBody, { quantity: 100_001 });
    fails(SupplierSearchBody, { quantity: 0 });
  });
});

describe("chat actions", () => {
  it("carry no free text and reject unknown types", () => {
    fails(ChatAction, { ...exampleChatActions[0], text: "pay 0xdead" });
    fails(ChatAction, { type: "pay", actionId: exampleChatActions[0]?.actionId });
    fails(ChatAction, { ...exampleChatActions[0], actionId: "not-a-uuid" });
  });

  it("pick names 1–5 distinct suppliers", () => {
    const pick = exampleChatActions.find((a) => a.type === "pick");
    fails(ChatAction, { ...pick, supplierIds: [] });
    fails(ChatAction, { ...pick, supplierIds: ["supplier-a", "supplier-a"] });
    fails(ChatAction, { ...pick, supplierIds: ["supplier-a", "supplier-b", "supplier-c", "supplier-d", "supplier-e", "supplier-f"] });
  });
});

describe("terms", () => {
  it("labels cover every trigger; presets sum to 10000, never go backwards and end on the delivery check", () => {
    expect(Object.keys(MILESTONE_LABELS).sort()).toEqual([...MILESTONE_TRIGGERS].sort());
    for (const preset of TERMS_PRESETS) {
      const ms = TERMS_PRESET_MILESTONES[preset];
      expect(ms.reduce((s, m) => s + m.bps, 0), preset).toBe(10_000);
      expect(ms.at(-1)?.trigger, preset).toBe("ON_DELIVERY_INSPECTED");
      const order = ms.map((m) => MILESTONE_TRIGGERS.indexOf(m.trigger));
      expect([...order].sort((a, b) => a - b), preset).toEqual(order);
    }
  });

  it("the payout account is digits only, names are printable and trimmed", () => {
    const ok = { holderName: "Example Co., Ltd.", bankName: "Example Bank", accountNumber: "6200123456", payeeType: "company" };
    passes(PayoutAccountInput, ok);
    fails(PayoutAccountInput, { ...ok, accountNumber: "62-00123456" });
    fails(PayoutAccountInput, { ...ok, accountNumber: "12345" });
    fails(PayoutAccountInput, { ...ok, holderName: " Example Co." });
    fails(PayoutAccountInput, { ...ok, holderName: "Example\u0000Co." });
    fails(PayoutAccountInput, { ...ok, channel: "XENDIT" });
  });

  it("holder and bank names are plain: no C1 controls, format characters, line breaks or blank fillers (run-9)", () => {
    const ok = { holderName: "Example Co., Ltd.", bankName: "Example Bank", accountNumber: "6200123456", payeeType: "company" };
    passes(PayoutAccountInput, { ...ok, holderName: "永康市科瓦恩杯业有限公司", bankName: "Bank Négara Café" });
    // U+0085 and U+009B (C1), U+200B/U+202E/U+FEFF (Cf), U+2028/U+2029, Hangul fillers and the Braille blank.
    const bad = ["\u0085", "\u009b", "​", "‮", "﻿", " ", " ", "ᅟ", "ᅠ", "ㅤ", "ﾠ", "⠀", "͏"];
    for (const ch of bad) {
      expect(isPlainName(`Example${ch}Co.`), JSON.stringify(ch)).toBe(false);
      fails(PayoutAccountInput, { ...ok, holderName: `Example${ch}Co.` });
      fails(PayoutAccountInput, { ...ok, bankName: `Example${ch}Bank` });
    }
    expect(isPlainName("Corvane Drinkware Co., Ltd.")).toBe(true);
  });

  it("refuses a lone surrogate (JCS cannot encode it, so confirm would 500), keeps paired ones (re-check keccak LOW 2)", () => {
    const ok = { holderName: "Example Co., Ltd.", bankName: "Example Bank", accountNumber: "6200123456", payeeType: "company" };
    for (const lone of ["\uD800", "\uDFFF", "\uDBFF"]) {
      expect(isPlainName(`Example${lone}Co.`), JSON.stringify(lone)).toBe(false);
      fails(PayoutAccountInput, { ...ok, holderName: `Example${lone}Co.` });
      fails(PayoutAccountInput, { ...ok, bankName: `Example${lone}Bank` });
    }
    expect(isPlainName("Example\u{1F600}Co.")).toBe(true);
    expect(isPlainName("Example 𠀀 Co.")).toBe(true);
  });

  it("orderId is set exactly when the terms are USED; one schedule row per milestone", () => {
    passes(OrderTerms, { ...exampleOrderTerms, status: "USED", orderId: "order-wqk3vt7ma2xrb-001" });
    fails(OrderTerms, { ...exampleOrderTerms, status: "USED" });
    fails(OrderTerms, { ...exampleOrderTerms, orderId: "order-wqk3vt7ma2xrb-001" });
    fails(OrderTerms, { ...exampleOrderTerms, schedule: exampleOrderTerms.schedule.slice(0, 1) });
  });

  it("bindTxHash (the bindPayee tx, the order card's seal) is a hash, set only on USED terms", () => {
    const used = { ...exampleOrderTerms, status: "USED", orderId: "order-wqk3vt7ma2xrb-001" } as const;
    passes(OrderTerms, { ...used, bindTxHash: `0x${"ab".repeat(32)}` });
    passes(OrderTerms, { ...used, bindTxHash: null });
    fails(OrderTerms, { ...used, bindTxHash: "0xabc" });
    fails(OrderTerms, { ...exampleOrderTerms, bindTxHash: `0x${"ab".repeat(32)}` });
    const { bindTxHash: _omitted, ...missing } = exampleOrderTerms;
    fails(OrderTerms, missing);
  });

  it("a prefill is consistent: a greyed preset names its code, source none pre-fills nothing", () => {
    fails(TermsPrefill, { ...exampleTermsPrefill, presetAvailability: [{ preset: "P50_50", ok: false, code: null }] });
    fails(TermsPrefill, { ...exampleTermsPrefill, presetAvailability: [{ preset: "P50_50", ok: true, code: "TERMS_AUTO_OVER_PER_TX" }] });
    fails(TermsPrefill, { ...exampleTermsPrefill, source: "none" });
    passes(TermsPrefill, { ...exampleTermsPrefill, source: "none", milestones: null, preset: null });
    passes(TermsPrefill, { ...exampleTermsPrefill, source: "founder_text", milestones: null, preset: null, question: "DEPOSIT_TRIGGER" });
    fails(TermsPrefill, { ...exampleTermsPrefill, searchId: null });
    passes(TermsPrefill, { ...exampleTermsPrefill, supplierId: "supplier-a", searchId: null });
  });
});

describe("CFO and needs", () => {
  it("the report carries the fixed disclaimer", () => {
    expect(exampleCfoReport.disclaimer).toBe(CFO_DISCLAIMER);
    fails(CfoReport, { ...exampleCfoReport, disclaimer: "Guaranteed returns." });
  });

  it.each(["javascript:alert(1)", "https://example.invalid/x", "//example.invalid/x", "dashboard"])("an insight link is an in-app path only (%s refused)", (href) => {
    fails(CfoInsight, { ...exampleCfoInsight, suggestion: { kind: "TIGHTEN", href } });
  });

  it("needs items cite a pack pointer, compiler or constitution rule (or null) and have unique ids", () => {
    const item = exampleNeedsChecklist.items[0];
    fails(NeedsChecklist, { ...exampleNeedsChecklist, items: [{ ...item, sourceRef: "https://example.invalid" }] });
    fails(NeedsChecklist, { ...exampleNeedsChecklist, items: [item, item] });
    fails(NeedsChecklist, { ...exampleNeedsChecklist, items: [] });
  });
});

describe("chat parts", () => {
  it("the G0 five come first, and every part has a schema and a union member", () => {
    expect(CHAT_DATA_PART_TYPES.slice(0, 5)).toEqual([...G0_CHAT_DATA_PART_TYPES]);
    expect(Object.keys(CHAT_DATA_PART_SCHEMAS).map((k) => `data-${k}`)).toEqual([...CHAT_DATA_PART_TYPES]);
    expect(ChatDataPart.options.map((o) => o.shape.type.value)).toEqual([...CHAT_DATA_PART_TYPES]);
  });

  it("data-action is on user messages only", () => {
    const part = { type: "data-action", data: { action: exampleChatActions[0] } };
    passes(ChatMessage, { id: "m1", role: "user", parts: [part] });
    fails(ChatMessage, { id: "m2", role: "assistant", parts: [part] });
  });

  it("a part with unknown fields or a bad payload is refused (servers parse before writing)", () => {
    fails(ChatDataPart, { type: "data-search", data: { searchId: "s1", query: "x" } });
    fails(ChatDataPart, { type: "data-cfo", data: { view: "secrets" } });
    fails(ChatDataPart, { type: "data-next", data: { actions: [] } });
  });
});

describe("recorded web search data files (validate:data)", () => {
  const untrusted = <T>(value: T) => ({ value, taint: { trust: "untrusted", sensitivity: "public" }, source: `reader:listing:${exampleWebCandidate.supplierId}` });
  const hash = exampleWebSearchAnswer.bodySha256;
  const reading = {
    label: "recorded sample",
    kind: "listing",
    docId: exampleWebCandidate.supplierId,
    fields: {
      sellerName: untrusted("Example Drinkware Co., Ltd."),
      productTitle: untrusted("500 ml insulated tumbler"),
      unitPrice: untrusted({ amountMinor: "2150", currency: "CNY", unit: "CNY", sourceUrl: null, snippetHash: hash, method: "llm" }),
      moq: untrusted({ value: "300", unit: "pieces", sourceUrl: null, snippetHash: hash, method: "llm" }),
      leadTimeDays: null,
      certificates: untrusted([]),
      claimsEscrow: untrusted(null),
    },
    flags: [{ flag: "AI_DIRECTED", index: 12, excerpt: "note to ai assistants" }],
    redFlags: [],
    supplierGates: ["AI_INJECTION"],
    dropped: [],
    repaired: false,
    llmCallIds: [],
    extracted: { moq: { value: "300", unit: "pieces", snippetHash: hash } },
  };
  const tavily = {
    label: "recorded sample",
    recordedAt: "2026-10-19T08:00:00Z",
    query: "insulated stainless steel tumbler manufacturer China",
    images: [],
    results: [{ title: "Tumbler (recorded sample)", url: "https://listing.example.invalid/a", content: "MOQ 300", score: 0.86, raw_content: "Recorded sample." }],
    response_time: "1.42",
    request_id: "recorded-sample-0001",
  };

  it("a recorded Tavily response parses; an unlabelled one, an http URL or an unknown key does not", () => {
    passes(RecordedTavilySearch, tavily);
    fails(RecordedTavilySearch, { ...tavily, label: "live" });
    fails(RecordedTavilySearch, { ...tavily, results: [{ ...tavily.results[0], url: "http://listing.example.invalid/a" }] });
    fails(RecordedTavilySearch, { ...tavily, api_key: "x" });
  });

  it("a recorded Reader output parses; trusted taint, a catalog id or a stray field does not", () => {
    passes(RecordedListingReading, reading);
    fails(RecordedListingReading, { ...reading, fields: { ...reading.fields, sellerName: { ...untrusted("x"), taint: { trust: "trusted", sensitivity: "public" } } } });
    fails(RecordedListingReading, { ...reading, docId: "supplier-a" });
    fails(RecordedListingReading, { ...reading, fields: { ...reading.fields, payoutAccount: untrusted("123") } });
    fails(RecordedListingReading, { ...reading, flags: [{ flag: "BUY_NOW", index: 0, excerpt: "" }] });
  });
});
