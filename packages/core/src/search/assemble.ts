/**
 * Web search results → candidate cards, pure (VISION-DECISIONS §9). The live API and the mock run the same code; they
 * only differ in where readings, FX and sanctions answers come from. Every listing is untrusted:
 *
 * 1. webVerdict (per allow-listed result) fails closed. A gate the text trips by itself → excluded before anything
 *    else (AI_INJECTION first, then OFF_PLATFORM_DISCOUNT; for web a payment-redirect phrase is OFF_PLATFORM_DISCOUNT
 *    too; the live Reader is not even called for it). No reading (the Reader refused, or the reading names another
 *    listing) → omitted READER_REJECTED. A gate the Reader adds → excluded. So an injected page never reaches the
 *    scorer and its name never reaches a card. No grounded seller, or a "name" that is not a company name or that the
 *    sanctions screen cannot screen (isSellerName) → NO_SELLER; no grounded price → NO_PRICE; a seller name or host the
 *    wording check refuses → WORDING. Certificate names with control characters are dropped.
 * 2. assembleWebSearch: no FX for the offer currency → CURRENCY; facts that cannot form a valid record or landed cost
 *    → READER_REJECTED (that listing only). The rest become Supplier records (candidateToSupplier),
 *    are priced with the country pack (freight: WEB_FREIGHT_BPS_OF_FOB, a labelled assumption: the pack has no freight
 *    leaf) and go through core buildShortlist with the caller's sanctions and registry results. The pre-excluded pages
 *    join `excluded` and the shortlist hash is recomputed over the merged list.
 * 3. Cards: the ranked candidates (at most 8), always unverified, priceFlag when the landed total is under 30% of the
 *    median of every listing this search ranked (at least 2; listings a gate excluded do not count), the name through
 *    the wording check ("(name hidden)" otherwise).
 */
import { landedCostFromPack } from "../landed-cost/index";
import { buildShortlist, shortlistHashOf, type RegistryIdChecks, type ScorerCandidate } from "../scorer/index";
import { SEARCH_OMIT_REASONS, SUPPLIER_GATES, type SearchOmitReason, type SupplierGate } from "../schemas/enums";
import type { CountryPack } from "../schemas/country-pack";
import type { SourceType, Sourced } from "../schemas/primitives";
import { CandidateCard, type SupplierSearch } from "../schemas/search";
import type { Shortlist, ShortlistSpec, Supplier } from "../schemas/supplier";
import { FLAG_SUPPLIER_GATE, detectImperativeText, normalizeForDetection } from "../taint/imperative";
import { candidateToSupplier, WEB_UNKNOWN_LEAD_TIME_DAYS } from "./candidate";
import { cardSafeName, passesWording } from "./wording";

/** Assumed freight per unit when a listing quotes FOB: 13% of the FOB price (the median freight share of the demo catalog, rounded up). */
export const WEB_FREIGHT_BPS_OF_FOB = 1300;
/** A landed total under this share of the search's median is flagged as likely bait. */
export const PRICE_FLAG_BPS_OF_MEDIAN = 3000;
export const MAX_CANDIDATE_CARDS = 8;
export const CARD_NAME_MAX = 120;
/** An unknown MOQ on the record (the card shows "not stated"; the enquiry asks for it). */
export const WEB_UNKNOWN_MOQ = 1;

/** Gates a listing's text or its Reader can trip, in the order they are reported. */
const PRE_GATES: readonly SupplierGate[] = ["AI_INJECTION", "OFF_PLATFORM_DISCOUNT"];

/**
 * The fields of one quarantined Reader reading that the search uses: structurally the agent's ListingReading and core's
 * RecordedListingReading (every value untrusted, every number grounded in the listing by the Reader).
 */
export interface WebReading {
  readonly docId: string;
  readonly fields: {
    readonly sellerName: { readonly value: string } | null;
    readonly unitPrice: { readonly value: { readonly amountMinor: string; readonly currency: string; readonly snippetHash: string } } | null;
    readonly moq: { readonly value: { readonly value: string } } | null;
    readonly leadTimeDays: { readonly value: { readonly value: string } } | null;
    readonly certificates: { readonly value: readonly string[] };
  };
  readonly supplierGates: readonly SupplierGate[];
}

/** One allow-listed result after the Reader. */
export interface WebListing {
  readonly supplierId: string;
  /** Canonical https listing URL (checks allowedListingUrl). */
  readonly url: string;
  readonly host: string;
  /** checks listingTextOf(result): what the Reader read and what the gates scan. */
  readonly listingText: string;
  /** null: the Reader refused or failed on this listing. */
  readonly reading: WebReading | null;
}

