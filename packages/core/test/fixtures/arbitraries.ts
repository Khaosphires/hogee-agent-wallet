/** fast-check generators for the property tests. */
import fc from "fast-check";
import {
  ENTITY_TYPES_BY_COUNTRY,
  JUDGING_WINDOW_END,
  LINE_KEYS,
  PRODUCT_CATEGORIES,
  RESIDENCIES,
  SELL_CHANNELS,
  fakeAddress,
  fakeHex32,
  type CompileInput,
  type CountryCode,
  type LineEmphasis,
  type LineKey,
  type PlanIntent,
  type RegistryPayee,
} from "../../src/index";
import { TEST_PACK_ID, TEST_PACK_MY } from "./packs";

const DAY = 86_400n;
const digits = (min: bigint, max: bigint) => fc.bigInt({ min, max }).map(String);

export const emphasisArb = fc.record(
  Object.fromEntries(LINE_KEYS.map((k) => [k, fc.constantFrom<LineEmphasis>("low", "med", "high")])) as Record<LineKey, fc.Arbitrary<LineEmphasis>>,
  { requiredKeys: [] },
);

export const intentArb = (cc: CountryCode): fc.Arbitrary<PlanIntent> =>
  fc.record({
    intentVersion: fc.constant(1 as const),
    countryCode: fc.constant(cc),
    residency: fc.constantFrom(...RESIDENCIES),
    entityType: fc.constantFrom(...ENTITY_TYPES_BY_COUNTRY[cc]),
    productCategory: fc.constantFrom(...PRODUCT_CATEGORIES),
    sellChannel: fc.constantFrom(...SELL_CHANNELS),
    buyFrom: fc.constantFrom("CN", "MY", "ID", "VN", "TH", "US", "DE"),
    budgetCeilingMinor: digits(10_000n, 10n ** 18n),
    horizonDays: fc.constantFrom(30 as const, 60 as const, 90 as const),
    lineEmphasis: emphasisArb,
    adsPacing: fc.constantFrom("conservative" as const, "standard" as const),
    answeredSlots: fc.constant([]),
    assumptions: fc.constant([]),
  });

export const payeeArb: fc.Arbitrary<RegistryPayee> = fc.record(
  {
    payeeId: fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
    source: fc.constantFrom("platform" as const, "bound" as const),
    lineKeys: fc.subarray([...LINE_KEYS], { minLength: 1 }),
    channels: fc.subarray([...SELL_CHANNELS], { minLength: 1 }),
    schedule: fc.array(fc.record({ amountMinor: digits(0n, 10n ** 9n), autoRelease: fc.boolean() }), { minLength: 1, maxLength: 4 }),
    lifetimeCapMinor: digits(0n, 10n ** 10n),
    coolingUntil: digits(0n, 2n * 10n ** 9n),
  },
  { requiredKeys: ["payeeId", "source", "lineKeys"] },
);

/** A full compile input for a random country, intent, facility (cap, floor, registry) and commit time. */
export const compileInputArb: fc.Arbitrary<CompileInput> = fc.constantFrom<CountryCode>("MY", "ID").chain((cc) =>
  fc.record({
    intent: intentArb(cc),
    capMinor: digits(10_000n, 10n ** 18n),
    reserveFloorBps: fc.integer({ min: 0, max: 10_000 }),
    payees: fc.array(payeeArb, { maxLength: 6 }),
    nowOffsetDays: fc.bigInt({ min: -89n, max: 400n }),
  }).map(({ intent, capMinor, reserveFloorBps, payees, nowOffsetDays }) => {
    const pack = cc === "MY" ? TEST_PACK_MY : TEST_PACK_ID;
    return {
      intent,
      countryPack: pack,
      facility: {
        facilityId: "fac-prop",
        countryCode: cc,
        currency: pack.currency,
        capMinor,
        reserveFloorBps,
        judgingWindowEnd: JUDGING_WINDOW_END,
        payees,
        ownerEOA: fakeAddress("owner:prop"),
        lender: fakeAddress("lender:prop"),
        oracle: fakeAddress("oracle:prop"),
      },
      now: String(BigInt(JUDGING_WINDOW_END) + nowOffsetDays * DAY),
      ids: { draftId: "draft-prop", planId: fakeHex32("planId:prop"), agentAddress: fakeAddress("agent:prop") },
      aigc: { model: "claude-sonnet-5-5", promptHash: fakeHex32("promptHash:prop") },
    };
  }),
);

/** Recursively rebuild plain objects with keys in reverse order (same JSON content, different insertion order). */
export function reverseKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map(reverseKeys) as T;
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as object).reverse().map(([k, x]) => [k, reverseKeys(x)])) as T;
  }
  return v;
}
