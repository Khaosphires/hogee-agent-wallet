/**
 * FX rates from the Bank Negara Malaysia OpenAPI (project.md §11: "FX from BNM"). Sourced value = how many quote
 * units one base unit buys (landed-cost convention).
 * - X/MYR: BNM interbank middle rate, session 1200, quote "rm", divided by BNM's `unit` (JPY, IDR … are per 100).
 *   tier1; sourceUrl = the exact request; snippetHash = sha256 of the raw response body (§26.3).
 * - X/SGD (additive, Singapore): MAS has no keyless machine-readable endpoint (docs/decisions/checks.md), so the
 *   rate is a cross rate through MYR from two BNM answers of the same date: (X/MYR) ÷ (SGD/MYR). tier2, rounded to
 *   8 significant digits; sourceUrl = the X/MYR request + `#bnm-cross-rate=X/MYR,SGD/MYR&sgd-myr=<SGD/MYR request,
 *   URI-encoded>` (MYR/SGD: the SGD/MYR request + `#bnm-inverse-rate=SGD/MYR`); snippetHash = sha256 of the bodies
 *   joined by "\n".
 * - X/X: 1, no request; tier3 (nothing to source).
 * BNM publishes on business days only: when the date has no rate, earlier dates are tried, at most
 * FX_LOOKBACK_DAYS back; the sourceUrl names the date actually used. The whole call stops starting new requests
 * after FX_DEADLINE_MS. Every failure throws (fail closed).
 */
import { IsoDate, rationalOf, sha256Bytes, sourced, snippetHash, type Rational, type Sourced } from "@hogee/core";
import { z } from "zod";
import { httpGet, isoNow, parseJsonBody, type HttpOptions } from "./http";
import { CheckInputError, CheckUnavailableError, type FxPair } from "./types";

export const BNM_HOST = "api.bnm.gov.my";
export const BNM_ACCEPT = "application/vnd.BNM.API.v1+json";
/** Interbank rates are published for 0900, 1200 and 1700; 1130 is banks' counter rates (no middle rate). */
export const BNM_SESSION = "1200";
export const FX_LOOKBACK_DAYS = 7;
/** No new BNM request starts this long after getFx began (bounds look-back × legs × retries). */
export const FX_DEADLINE_MS = 30_000;
const BNM_BASE = `https://${BNM_HOST}/public/exchange-rate`;
const BNM_MAX_BYTES = 16 * 1024;
const CROSS_SIGNIFICANT_DIGITS = 8;
const PAIR = /^([A-Z]{3})\/([A-Z]{3})$/;

export interface FxOptions extends HttpOptions {
  /** How many earlier dates to try when BNM has no rate for the date. Default FX_LOOKBACK_DAYS. */
  readonly lookbackDays?: number;
  /** Default FX_DEADLINE_MS. */
  readonly deadlineMs?: number;
}

const BnmAnswer = z.object({
  data: z.object({
    currency_code: z.string(),
    unit: z.number().int().positive().max(1_000_000),
    rate: z.object({ date: z.string(), middle_rate: z.number().positive().finite().nullable() }),
  }),
  meta: z.object({ quote: z.literal("rm"), session: z.literal(BNM_SESSION) }),
});

const SourcedRate = sourced(z.number().positive().finite());

/** The BNM request for one currency against MYR on one date. */
export function bnmRateUrl(currency: string, date: string): URL {
  return new URL(`${BNM_BASE}/${encodeURIComponent(currency)}/date/${encodeURIComponent(date)}?session=${BNM_SESSION}&quote=rm`);
}

interface Leg {
  /** MYR per 1 unit of the currency, exact. */
  readonly rate: Rational;
  readonly url: URL;
  readonly bytes: Uint8Array;
}

/** BNM's JSON answer for a date without a rate: {"message":"No records found.","code":404}. */
const BnmNoRecords = z.object({ code: z.literal(404) });

/** One BNM rate, or null when BNM says it has no record for that date. Any other 404 (e.g. an HTML page) throws. */
async function bnmLeg(currency: string, date: string, opts: HttpOptions): Promise<Leg | null> {
  const url = bnmRateUrl(currency, date);
  const { status, bytes } = await httpGet(url, { service: "BNM", host: BNM_HOST, accept: BNM_ACCEPT, maxBytes: BNM_MAX_BYTES }, opts);
  if (status === 404) {
    if (BnmNoRecords.safeParse(parseJsonBody(bytes, "BNM")).success) return null;
    throw new CheckUnavailableError("BNM answered HTTP 404 without its no-records body");
  }
  if (status !== 200) throw new CheckUnavailableError(`BNM answered HTTP ${status}`);
  const parsed = BnmAnswer.safeParse(parseJsonBody(bytes, "BNM"));
  if (!parsed.success) throw new CheckUnavailableError("BNM answer has an unexpected shape");
  const { data } = parsed.data;
  if (data.currency_code !== currency || data.rate.date !== date) throw new CheckUnavailableError("BNM answered for another currency or date");
  if (data.rate.middle_rate === null) throw new CheckUnavailableError(`BNM has no middle rate for ${currency} on ${date}`);
  const mid = rationalOf(data.rate.middle_rate, "BNM middle_rate");
  return { rate: { num: mid.num, den: mid.den * BigInt(data.unit) }, url, bytes };
}

const pow10 = (n: number) => 10n ** BigInt(n);
const digits = (n: bigint) => n.toString().length;