export interface WebDraft {
  readonly supplierId: string;
  readonly url: string;
  readonly host: string;
  readonly listingText: string;
  readonly sellerName: string;
  readonly currency: string;
  readonly unitPriceMinor: string;
  readonly priceSnippetHash: string;
  readonly moq: number | null;
  readonly leadTimeDays: number | null;
  readonly certificates: readonly string[];
}

export type WebVerdict =
  | { readonly kind: "omitted"; readonly supplierId: string; readonly reason: SearchOmitReason }
  | { readonly kind: "excluded"; readonly supplierId: string; readonly gate: SupplierGate }
  | { readonly kind: "draft"; readonly draft: WebDraft };

const COUNT_RE = /^[0-9]{1,9}$/;
const MINOR_RE = /^[1-9][0-9]{0,38}$/;

/**
 * What the sanctions screen (checks sanctions.ts nameKeys) removes before it splits a name into words: after NFKC,
 * every Default_Ignorable_Code_Point and the Hangul fillers; after NFKD, combining marks; then apostrophes,
 * transliteration marks (U+02B9..U+02BF, U+02C8), primes, format characters and the Arabic tatweel.
 */
const SCREEN_INVISIBLE_RE = /[\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ]/gu;
const SCREEN_DROPPED_RE = /['‘’‛`´ʹ-ʿˈ′ـ\p{Cf}]/gu;

/**
 * True when the sanctions screen has a letter or digit left to screen in `name`: core's twin of checks
 * `nameKeys(name).length > 0` (core cannot import checks; checks/test/sanctions.test.ts keeps the two equal). A name
 * made only of dropped letters (U+02B9 U+02B9, tatweel, Hangul fillers) is false (security audit run-9).
 */
export function hasScreenableText(name: string): boolean {
  const base = name.normalize("NFKC").replace(SCREEN_INVISIBLE_RE, "").normalize("NFKD").replace(/\p{M}+/gu, "");
  return /[\p{L}\p{N}]/u.test(base.toLowerCase().replace(SCREEN_DROPPED_RE, ""));
}

/**
 * A plausible company name: one line of at most CARD_NAME_MAX characters; letters (any script), digits, spaces and
 * . , & ( ) ' - / only (no control or format character); no run of more than 4 digits (no account or phone number), no
 * link or address marker, and something the sanctions screen can screen (hasScreenableText).
 */
export function isSellerName(name: string): boolean {
  return (
    name.length >= 2 &&
    name.length <= CARD_NAME_MAX &&
    /^[\p{L}\p{M}\p{N} .,&()'\-/]+$/u.test(name) &&
    /\p{L}/u.test(name) &&
    !/\p{N}{5,}/u.test(name) &&
    !/(https?|www\.|\.com\b)/iu.test(name) &&
    hasScreenableText(name)
  );
}

/** A certificate name the Reader grounded, kept only without control characters (Postgres jsonb refuses U+0000). */
const isStorableText = (s: string): boolean => !/\p{Cc}/u.test(s);

const countOf = (raw: string | undefined, min: number): number | null => {
  if (raw === undefined || !COUNT_RE.test(raw)) return null;
  const n = Number(raw);
  return n >= min ? n : null;
};

/** Gates the text trips by itself (core's detector; for web a payment-redirect phrase is OFF_PLATFORM_DISCOUNT). */
export function textGates(listingText: string): SupplierGate[] {
  const gates = new Set<SupplierGate>();
  for (const f of detectImperativeText(listingText)) {
    const gate = f.flag === "PAYMENT_REDIRECT" ? "OFF_PLATFORM_DISCOUNT" : FLAG_SUPPLIER_GATE[f.flag];
    if (gate) gates.add(gate);
  }
  return [...gates];
}

/** The gate a listing's text trips on its own (AI_INJECTION before OFF_PLATFORM_DISCOUNT), or null. No Reader needed. */
export function textPreGate(listingText: string): SupplierGate | null {
  const tripped = new Set(textGates(listingText));
  return PRE_GATES.find((g) => tripped.has(g)) ?? null;
}

/** One listing's fate, failing closed at the first missing fact (see the module note for the order). */
export function webVerdict(l: WebListing): WebVerdict {
  const { supplierId } = l;
  const byText = textPreGate(l.listingText);
  if (byText) return { kind: "excluded", supplierId, gate: byText };
  const r = l.reading;
  if (!r || r.docId !== supplierId) return { kind: "omitted", supplierId, reason: "READER_REJECTED" };
  const gate = PRE_GATES.find((g) => r.supplierGates.includes(g));
  if (gate) return { kind: "excluded", supplierId, gate };
  const seller = r.fields.sellerName?.value.trim() ?? "";
  // The Reader grounds every string; a recorded reading is checked again (whitespace and case ignored). The name must
  // also look like a company name, so a "name" carrying an account number, a link or a sentence never reaches a card.
  // A name that normalises to nothing is never "grounded" (every text includes the empty string).
  const needle = normalizeForDetection(seller);
  if (!isSellerName(seller) || needle === "" || !normalizeForDetection(l.listingText).includes(needle)) {
    return { kind: "omitted", supplierId, reason: "NO_SELLER" };
  }
  const price = r.fields.unitPrice?.value;
  if (!price || !MINOR_RE.test(price.amountMinor) || !/^[A-Z]{3}$/.test(price.currency) || !/^0x[0-9a-f]{64}$/.test(price.snippetHash)) {
    return { kind: "omitted", supplierId, reason: "NO_PRICE" };
  }
  // VISION-DECISIONS §9: a web string that fails the wording check omits the candidate (never shown, never orderable).
  if (!passesWording(seller) || !passesWording(l.host)) return { kind: "omitted", supplierId, reason: "WORDING" };
  return {
    kind: "draft",
    draft: {
      supplierId,
      url: l.url,
      host: l.host,
      listingText: l.listingText,
      sellerName: seller,
      currency: price.currency,
      unitPriceMinor: price.amountMinor,
      priceSnippetHash: price.snippetHash,
      moq: countOf(r.fields.moq?.value.value, 1),
      leadTimeDays: countOf(r.fields.leadTimeDays?.value.value, 0),
      certificates: r.fields.certificates.value.filter(isStorableText),
    },
  };
}

const USCC_RE = /(?:USCC|unified social credit code|统一社会信用代码)\s*(?:no\.?|number)?\s*[:：#]?\s*([0-9A-Z]{18})(?![0-9A-Za-z])/iu;
const UEN_RE = /\bUEN\s*(?:no\.?|number)?\s*[:：#]?\s*([0-9]{8,9}[A-Z]|[TSR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z])(?![0-9A-Za-z])/u;

/** Registry ids written next to their label in the listing (a tier3 claim: never earns points; a failed check is a red flag). */
export function registryIdsInText(text: string): Supplier["ids"] {
  const uscc = USCC_RE.exec(text)?.[1];
  const uen = UEN_RE.exec(text)?.[1];
  return { ...(uscc && /^[0-9A-Z]{18}$/.test(uscc) ? { uscc } : {}), ...(uen ? { uen } : {}) };
}

export interface WebAssemblyInput {
  /** The search id (= the shortlist requestId it is hashed with). */
  readonly requestId: string;
  readonly spec: ShortlistSpec;
  /** The server country's pack, in the facility's currency. */
  readonly pack: CountryPack;
  /** "live" for Tavily, "mock" for recorded samples. */
  readonly sourceType: SourceType;
  /** WebSearchAnswer.retrievedAt (the price leaf's retrieval time). */
  readonly retrievedAt: string;
  readonly rawTextRef: (supplierId: string) => string;
  readonly droppedOffList: number;
  readonly verdicts: readonly WebVerdict[];
  /** Offer currency → rate into the pack's currency; null or absent: unavailable (CURRENCY). */
  readonly fx: ReadonlyMap<string, Sourced<number> | null>;
  /** supplierId → sanctions hit, for every draft with FX (a missing one throws: never ranked unscreened). */
  readonly sanctionsHit: ReadonlyMap<string, boolean>;
  /** Drafts whose seller name the screen refused as input (screenWebDrafts): omitted NO_SELLER, never ranked. */
  readonly unscreenable?: ReadonlySet<string>;
  readonly registryChecks?: ReadonlyMap<string, RegistryIdChecks>;
}

export interface WebAssembly {
  /** READY shortlist over the scored drafts, `excluded` including the pre-excluded pages; hash over the merged list. */
  readonly shortlist: Shortlist;
  /** Every scored supplier (ranked or excluded by the scorer), with the text its gates scanned. */
  readonly suppliers: readonly { readonly supplier: Supplier; readonly listingText: string }[];
  readonly candidates: readonly CandidateCard[];
  readonly omitted: SupplierSearch["omitted"];
  readonly excludedByGate: SupplierSearch["excludedByGate"];
}

/** Drafts that would be priced: the ones whose offer currency has FX. */
export function pricedDrafts(verdicts: readonly WebVerdict[], fx: ReadonlyMap<string, Sourced<number> | null>): WebDraft[] {
  return verdicts.flatMap((v) => (v.kind === "draft" && fx.get(v.draft.currency) ? [v.draft] : []));
}

export interface WebScreening {
  /** supplierId → sanctions hit, for every draft the screen answered. */
  readonly sanctionsHit: ReadonlyMap<string, boolean>;
  /** Drafts whose seller name the screen refused as input (nothing to screen): omitted NO_SELLER. */
  readonly unscreenable: ReadonlySet<string>;
}

/**
 * Screens each priced draft's seller name on its own (security audit run-9 lead 1). An error `isUnscreenable` accepts
 * (checks CheckInputError: this one name has nothing to screen) omits only that listing; any other error (the list
 * cannot be read) rejects, so the caller fails the whole search (SANCTIONS_UNAVAILABLE), never "no hit".
 */
export async function screenWebDrafts(drafts: readonly WebDraft[], screen: (sellerName: string) => Promise<boolean>, isUnscreenable: (error: unknown) => boolean): Promise<WebScreening> {
  const answers = await Promise.all(
    drafts.map(async (d): Promise<readonly [string, boolean | null]> => {
      try {
        return [d.supplierId, await screen(d.sellerName)];
      } catch (error: unknown) {
        if (isUnscreenable(error)) return [d.supplierId, null];
        throw error;
      }
    }),
  );
  return {
    sanctionsHit: new Map(answers.flatMap(([id, hit]) => (hit === null ? [] : [[id, hit] as const]))),
    unscreenable: new Set(answers.flatMap(([id, hit]) => (hit === null ? [id] : []))),
  };
}

const freightOf = (fobMinor: string): string => ((BigInt(fobMinor) * BigInt(WEB_FREIGHT_BPS_OF_FOB) + 9_999n) / 10_000n).toString();

function supplierOf(d: WebDraft, input: WebAssemblyInput, fx: Sourced<number>): ScorerCandidate {
  const supplier = candidateToSupplier({
    supplierId: d.supplierId,
    displayName: d.sellerName,
    country: input.spec.buyFrom,
    listingUrl: d.url,
    rawTextRef: input.rawTextRef(d.supplierId),
    sourceType: input.sourceType,
    certificates: d.certificates,
    ids: registryIdsInText(d.listingText),
    offer: {
      currency: d.currency,
      fobUnit: { value: d.unitPriceMinor, sourceUrl: d.url, retrievedAt: input.retrievedAt, snippetHash: d.priceSnippetHash as `0x${string}`, evidence: "tier3", sourceType: input.sourceType },
      moq: d.moq ?? WEB_UNKNOWN_MOQ,
      leadTimeDays: d.leadTimeDays ?? WEB_UNKNOWN_LEAD_TIME_DAYS,
      freightPerUnit: freightOf(d.unitPriceMinor),
      incoterm: "FOB",
    },
  });
  const { landedCost } = landedCostFromPack({
    countryPack: input.pack,
    origin: supplier.country,
    productCategory: input.spec.productCategory,
    quantity: input.spec.quantity,
    fobUnitMinor: supplier.offer.fobUnit.value,
    freightPerUnitMinor: supplier.offer.freightPerUnit,
    fx,
  });
  const hit = input.sanctionsHit.get(d.supplierId);
  if (hit === undefined) throw new Error(`assembleWebSearch: ${d.supplierId} was not screened for sanctions`);
  const registryChecks = failedChecksOnly(input.registryChecks?.get(d.supplierId));
  return { supplier, evidence: [], listingText: d.listingText, landedCost, sanctionsHit: hit, ...(registryChecks ? { registryChecks } : {}) };
}

/**
 * A web listing's registry ids are claims copied from untrusted text (anyone can paste a real company's USCC; the
 * validators only check format and checksum), so they stay on the record as tier3 claims and earn no trust: only a
 * FAILED check is kept, which shows as a red flag and scores nothing (security audit run-9 hardening).
 */
function failedChecksOnly(checks: RegistryIdChecks | undefined): RegistryIdChecks | undefined {
  if (!checks) return undefined;
  const failed = Object.fromEntries(Object.entries(checks).filter(([, c]) => c?.valid === false));
  return Object.keys(failed).length > 0 ? failed : undefined;
}

/**
 * One draft as a scorer candidate, or null when its facts cannot form a valid record or a landed cost (an absurd price,
 * an overlong field): that listing is omitted, never the whole search. Only a missing sanctions answer throws.
 */
function scorerCandidateOf(d: WebDraft, input: WebAssemblyInput, fx: Sourced<number>): ScorerCandidate | null {
  if (input.sanctionsHit.get(d.supplierId) === undefined) throw new Error(`assembleWebSearch: ${d.supplierId} was not screened for sanctions`);
  try {
    return supplierOf(d, input, fx);
  } catch {
    return null;
  }
}

function median(xs: readonly bigint[]): bigint | null {
  if (xs.length < 2) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as bigint) : ((s[mid - 1] as bigint) + (s[mid] as bigint)) / 2n;
}

function counted<K extends string>(order: readonly K[], keys: readonly K[]): { key: K; count: number }[] {
  return order.map((key) => ({ key, count: keys.filter((k) => k === key).length })).filter((x) => x.count > 0);
}

export function assembleWebSearch(input: WebAssemblyInput): WebAssembly {
  const omittedKeys: SearchOmitReason[] = Array.from({ length: input.droppedOffList }, () => "OFF_LIST" as const);
  const preExcluded: { supplierId: string; gate: SupplierGate }[] = [];
  const scored: ScorerCandidate[] = [];
  const drafts = new Map<string, WebDraft>();
  for (const v of input.verdicts) {
    if (v.kind === "omitted") omittedKeys.push(v.reason);
    else if (v.kind === "excluded") preExcluded.push({ supplierId: v.supplierId, gate: v.gate });
    else if (input.unscreenable?.has(v.draft.supplierId)) omittedKeys.push("NO_SELLER");
    else {
      const rate = input.fx.get(v.draft.currency);
      if (!rate) omittedKeys.push("CURRENCY");
      else {
        const c = scorerCandidateOf(v.draft, input, rate);
        if (c) {
          scored.push(c);
          drafts.set(v.draft.supplierId, v.draft);
        } else omittedKeys.push("READER_REJECTED");
      }
    }
  }
  const built = buildShortlist({ requestId: input.requestId, spec: input.spec, candidates: scored });
  const excluded = [...built.excluded, ...preExcluded].sort((a, b) => (a.supplierId < b.supplierId ? -1 : a.supplierId > b.supplierId ? 1 : 0));
  const base = { requestId: built.requestId, weightsVersion: built.weightsVersion, candidates: built.candidates, excluded };
  const shortlist: Shortlist = { ...built, excluded, shortlistHash: shortlistHashOf(base) };
  // Over the ranked listings only: a listing a gate excluded (sanctions, MOQ, injected text) must not move the median.
  const mid = median(shortlist.candidates.map((c) => BigInt(c.landedCost.totalMinor)));
  const bait = (total: string): boolean => mid !== null && BigInt(total) * 10_000n < mid * BigInt(PRICE_FLAG_BPS_OF_MEDIAN);
  const candidates = shortlist.candidates.slice(0, MAX_CANDIDATE_CARDS).map((c) => {
    const d = drafts.get(c.supplierId);
    if (!d) throw new Error(`assembleWebSearch: ranked ${c.supplierId} has no draft`);
    return CandidateCard.parse({
      supplierId: c.supplierId,
      origin: "web",
      displayName: cardSafeName(d.sellerName, CARD_NAME_MAX),
      rank: c.rank,
      landedCostMinor: c.landedCost.totalMinor,
      moq: d.moq,
      leadTimeDays: d.leadTimeDays,
      evidenceCoverageBps: c.evidenceCoverageBps,
      failedGates: [],
      redFlagCount: c.redFlags.length,
      listingHost: d.host,
      listingUrl: d.url,
      unverified: true,
      canOrder: true,
      priceFlag: bait(c.landedCost.totalMinor),
    });
  });
  return {
    shortlist,
    suppliers: scored.map((c) => ({ supplier: c.supplier, listingText: c.listingText })),
    candidates,
    omitted: counted(SEARCH_OMIT_REASONS, omittedKeys).map(({ key, count }) => ({ reason: key, count })),
    excludedByGate: counted(SUPPLIER_GATES, excluded.map((e) => e.gate)).map(({ key, count }) => ({ gate: key, count })),
  };
}
