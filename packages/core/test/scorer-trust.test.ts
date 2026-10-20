/**
 * Trust & verification (security audit run-2, fix 2). Registry ids are loose strings until packages/checks validates
 * them, so an id earns points only when a validator result bound to that supplier marks that exact id valid.
 * Platform metrics (rating, years on platform) count as tier-2 (project.md §12 Sourced) and stay as they were: on
 * their own they top out at 6,000 bps, below tier-2 evidence (7,500).
 * Skills re-check of run-5: the validators are offline format/checksum checks, so a fake supplier can copy a real
 * factory's public USCC. Registry points plus metrics are therefore capped at LISTING_TRUST_MAX_BPS (7,000), strictly
 * below tier-2 evidence, until registry points come from a lookup matched to the supplier's legal name.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LISTING_TRUST_MAX_BPS, METRICS_TRUST_MAX_BPS, TIER_SCORE_BPS, buildShortlist, scoreCriteria, type RegistryIdChecks, type ScorerCandidate } from "../src/index";
import { SPEC, candidate, ev, supplier } from "./fixtures/suppliers";

const trustOf = (c: ScorerCandidate): number => scoreCriteria(c, SPEC.productCategory, 1n).find((r) => r.criterion === "trust_verification")?.scoreBps ?? -1;
const METRICS = { rating: 4.5, responseRate: 0.9, yearsOnPlatform: 3 };
const USCC = "91330200MA2EXAMPL1";
const LEI = "5493001KJTIIGC8Y1R12";
/** Synthetic UEN shape (business registration: 8 digits + check letter); validation itself is stubbed here. */
const UEN = "53012345D";

const withChecks = (c: ScorerCandidate, registryChecks: RegistryIdChecks): ScorerCandidate => ({ ...c, registryChecks });

/** Y: fake ids, no evidence, good metrics. X: no ids, one tier-2 trust item, the same metrics. */
const Y = candidate(supplier("supplier-y", { ids: { uscc: "NOT-A-USCC", lei: "x" }, metrics: METRICS }));
const X = candidate(supplier("supplier-x", { ids: {}, metrics: METRICS }), [ev("supplier-x", "trust_verification", "tier2", "Shopee verified seller since 2023")]);

describe("trust_verification: unvalidated registry ids earn nothing", () => {
  it("regression: Y (fake ids, no evidence) scores below X (tier-2 evidence), on the criterion and on the card", () => {
    expect(trustOf(Y)).toBe(4_200); // metrics only: 3 years × 800 + 4.5 × 400
    expect(trustOf(X)).toBe(7_500);
    const sl = buildShortlist({ requestId: "sl-trust-1", spec: SPEC, candidates: [X, Y], seed: 7 });
    const trust = (id: string) => sl.candidates.find((c) => c.supplierId === id)?.criteria.find((k) => k.criterion === "trust_verification")?.score;
    expect(trust("supplier-y")).toBe(42);
    expect(trust("supplier-x")).toBe(75);
  });

  it("a validator result bound to the supplier and to that exact id earns the registry points", () => {
    const s = candidate(supplier("supplier-v", { ids: { uscc: USCC, lei: LEI }, metrics: METRICS }));
    expect(trustOf(s)).toBe(4_200);
    // 4,200 + 3,000 (registration) and + 1,000 (LEI), each capped at LISTING_TRUST_MAX_BPS: below tier-2 evidence.
    expect(trustOf(withChecks(s, { uscc: { supplierId: "supplier-v", id: USCC, valid: true } }))).toBe(LISTING_TRUST_MAX_BPS);
    expect(trustOf(withChecks(s, { uscc: { supplierId: "supplier-v", id: USCC, valid: true }, lei: { supplierId: "supplier-v", id: LEI, valid: true } }))).toBe(LISTING_TRUST_MAX_BPS);
    const fewer = candidate(supplier("supplier-v", { ids: { uscc: USCC }, metrics: { rating: 2, responseRate: 0.9, yearsOnPlatform: 1 } }));
    expect(trustOf(withChecks(fewer, { uscc: { supplierId: "supplier-v", id: USCC, valid: true } }))).toBe(1_600 + 3_000); // under the cap: full points
  });

  it("a validated Singapore UEN is a business registration: the same points as a USCC, and only when bound and valid", () => {
    const s = candidate(supplier("supplier-u", { ids: { uen: UEN }, metrics: METRICS }));
    expect(trustOf(s)).toBe(4_200);
    expect(trustOf(withChecks(s, { uen: { supplierId: "supplier-u", id: UEN, valid: true } }))).toBe(LISTING_TRUST_MAX_BPS);
    expect(trustOf(withChecks(s, { uen: { supplierId: "supplier-u", id: UEN, valid: false } }))).toBe(4_200);
    expect(trustOf(withChecks(s, { uen: { supplierId: "supplier-u", id: "201912345K", valid: true } }))).toBe(4_200);
    expect(trustOf(withChecks(s, { uscc: { supplierId: "supplier-u", id: UEN, valid: true } }))).toBe(4_200);
  });

  it.each<[string, RegistryIdChecks]>([
    ["marked invalid", { uscc: { supplierId: "supplier-v", id: USCC, valid: false } }],
    ["for another id string", { uscc: { supplierId: "supplier-v", id: "91330200MA2OTHER01", valid: true } }],
    ["for another supplier", { uscc: { supplierId: "supplier-a", id: USCC, valid: true } }],
    ["for an id kind the supplier does not have", { ssm: { supplierId: "supplier-v", id: USCC, valid: true } }],
  ])("a validator result %s earns nothing", (_name, checks) => {
    const s = candidate(supplier("supplier-v", { ids: { uscc: USCC }, metrics: METRICS }));
    expect(trustOf(withChecks(s, checks))).toBe(4_200);
  });

  it("metrics on their own stay below tier-2 evidence", () => {
    expect(METRICS_TRUST_MAX_BPS).toBeLessThan(TIER_SCORE_BPS.tier2);
    const best = candidate(supplier("supplier-m", { ids: {}, metrics: { rating: 5, responseRate: 1, yearsOnPlatform: 40 } }));
    expect(trustOf(best)).toBe(METRICS_TRUST_MAX_BPS);
  });
});

