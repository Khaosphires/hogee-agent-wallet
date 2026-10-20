/**
 * Founder-facing wording for the CFO: plain labels, whole-BU amounts (formatBu), and nothing from model text. Every
 * string built here passes the wording lint (test/cfo-insights.test.ts) and says "estimate", never "confidence".
 */
import type { LineKey } from "../schemas/enums";
import type { Id } from "../schemas/primitives";
import { formatBu } from "../money/index";
import type { CfoInsightKind } from "./types";

/** One plain name per pocket, the same on every page (UX-PLAN §5; the web's lib/format.ts lineLabel agrees). */
const LINE_LABELS: { readonly [K in LineKey]: string } = {
  SUPPLIER: "Supplier",
  PACKAGING: "Packaging",
  LOGISTICS: "Delivery",
  ADS: "Ads",
  PLATFORM_FEES: "Marketplace fees",
  LICENSING: "Licence fees",
  CONTINGENCY: "Safety buffer",
};

export const lineLabel = (k: LineKey): string => LINE_LABELS[k];
export const bu = (minor: bigint): string => formatBu(minor < 0n ? -minor : minor);

/**
 * An estimate in whole BU, rounded to the nearest ("122.14" → "122 BU"): averages, paces and forecasts are guesses, so
 * the founder reads whole numbers (DESIGN.md §2). Recorded amounts keep their cents (`bu`).
 */
export function wholeBu(minor: bigint): string {
  const abs = minor < 0n ? -minor : minor;
  return formatBu(((abs + 50n) / 100n) * 100n);
}

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** A report day ("2026-10-25", a UTC calendar day) as the founder reads it: "25 Oct". */
export const dayMonthOf = (isoDate: string): string => DAY_MONTH.format(new Date(`${isoDate}T00:00:00Z`));

/** 500 → "5%", 550 → "5.5%", 525 → "5.25%". */
export function percentOfBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? `${whole}%` : `${whole}.${frac}%`;
}

/** A ratio given in tenths (16 → "1.6×"). */
export const timesOfTenths = (tenths: bigint): string => `${tenths / 10n}.${tenths % 10n}×`;

/** The same ratio in words (16 → "1.6 times"), for the founder's notes. */
export const timesWordOfTenths = (tenths: bigint): string => `${tenths / 10n}.${tenths % 10n} times`;

/** Deterministic: one insight of a kind per line (or "all") per UTC day. */
export const insightIdOf = (kind: CfoInsightKind, lineKey: LineKey | null, isoDate: string): Id =>
  `cfo-${kind.toLowerCase().replace(/_/g, "-")}-${(lineKey ?? "all").toLowerCase().replace(/_/g, "-")}-${isoDate}`;

export const dayWord = (n: number): string => (n === 1 ? "1 day" : `${n} days`);

/** Where budget moves and stage releases are requested (the dashboard's change-requests card). */
export const CHANGE_REQUESTS_HREF = "/dashboard#change-requests";

/**
 * The change request that raises `cap` on `lineKey` back to `toMinor`, prefilled on the dashboard's change-requests
 * card (a RAISE_CAP still needs the founder's signature, the loan officer and the timelock).
 */
export const raiseCapHref = (lineKey: LineKey, cap: "perTx" | "window", toMinor: bigint): string =>
  `/dashboard?raise=${lineKey}&cap=${cap}&to=${toMinor.toString()}#change-requests`;

/** Keeps a string within a §3 length limit (only absurd, near-uint128 amounts ever need it). */
export const fitText = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
