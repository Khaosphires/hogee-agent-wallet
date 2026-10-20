/**
 * Display formatting. Money is always minor-unit strings (1 BU = 100 minor) and always shows its unit
 * (ROLE-P2 A.3 rule 3): "10,000 BU (facility: MYR)". Never parse money into a JS number.
 */
import { formatBu, parseMinor } from "@hogee/core";

/** "10,000 BU" from a minor-unit string. */
export const bu = (minor: string): string => formatBu(minor);

/** "10,000 BU (facility: MYR)". */
export const buWithFacility = (minor: string, currency: string | undefined): string =>
  currency ? `${formatBu(minor)} (facility: ${currency})` : formatBu(minor);

/** Integer percentage of part/whole for bars (0..100), computed in bigint. */
export function pctOf(part: string, whole: string): number {
  const w = parseMinor(whole);
  if (w === 0n) return 0;
  const p = parseMinor(part);
  const pct = (p * 10_000n) / w;
  return Math.max(0, Math.min(100, Number(pct) / 100));
}

/** Basis points → "5.00%". */
export const bpsPct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** "0x1234…abcd". */
export const shortHash = (hex: string, head = 6, tail = 4): string => (hex.length > head + tail + 2 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex);

const DATE_TIME = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

/** ISO-8601 → "16 Oct 2026, 12:00 UTC". */
export const isoDateTime = (iso: string): string => DATE_TIME.format(new Date(iso));

/** Unix seconds (digit string) → "15 Dec 2026". */
export const unixDate = (seconds: string): string => DATE.format(new Date(Number(seconds) * 1000));

/** Unix seconds → "16 Oct 2026, 12:00 UTC". */
export const unixDateTime = (seconds: string): string => DATE_TIME.format(new Date(Number(seconds) * 1000));

/** Typed BU ("10,000" or "12.5") → minor-unit string, or undefined if it isn't a non-negative amount with ≤ 2 decimals. */
export function parseBuInput(text: string): string | undefined {
  const clean = text.replace(/[,\s]/g, "");
  const m = /^(\d{1,30})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return undefined;
  return (BigInt(m[1] ?? "0") * 100n + BigInt((m[2] ?? "").padEnd(2, "0"))).toString();
}

/** Typed percent ("3" or "2.5") → basis points, or undefined outside 0..100 with ≤ 2 decimals. */
export function parsePctToBps(text: string): number | undefined {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return undefined;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bps <= 10_000 ? bps : undefined;
}

/**
 * A pocket's plain name, the same on every page (UX-PLAN §5: core needs labels, core cfo text and the explainer use
 * these words too): Supplier, Packaging, Delivery, Ads, Marketplace fees, Licence fees, Safety buffer. An unknown key
 * falls back to its own words ("NEW_LINE" → "New line"), never to a blank.
 */
const POCKET_NAMES: Readonly<Record<string, string>> = {
  SUPPLIER: "Supplier",
  PACKAGING: "Packaging",
  LOGISTICS: "Delivery",
  ADS: "Ads",
  PLATFORM_FEES: "Marketplace fees",
  LICENSING: "Licence fees",
  CONTINGENCY: "Safety buffer",
};

/** "LOGISTICS" → "Delivery", "PLATFORM_FEES" → "Marketplace fees", "CONTINGENCY" → "Safety buffer". */
export const lineLabel = (key: string): string => POCKET_NAMES[key] ?? key.charAt(0) + key.slice(1).toLowerCase().replace(/_/g, " ");

// ---- local times (UX-PLAN §6: "19 Oct, 14:02 SGT") -----------------------------------------------------------------

/** The facility's clock: Singapore time for SGD, Malaysia time for MYR (both UTC+8). Anything else reads in UTC. */
const ZONES: Readonly<Record<string, { readonly tz: string; readonly label: string }>> = {
  SGD: { tz: "Asia/Singapore", label: "SGT" },
  MYR: { tz: "Asia/Kuala_Lumpur", label: "MYT" },
};
/** Hogee's home market: a page that doesn't know the facility's currency yet reads Singapore time. */
const DEFAULT_CURRENCY = "SGD";
const UTC_ZONE = { tz: "UTC", label: "UTC" } as const;

const zoneOf = (currency: string | undefined) => ZONES[currency ?? DEFAULT_CURRENCY] ?? UTC_ZONE;

const dayMonthFormat = new Map<string, Intl.DateTimeFormat>();
const timeFormat = new Map<string, Intl.DateTimeFormat>();
const cached = (cache: Map<string, Intl.DateTimeFormat>, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz });
    cache.set(tz, f);
  }
  return f;
};

/** An ISO-8601 date-time, or unix seconds as a digit string or number, as a Date (Invalid Date when it is neither). */
function toDate(isoOrUnix: string | number): Date {
  if (typeof isoOrUnix === "number") return new Date(isoOrUnix * 1000);
  return /^\d{1,12}$/.test(isoOrUnix) ? new Date(Number(isoOrUnix) * 1000) : new Date(isoOrUnix);
}

/**
 * "19 Oct, 14:02 SGT": the moment in the facility's own time (SGT for SGD, MYT for MYR, UTC otherwise; SGT when the
 * currency isn't known yet). Takes an ISO date-time or unix seconds. An unreadable value says so rather than guess.
 */
export function localDateTime(isoOrUnix: string | number, currency?: string): string {
  const d = toDate(isoOrUnix);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const zone = zoneOf(currency);
  const day = cached(dayMonthFormat, zone.tz, { day: "numeric", month: "short" }).format(d);
  const time = cached(timeFormat, zone.tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${day}, ${time} ${zone.label}`;
}

/** "25 Oct" from a calendar day ("2026-10-25", as the CFO report dates its days). */
export function dayMonth(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDate : cached(dayMonthFormat, "UTC", { day: "numeric", month: "short" }).format(d);
}
