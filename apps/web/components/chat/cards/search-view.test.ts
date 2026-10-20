import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEARCH_FAILURES, SEARCH_OMIT_REASONS, SUPPLIER_GATES, type SupplierSearch } from "@hogee/core";
import {
  enquiryRecipients,
  excludedLines,
  leftOutCount,
  shownCandidateIds,
  showUnverified,
  failureCopy,
  finishedSummary,
  listingHref,
  omittedLine,
  perUnitBu,
  pickLabel,
  searchSteps,
  togglePick,
  wholeBu,
} from "./search-view";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const { checkText } = (await import(join(ROOT, "scripts/lint-wording/index.mjs"))) as { checkText: (text: string) => readonly unknown[] };

const base: SupplierSearch = {
  searchId: "sl-web-1",
  status: "PENDING",
  stage: "SEARCHING",
  provider: "recorded",
  sourcesFound: 0,
  omitted: [],
  excludedByGate: [],
  failure: null,
  shortlistRequestId: null,
  candidates: [],
  quantity: 1000,
  createdAt: "2026-10-19T09:00:00.000Z",
};

describe("searchSteps", () => {
  it("marks the steps before the stage done and the stage current; READY is all done", () => {
    expect(searchSteps({ ...base, stage: "READING", sourcesFound: 10 }).map((s) => [s.label, s.state])).toEqual([
      ["Searching the web", "done"],
      ["Reading pages (10)", "current"],
      ["Checking for problems", "todo"],
      ["Ranking the best", "todo"],
    ]);
    expect(searchSteps({ ...base, status: "READY", stage: "DONE" }).every((s) => s.state === "done")).toBe(true);
    expect(searchSteps({ ...base, status: "FAILED", stage: "SEARCHING" })[0]?.state).toBe("todo");
  });
});

describe("copy", () => {
  it("summarises a finished search and the pages left out, gate by gate, attack first", () => {
    const ready: SupplierSearch = {
      ...base,
      status: "READY",
      stage: "DONE",
      sourcesFound: 10,
      omitted: [{ reason: "OFF_LIST", count: 1 }],
      excludedByGate: [
        { gate: "MISSING_CERT", count: 1 },
        { gate: "AI_INJECTION", count: 2 },
      ],
    };
    expect(finishedSummary(ready)).toEqual(["Search finished", "10 pages found", "0 kept", "4 left out"]);
    expect(excludedLines(ready.excludedByGate)).toEqual(["2 pages left out: they contained instructions aimed at the AI.", "1 page left out: it showed no safety test report for this product."]);
    expect(excludedLines([{ gate: "AI_INJECTION", count: 1 }])).toEqual(["1 page left out: it contained instructions aimed at the AI."]);
    expect(omittedLine(ready.omitted)).toBe("Also skipped: 1 not on the listing sites Hogee reads.");
    expect(omittedLine([])).toBeNull();
  });

  it("every founder-visible string passes the wording lint", () => {
    const texts = [
      ...SEARCH_FAILURES.flatMap((f) => Object.values(failureCopy(f))),
      ...Object.values(failureCopy(null)),
      ...excludedLines(SUPPLIER_GATES.map((gate) => ({ gate, count: 1 }))),
      ...excludedLines(SUPPLIER_GATES.map((gate) => ({ gate, count: 2 }))),
      omittedLine(SEARCH_OMIT_REASONS.map((reason) => ({ reason, count: 1 }))) ?? "",
      ...searchSteps({ ...base, stage: "READING", sourcesFound: 3 }).map((s) => s.label),
    ];
    for (const t of texts) expect(checkText(t), t).toEqual([]);
    for (const f of SEARCH_FAILURES) expect(failureCopy(f).body).toMatch(/Nothing was paid or changed/);
  });
});

describe("listingHref", () => {
  it("links only a server-checked https URL on the card's own host", () => {
    expect(listingHref({ listingUrl: "https://www.alibaba.com/product-detail/x.html", listingHost: "www.alibaba.com" })).toBe("https://www.alibaba.com/product-detail/x.html");
    expect(listingHref({ listingUrl: "https://www.alibaba.com/x", listingHost: "detail.1688.com" })).toBeNull();
    expect(listingHref({ listingUrl: "http://www.alibaba.com/x", listingHost: "www.alibaba.com" })).toBeNull();
    expect(listingHref({ listingUrl: "javascript:alert(1)", listingHost: "www.alibaba.com" })).toBeNull();
    expect(listingHref({ listingUrl: "https://u:p@www.alibaba.com/x", listingHost: "www.alibaba.com" })).toBeNull();
    expect(listingHref({ listingUrl: null, listingHost: null })).toBeNull();
    expect(listingHref({ listingUrl: "https://evil.example/x", listingHost: "evil.example" })).toBeNull();
  });

  it("links origin + path only: no query string or fragment reaches the listing host", () => {
    expect(listingHref({ listingUrl: "https://www.alibaba.com/product-detail/x.html?utm_source=hogee&redirect=https%3A%2F%2Fevil.example#pay", listingHost: "www.alibaba.com" })).toBe(
      "https://www.alibaba.com/product-detail/x.html",
    );
    expect(listingHref({ listingUrl: "https://www.alibaba.com/?q=1", listingHost: "www.alibaba.com" })).toBe("https://www.alibaba.com/");
  });
});

