/**
 * Web candidate → Supplier (plan §2 "web candidate → Supplier mapping is explicit"). What a web listing can and cannot
 * set on the record the scorer and SupplierApproval read:
 * - payout: a SENTINEL `xenditTest` {channel "UNSET", accountNumber "0000", holder = the seller name}. It is never a
 *   real destination: the payout account arrives only through submitOrderTerms (v-terms), never from listing text;
 * - escrow = true (Hogee's escrow holds the money, whatever the listing claims), payeeType "company";
 * - certificates: only names the Reader grounded in the listing, each tier3 ("named in the listing, not checked"; ref =
 *   the web supplier id, never the URL, which can exceed the field), so they count for the presence gate, no score;
 * - metrics: zero (a listing's "11 years on the platform" is not evidence);
 * - an unknown lead time is the scorer's zero-score lead time, never 0 days;
 * - listing.rawTextRef names where the listing text came from (repo-relative for recorded samples).
 * Web ids: "supplier-w" + base32lower(sha256(canonical URL)).slice(0, 12), matching WEB_SUPPLIER_ID_RE and checks'
 * webSupplierId for the same URL; "canonical" is canonicalListingUrl (listing-url.ts), shared with checks.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { sha256Utf8 } from "../hash/index";
import { LEAD_TIME_ZERO_DAYS } from "../scorer/criteria";
import type { SourceType, SupplierId } from "../schemas/primitives";
import { Supplier, WEB_SUPPLIER_ID_RE } from "../schemas/supplier";
import { canonicalListingUrl } from "./listing-url";

/** Who the sentinel payout destination names; SupplierApproval for a web order binds the account from the terms row. */
export const WEB_SENTINEL_CHANNEL = "UNSET";
export const WEB_SENTINEL_ACCOUNT = "0000";
/** The issuer shown for a certificate a listing names (tier3: presence only, no score). */
export const WEB_CERT_ISSUER = "Named in the listing; not checked";
export const WEB_METRICS: Supplier["metrics"] = { rating: 0, responseRate: 0, yearsOnPlatform: 0 };
/** An unknown lead time: the scorer gives it zero lead-time points (never full marks for a missing fact). */
export const WEB_UNKNOWN_LEAD_TIME_DAYS = LEAD_TIME_ZERO_DAYS;
const CERT_TYPE_MAX = 100;

/** The checked facts of one web candidate (from the quarantined Reader, grounded in the listing text). */
export interface WebCandidateFacts {
  readonly supplierId: SupplierId;
  readonly displayName: string;
  /** ISO 3166-1 alpha-2 country the seller ships from. */
  readonly country: string;
  /** The https listing URL on the allow-list (never fetched). */
  readonly listingUrl: string;
  /** Repo-relative path of the recorded listing text. */
  readonly rawTextRef: string;
  readonly offer: Supplier["offer"];
  /** "live" (Tavily) or "mock" (recorded sample). Default "live". */
  readonly sourceType?: SourceType;
  /** Certificate names the Reader grounded in the listing (stored tier3). */
  readonly certificates?: readonly string[];
  /** Registry ids written in the listing text (tier3 claims: assembleWebSearch scores none of them). */
  readonly ids?: Supplier["ids"];
  /** The listing or the Reader asks for payment outside the platform (the scorer's OFF_PLATFORM_DISCOUNT gate). */
  readonly offPlatformDiscount?: boolean;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

/**
 * True for an https URL already in canonical form (canonicalListingUrl: origin + path with normalised percent-encoding;
 * no port, user info, query or fragment).
 */
function isCanonicalListingUrl(raw: string): boolean {
  return canonicalListingUrl(raw) === raw;
}

/** "supplier-w" + base32lower(sha256(utf8(canonical URL))).slice(0, 12). Throws for a URL that is not canonical. */
export function webSupplierIdOf(canonicalUrl: string): SupplierId {
  if (!isCanonicalListingUrl(canonicalUrl)) throw new Error("webSupplierIdOf: not a canonical https listing URL");
  const id = `supplier-w${base32Lower(hexToBytes(sha256Utf8(canonicalUrl).slice(2))).slice(0, 12)}`;
  if (!WEB_SUPPLIER_ID_RE.test(id)) throw new Error("webSupplierIdOf: produced an invalid id");
  return id;
}

/** The Supplier record of a web candidate (strictly parsed; throws on anything malformed). */
export function candidateToSupplier(facts: WebCandidateFacts): Supplier {
  if (!WEB_SUPPLIER_ID_RE.test(facts.supplierId)) throw new Error("candidateToSupplier: not a web supplier id");
  if (webSupplierIdOf(facts.listingUrl) !== facts.supplierId) throw new Error("candidateToSupplier: the id does not belong to the listing URL");
  const certificates = [...new Set((facts.certificates ?? []).map((c) => c.trim()))]
    .filter((c) => c.length > 0 && c.length <= CERT_TYPE_MAX)
    .map((type) => ({ type, issuer: WEB_CERT_ISSUER, ref: facts.supplierId, tier: "tier3" as const }));
  return Supplier.parse({
    supplierId: facts.supplierId,
    displayName: facts.displayName,
    country: facts.country,
    ids: facts.ids ?? {},
    listing: { url: facts.listingUrl, sourceType: facts.sourceType ?? "live", rawTextRef: facts.rawTextRef },
    offer: facts.offer,
    terms: { escrow: true, offPlatformDiscount: facts.offPlatformDiscount ?? false, payeeType: "company" },
    certificates,
    metrics: WEB_METRICS,
    xenditTest: { channel: WEB_SENTINEL_CHANNEL, accountNumber: WEB_SENTINEL_ACCOUNT, holderName: facts.displayName },
  });
}