describe("property: without a validator result, nothing outscores tier-2 trust evidence", () => {
  const idArb = fc.option(fc.string({ minLength: 1, maxLength: 64 }), { nil: undefined });
  const metricsArb = fc.record({ rating: fc.double({ min: 0, max: 5, noNaN: true }), responseRate: fc.double({ min: 0, max: 1, noNaN: true }), yearsOnPlatform: fc.nat(60) });

  it("any ids and any metrics, no evidence → trust < tier-2; the same supplier with tier-2 evidence → ≥ tier-2", () => {
    fc.assert(
      fc.property(idArb, idArb, idArb, idArb, metricsArb, (uscc, ssm, lei, uen, metrics) => {
        const ids = { ...(uscc ? { uscc } : {}), ...(ssm ? { ssm } : {}), ...(lei ? { lei } : {}), ...(uen ? { uen } : {}) };
        const bare = candidate(supplier("supplier-p", { ids, metrics }));
        const verified = candidate(supplier("supplier-q", { ids: {}, metrics }), [ev("supplier-q", "trust_verification", "tier2", "platform metric")]);
        expect(trustOf(bare)).toBeLessThanOrEqual(METRICS_TRUST_MAX_BPS);
        expect(trustOf(bare)).toBeLessThan(trustOf(verified));
      }),
      { numRuns: 300 },
    );
  });
});

describe("property: validated registry ids plus any metrics still score below tier-2 evidence (copied-USCC inversion)", () => {
  const metricsArb = fc.record({ rating: fc.double({ min: 0, max: 5, noNaN: true }), responseRate: fc.double({ min: 0, max: 1, noNaN: true }), yearsOnPlatform: fc.nat(60) });
  const idsArb = fc.record({ uscc: fc.boolean(), ssm: fc.boolean(), lei: fc.boolean(), uen: fc.boolean() });

  it("every id the validator passes, bound to the supplier, with any metrics → trust < tier-2 and below the tier-2-verified twin", () => {
    expect(LISTING_TRUST_MAX_BPS).toBeLessThan(TIER_SCORE_BPS.tier2);
    fc.assert(
      fc.property(idsArb, metricsArb, (has, metrics) => {
        const ids = { ...(has.uscc ? { uscc: USCC } : {}), ...(has.ssm ? { ssm: "202001012345" } : {}), ...(has.lei ? { lei: LEI } : {}), ...(has.uen ? { uen: UEN } : {}) };
        const checks: RegistryIdChecks = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, { supplierId: "supplier-f", id, valid: true }]));
        const forged = withChecks(candidate(supplier("supplier-f", { ids, metrics })), checks);
        const verified = candidate(supplier("supplier-h", { ids: {}, metrics }), [ev("supplier-h", "trust_verification", "tier2", "Shopee verified seller since 2023")]);
        expect(trustOf(forged)).toBeLessThanOrEqual(LISTING_TRUST_MAX_BPS);
        expect(trustOf(forged)).toBeLessThan(trustOf(verified));
      }),
      { numRuns: 300 },
    );
  });
});