describe("figures and picks", () => {
  it("shows whole BU and an approximate unit cost", () => {
    expect(wholeBu("395249")).toBe("3,952 BU");
    expect(wholeBu("395250")).toBe("3,953 BU");
    expect(perUnitBu("395249", 1000)).toBe("about 4 BU each");
    expect(perUnitBu("4000", 1000)).toBe("under 1 BU each");
    expect(perUnitBu(null, 1000)).toBeNull();
  });

  it("toggles picks in rank order, at most 5", () => {
    const ranked = ["a", "b", "c", "d", "e", "f"];
    expect(togglePick(["c"], "a", ranked)).toEqual(["a", "c"]);
    expect(togglePick(["a", "c"], "a", ranked)).toEqual(["c"]);
    expect(togglePick(["a", "b", "c", "d", "e"], "f", ranked)).toEqual(["a", "b", "c", "d", "e"]);
    expect(pickLabel({ rank: 2, displayName: "Zhejiang Tidelume Cup Industry Co., Ltd." })).toBe("Pick #2 Zhejiang Tidelume Cup Industry Co., Ltd.");
  });
});

describe("the supplier list folds, it never drops (D27, G12)", () => {
  const ranked = ["a", "b", "c", "d", "e"];
  it("shows the first three, every picked one, or all once expanded", () => {
    expect([...shownCandidateIds(ranked, [], false)]).toEqual(["a", "b", "c"]);
    expect([...shownCandidateIds(ranked, ["e"], false)].sort()).toEqual(["a", "b", "c", "e"]);
    expect([...shownCandidateIds(ranked, [], true)]).toEqual(ranked);
  });

  it("keeps the Unverified pill on every web supplier, even if the flag were missing", () => {
    expect(showUnverified({ unverified: true, origin: "web" })).toBe(true);
    expect(showUnverified({ unverified: false, origin: "web" })).toBe(true);
    expect(showUnverified({ unverified: false, origin: "catalog" })).toBe(false);
  });

  it("counts every page left out for the fold's title", () => {
    expect(leftOutCount({ omitted: [{ reason: "OFF_LIST", count: 1 }], excludedByGate: [{ gate: "AI_INJECTION", count: 2 }] })).toBe(3);
  });
});

describe("enquiryRecipients: names and pages from the search data only (G3)", () => {
  const cand = (id: string, rank: number, url: string | null) => ({
    supplierId: id,
    origin: "web" as const,
    displayName: `Seller ${rank} Co., Ltd.`,
    rank,
    landedCostMinor: null,
    moq: null,
    leadTimeDays: null,
    evidenceCoverageBps: 0,
    failedGates: [],
    redFlagCount: 0,
    listingHost: "www.alibaba.com",
    listingUrl: url,
    unverified: true,
    canOrder: true,
    priceFlag: false,
  });
  const search = { candidates: [cand("supplier-w1", 1, "https://www.alibaba.com/p/1.html?ref=x"), cand("supplier-w2", 2, "http://www.alibaba.com/p/2.html")] };

  it("names each picked supplier with its place, a safe page link and the Unverified mark", () => {
    expect(enquiryRecipients(["supplier-w2", "supplier-w1"], search)).toEqual([
      { supplierId: "supplier-w2", rank: 2, name: "Seller 2 Co., Ltd.", href: null, host: "www.alibaba.com", unverified: true },
      { supplierId: "supplier-w1", rank: 1, name: "Seller 1 Co., Ltd.", href: "https://www.alibaba.com/p/1.html", host: "www.alibaba.com", unverified: true },
    ]);
  });

  it("leaves out an id the search doesn't know, and shows nothing before the search loads", () => {
    expect(enquiryRecipients(["supplier-w9"], search)).toEqual([]);
    expect(enquiryRecipients(["supplier-w1"], undefined)).toEqual([]);
  });
});
