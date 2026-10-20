/**
 * journeyFactsOf and the candidate-list helpers (shared by live and mock): a pick counts only for the live READY web
 * list and only its candidates; an open terms form only for a candidate; "#2" resolves only to a ranked candidate.
 */
import { describe, expect, it } from "vitest";
import { allCandidates, estimateTotalMinor, journeyFactsOf, listOfSearch, readHistory, resolveCandidate, resolveRanks, type CandidateList, type SourceFacts } from "../src/journey/index";
import { exampleFailedSupplierSearch, exampleSupplierSearch, exampleWebCandidate } from "../src/schemas/example-data/journey";

const W1 = exampleWebCandidate.supplierId;
const W2 = "supplier-wabcdefgh2345";
const list: CandidateList = {
  searchId: "search-1",
  origin: "web",
  status: "READY",
  candidates: [
    { supplierId: W1, rank: 1, landedCostMinor: "412000" },
    { supplierId: W2, rank: 2, landedCostMinor: null },
  ],
  quantity: 500,
};
const src: SourceFacts = {
  facilityId: "fac-mei",
  persona: "founder:mei",
  now: "2026-10-20T08:00:00Z",
  draftId: "draft-1",
  planStatus: "COMMITTED",
  founderKeyActive: true,
  list,
  terms: null,
  order: null,
  paused: false,
};
const a = (n: number) => `01a14202-2800-7000-8000-${String(n).padStart(12, "0")}`;
const pick = (searchId: string, supplierIds: string[]) => ({ role: "user", parts: [{ type: "data-action", data: { action: { type: "pick", actionId: a(supplierIds.length), searchId, supplierIds } } }] });
const prefill = (supplierId: string) => ({ role: "assistant", parts: [{ type: "data-terms", data: { supplierId, searchId: "search-1", milestones: null, preset: null, source: "none", question: null, presetAvailability: [] } }] });

describe("journeyFactsOf", () => {
  it("keeps the picks of the live list, with their ranks", () => {
    const f = journeyFactsOf(src, readHistory([pick("search-1", [W2, W1])]));
    expect(f.pickedSupplierIds).toEqual([W2, W1]);
    expect(f.pickedRanks).toEqual([2, 1]);
    expect(f.search).toEqual({ searchId: "search-1", status: "READY", origin: "web" });
  });

  it("drops a pick of another search or of a non-candidate", () => {
    expect(journeyFactsOf(src, readHistory([pick("search-0", [W1])])).pickedSupplierIds).toEqual([]);
    expect(journeyFactsOf(src, readHistory([pick("search-1", ["supplier-wzzzzzzzzzzzz"])])).pickedSupplierIds).toEqual([]);
    expect(journeyFactsOf({ ...src, list: { ...list, status: "PENDING" } }, readHistory([pick("search-1", [W1])])).pickedSupplierIds).toEqual([]);
  });

  it("carries the store's pause (rcfix-journey A-7)", () => {
    expect(journeyFactsOf({ ...src, paused: true }, readHistory([])).paused).toBe(true);
    expect(journeyFactsOf(src, readHistory([])).paused).toBe(false);
  });

  it("an open terms form counts only for a candidate of the list", () => {
    expect(journeyFactsOf(src, readHistory([prefill(W1)])).termsDraft).toEqual({ supplierId: W1 });
    expect(journeyFactsOf(src, readHistory([prefill("supplier-wzzzzzzzzzzzz")])).termsDraft).toBeNull();
  });
});

describe("candidate lists", () => {
  it("reads a READY search's ranked candidates and nothing from a FAILED one", () => {
    expect(listOfSearch(exampleSupplierSearch).candidates).toEqual([{ supplierId: W1, rank: 1, landedCostMinor: "412000" }]);
    expect(listOfSearch(exampleFailedSupplierSearch)).toMatchObject({ status: "FAILED", candidates: [] });
  });

  it("resolves ranks and named suppliers only within the READY web list", () => {
    expect(resolveRanks(list, [2, 1])).toEqual({ ok: true, value: { supplierIds: [W2, W1], ranks: [2, 1] } });
    expect(resolveRanks(list, [3])).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(resolveRanks({ ...list, origin: "catalog" }, [1])).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(resolveCandidate(list, "search-1", { rank: 2 })).toMatchObject({ ok: true, value: { supplierId: W2 } });
    expect(resolveCandidate(list, "search-0", { supplierId: W1 })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(allCandidates(list, "search-1", [W1, W2])).toBe(true);
    expect(allCandidates(list, "search-1", [W1, "supplier-wzzzzzzzzzzzz"])).toBe(false);
    expect(allCandidates(null, "search-1", [W1])).toBe(false);
  });

  it("estimates the preset total from the listed price, capped by the free pocket, in whole BU", () => {
    expect(estimateTotalMinor({ supplierId: W1, rank: 1, landedCostMinor: "412050" }, 500_000n)).toBe(412_000n);
    expect(estimateTotalMinor({ supplierId: W1, rank: 1, landedCostMinor: "612000" }, 500_000n)).toBe(500_000n);
    expect(estimateTotalMinor({ supplierId: W1, rank: 1, landedCostMinor: null }, 400_050n)).toBe(400_000n);
  });
});
