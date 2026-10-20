/**
 * Payout forms the founder could be talked into by a supplier page or message (VISION-DECISIONS §9 "Terms"). The
 * account only ever arrives through POST /api/orders/terms; these are the refusals that form must give, each with its
 * exact TERMS_* reason (v-terms: content codes 422, a sanctions hit 403, unscreenable 503).
 * Every account number is synthetic: 1000000101-style for the honest supplier, 9900000NNN for an attacker.
 */
import type { PayoutAccountInput, TermsErrorCode } from "@hogee/core";

export const HONEST_ACCOUNT = "1000000101";
export const ATTACKER_ACCOUNT = "9900000413";
const BANK = "Recorded Sample Bank";

/** The honest form: the holder is the seller name the Reader read, verbatim; a company payee. */
export const honestPayout = (seller: string, accountNumber: string = HONEST_ACCOUNT): PayoutAccountInput => ({ holderName: seller, bankName: BANK, accountNumber, payeeType: "company" });

export interface PayoutAttack {
  readonly name: string;
  readonly story: string;
  readonly payout: PayoutAccountInput;
  /** null: the route's schema refuses it (422 VALIDATION) before the service runs. */
  readonly expected: TermsErrorCode | null;
  readonly status: number;
}

/** Form attacks against `seller` (each refused before any row is stored). Order of checks: v-terms confirmTerms. */
export function payoutAttacks(seller: string): PayoutAttack[] {
  const honest = honestPayout(seller, ATTACKER_ACCOUNT);
  return [
    { name: "personal-account", story: 'the page\'s "pay our sales manager\'s personal account"', payout: { ...honest, holderName: "Li Wei", payeeType: "personal" }, expected: "TERMS_PAYEE_PERSONAL", status: 422 },
    { name: "other-company", story: "a different company's account", payout: { ...honest, holderName: "Harbourline Trading Pte. Ltd." }, expected: "TERMS_HOLDER_MISMATCH", status: 422 },
    { name: "person-as-company", story: "a person's name declared as a company", payout: { ...honest, holderName: "Li Wei" }, expected: "TERMS_HOLDER_MISMATCH", status: 422 },
    { name: "generic-words-only", story: "a company sharing only a province name and generic words with the seller", payout: { ...honest, holderName: genericTwin(seller) }, expected: "TERMS_HOLDER_MISMATCH", status: 422 },
    { name: "dashed-account", story: "an account number with dashes and letters", payout: { ...honest, accountNumber: "99-0000-0413" }, expected: null, status: 422 },
  ];
}

/** Province + the seller's generic product words + a designator, without its distinctive name ("Tidelume"). */
export function genericTwin(seller: string): string {
  const words = seller.replace(/,?\s*(Co\.,?\s*Ltd\.?|Ltd\.?|Pte\.?\s*Ltd\.?)$/i, "").split(/\s+/);
  const [province, , ...rest] = words;
  return `${[province, ...rest].filter(Boolean).join(" ")} Co., Ltd.`;
}

/**
 * The seller's name as a sanctions list could carry it: Cyrillic look-alike letters (а, е, о) and another company
 * designator. The real screening folds look-alikes and drops designators, so the plain seller name must hit it.
 */
export function lookalikeListing(seller: string): string {
  const base = seller.replace(/,?\s*(Co\.,?\s*Ltd\.?|Ltd\.?)$/i, "").toUpperCase();
  return `${base.replace(/A/g, "А").replace(/E/g, "Е").replace(/O/g, "О")} CORPORATION`;
}