/** num/den rounded half up to `sig` significant digits, as a plain decimal string. */
export function toDecimal(r: Rational, sig: number): string {
  if (r.num <= 0n || r.den <= 0n) throw new CheckUnavailableError("FX rate is not positive");
  // Scale so that the integer part of num·10^k/den has exactly `sig` digits.
  let k = sig - (digits(r.num) - digits(r.den)) - 1;
  const scaled = (kk: number) => (kk >= 0 ? (r.num * pow10(kk)) / r.den : r.num / (r.den * pow10(-kk)));
  while (scaled(k) >= pow10(sig)) k -= 1;
  while (scaled(k) < pow10(sig - 1)) k += 1;
  const [n, d] = k >= 0 ? [r.num * pow10(k), r.den] : [r.num, r.den * pow10(-k)];
  const rounded = (2n * n + d) / (2n * d);
  if (k <= 0) return (rounded * pow10(-k)).toString();
  const s = rounded.toString().padStart(k + 1, "0");
  const out = `${s.slice(0, -k)}.${s.slice(-k)}`.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

const divide = (a: Rational, b: Rational): Rational => ({ num: a.num * b.den, den: a.den * b.num });
const ONE: Rational = { num: 1n, den: 1n };

function concatBodies(parts: readonly Uint8Array[]): Uint8Array {
  const sep = new TextEncoder().encode("\n");
  const total = parts.reduce((n, p, i) => n + p.byteLength + (i > 0 ? sep.byteLength : 0), 0);
  const out = new Uint8Array(total);
  let at = 0;
  parts.forEach((p, i) => {
    if (i > 0) {
      out.set(sep, at);
      at += sep.byteLength;
    }
    out.set(p, at);
    at += p.byteLength;
  });
  return out;
}

function previousDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function finish(value: string, sourceUrl: string, hashed: string, evidence: "tier1" | "tier2" | "tier3", opts: HttpOptions): Sourced<number> {
  const leaf = { value: Number(value), sourceUrl, retrievedAt: isoNow(opts.now), snippetHash: hashed, evidence, sourceType: "live" as const };
  const checked = SourcedRate.safeParse(leaf);
  if (!checked.success) throw new CheckUnavailableError("FX result failed validation");
  return checked.data;
}

/** The legs needed for base/quote on one date, or null when BNM has no record for any of them that day. */
async function legsOn(base: string, quote: string, date: string, deadline: number, opts: HttpOptions): Promise<Leg[] | null> {
  const needed = quote === "MYR" ? [base] : base === "MYR" ? ["SGD"] : [base, "SGD"];
  const legs: Leg[] = [];
  for (const currency of needed) {
    if (Date.now() >= deadline) throw new CheckUnavailableError("BNM: FX deadline passed");
    const leg = await bnmLeg(currency, date, opts);
    if (!leg) return null;
    legs.push(leg);
  }
  return legs;
}

function fromLegs(base: string, quote: string, legs: readonly Leg[], opts: HttpOptions): Sourced<number> {
  const [first, second] = legs;
  if (!first) throw new CheckUnavailableError("FX: no BNM answer");
  if (quote === "MYR") return finish(toDecimal(first.rate, CROSS_SIGNIFICANT_DIGITS), first.url.href, sha256Bytes(first.bytes), "tier1", opts);
  if (base === "MYR") {
    return finish(toDecimal(divide(ONE, first.rate), CROSS_SIGNIFICANT_DIGITS), `${first.url.href}#bnm-inverse-rate=SGD/MYR`, sha256Bytes(first.bytes), "tier2", opts);
  }
  if (!second) throw new CheckUnavailableError("FX: missing SGD/MYR leg");
  const url = `${first.url.href}#bnm-cross-rate=${base}/MYR,SGD/MYR&sgd-myr=${encodeURIComponent(second.url.href)}`;
  return finish(toDecimal(divide(first.rate, second.rate), CROSS_SIGNIFICANT_DIGITS), url, sha256Bytes(concatBodies([first.bytes, second.bytes])), "tier2", opts);
}

/**
 * Mid rate for `pair` ("BASE/QUOTE", quote MYR or SGD) on `date` (YYYY-MM-DD), as a Sourced number: one BASE unit
 * = value QUOTE units. Never sends user data: the request holds only currency codes and the date.
 */
export async function getFx(pair: FxPair, date: string, opts: FxOptions = {}): Promise<Sourced<number>> {
  const m = typeof pair === "string" ? PAIR.exec(pair) : null;
  if (!m) throw new CheckInputError("pair must be BASE/QUOTE with ISO 4217 codes, e.g. CNY/MYR");
  if (!IsoDate.safeParse(date).success) throw new CheckInputError("date must be YYYY-MM-DD");
  const [, base = "", quote = ""] = m;
  if (base === quote) {
    return finish("1", "https://www.bnm.gov.my/exchange-rates", snippetHash(`1 ${base} = 1 ${quote} (same currency, no conversion)`), "tier3", opts);
  }
  if (quote !== "MYR" && quote !== "SGD") throw new CheckInputError("only */MYR and */SGD pairs are supported");
  const lookback = Math.min(Math.max(opts.lookbackDays ?? FX_LOOKBACK_DAYS, 0), 31);
  const deadline = Date.now() + (opts.deadlineMs ?? FX_DEADLINE_MS);
  for (let back = 0; back <= lookback; back += 1) {
    const legs = await legsOn(base, quote, previousDate(date, back), deadline, opts);
    if (legs) return fromLegs(base, quote, legs, opts);
  }
  throw new CheckUnavailableError(`BNM has no ${base}/${quote} rate on ${date} or the ${lookback} days before`);
}
