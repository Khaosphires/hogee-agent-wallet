/**
 * The sample business's story (MOCK_SCENARIO=lived; docs/decisions/ux2-demo-data.md): Mei (SG) about three weeks into
 * selling insulated tumblers on Shopee, as data. Every date is relative to the UTC day the store is built (day 0;
 * day -24 is when she signed her plan), so the sample always looks three weeks old. build.ts plays it through the
 * mock's own transitions in time order; nothing here is a balance, a cap or a total: those come out of the ledger.
 *
 * Amounts are budget units in minor units (SGD cents). An ads payment is always the plan's pacing slot; the other
 * payments are invoices of the sizes below, each within its pocket's per-payment and 7-day caps (test/lived-caps.test.ts
 * walks every one of them through the plan's limits). Sales are deterministic per day.
 */
import type { LineKey, TermsPreset } from "@hogee/core";

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** A moment of the story: `day` days from the build day (0 = the build day), at hh:mm UTC. */
export interface When {
  readonly day: number;
  readonly hour: number;
  readonly minute?: number;
}

export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** The story moment `w` in ms, for a store built at `builtAtMs`. */
export const whenMs = (builtAtMs: number, w: When): number => startOfUtcDay(builtAtMs) + w.day * DAY_MS + (w.hour * 60 + (w.minute ?? 0)) * MINUTE_MS;

export type SearchRef = "first" | "second";
export type OrderRef = "first" | "second";

export type StoryStep =
  | { readonly kind: "commit"; readonly at: When }
  | { readonly kind: "fund"; readonly at: When; readonly amountMinor: string }
  | { readonly kind: "search"; readonly at: When; readonly ref: SearchRef; readonly quantity: number }
  | { readonly kind: "add-payee"; readonly at: When; readonly lineKey: LineKey; readonly reason: string }
  | {
      readonly kind: "order";
      readonly at: When;
      readonly ref: OrderRef;
      readonly search: SearchRef;
      /** The candidate's rank in that search (a web supplier gets one order, so each order has its own supplier). */
      readonly rank: number;
      readonly quantity: number;
      readonly totalMinor: string;
      readonly preset: TermsPreset;
    }
  | { readonly kind: "delivery-check"; readonly at: When; readonly order: OrderRef }
  | { readonly kind: "spend"; readonly at: When; readonly lineKey: LineKey; readonly amountMinor?: string; readonly reason: string };

/** Minutes between a request and the founder's signature on it, and from the founder to the loan officer. */
export const SIGN_AFTER_MIN = 10;
export const OFFICER_AFTER_MIN = 120;

const ads = (day: number): StoryStep => ({ kind: "spend", at: { day, hour: 0, minute: 30 }, lineKey: "ADS", reason: "Shopee ads for the day, the signed plan's daily pacing slot" });
const delivery = (day: number, amountMinor: string): StoryStep => ({ kind: "spend", at: { day, hour: 10 }, lineKey: "LOGISTICS", amountMinor, reason: "SPX last-mile deliveries to Shopee buyers" });
const fees = (day: number, amountMinor: string): StoryStep => ({ kind: "spend", at: { day, hour: 15 }, lineKey: "PLATFORM_FEES", amountMinor, reason: "Shopee platform and transaction fees for the week" });

/** The story, in any order (build.ts sorts it by time). */
export const STORY: readonly StoryStep[] = [
  { kind: "commit", at: { day: -24, hour: 1 } },
  { kind: "fund", at: { day: -24, hour: 2, minute: 30 }, amountMinor: "1000000" },
  { kind: "search", at: { day: -24, hour: 3 }, ref: "first", quantity: 300 },
  { kind: "add-payee", at: { day: -24, hour: 4 }, lineKey: "PACKAGING", reason: "Printed gift boxes for the tumblers" },
  { kind: "order", at: { day: -23, hour: 2 }, ref: "first", search: "first", rank: 1, quantity: 300, totalMinor: "120000", preset: "P30_70" },
  { kind: "spend", at: { day: -22, hour: 8 }, lineKey: "PACKAGING", amountMinor: "20000", reason: "Printed gift boxes, first batch" },
  { kind: "delivery-check", at: { day: -21, hour: 3 }, order: "first" },
  { kind: "spend", at: { day: -21, hour: 5 }, lineKey: "LOGISTICS", amountMinor: "12000", reason: "Inbound freight for the first supplier order" },
  ...[-21, -19, -17, -15, -13, -11, -8, -5].map(ads),
  ...(
    [
      [-18, "2600"],
      [-15, "3100"],
      [-12, "3400"],
      [-9, "3900"],
      [-6, "4200"],
      [-3, "3300"],
      [-1, "2500"],
    ] as const
  ).map(([day, amount]) => delivery(day, amount)),
  ...(
    [
      [-14, "2900"],
      [-7, "3600"],
      [-1, "4100"],
    ] as const
  ).map(([day, amount]) => fees(day, amount)),
  { kind: "spend", at: { day: -9, hour: 8 }, lineKey: "PACKAGING", amountMinor: "16000", reason: "Printed gift boxes, reorder" },
  { kind: "search", at: { day: -8, hour: 4 }, ref: "second", quantity: 300 },
  { kind: "order", at: { day: -7, hour: 3 }, ref: "second", search: "second", rank: 2, quantity: 300, totalMinor: "100000", preset: "P30_70" },
];

/** The first sale day (the first order arrived that morning) and the sales per day from then to the build day. */
export const FIRST_SALE_DAY = -21;
const SALES_PER_DAY = [1, 1, 2, 1, 2, 2, 3, 2, 3, 3, 2, 3, 4, 3, 3, 4, 4, 3, 5, 4, 4, 3] as const;
/** Whole-BU sale amounts the sample cycles through (SGD 25 to 36 a tumbler). */
const SALE_AMOUNTS = [2_800n, 3_300n, 2_900n, 3_600n, 2_500n, 3_100n] as const;
/** Shopee orders land through the Singapore day (09:00 to 19:00 SGT). */
const SALE_HOURS_UTC = [1, 3, 5, 7, 9, 11] as const;

export interface StorySale {
  /** `sale-sample-<day>-<n>`: the same ids, and so the same "Sample data" labels, as the 14-day sample. */
  readonly saleId: string;
  readonly amountMinor: bigint;
  readonly atMs: number;
}

/** The sample's sales up to `builtAtMs` (today's only those already made), oldest first. */
export function storySales(builtAtMs: number): StorySale[] {
  const out: StorySale[] = [];
  SALES_PER_DAY.forEach((count, k) => {
    for (let j = 0; j < count; j += 1) {
      const atMs = whenMs(builtAtMs, { day: FIRST_SALE_DAY + k, hour: SALE_HOURS_UTC[j % SALE_HOURS_UTC.length] ?? 1, minute: (k * 7 + j * 13) % 50 });
      const amountMinor = SALE_AMOUNTS[(k + j * 2) % SALE_AMOUNTS.length] as bigint;
      if (atMs < builtAtMs) out.push({ saleId: `sale-sample-${k + 1}-${j + 1}`, amountMinor, atMs });
    }
  });
  return out;
}

/** The chat's first line in a sample-business session (a template: no model text, no seller name). */
export const WELCOME_BACK =
  "Welcome back, Mei. This is a sample business, three weeks in: the sales, payments and orders are made up so you can look around. Your first supplier order is complete.";
