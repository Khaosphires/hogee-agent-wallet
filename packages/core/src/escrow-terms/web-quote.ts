/**
 * SupplierApproval.quoteHash of a web supplier's confirmed terms (VISION-DECISIONS §9): every fact the founder confirmed,
 * by kind "WEB_TERMS". One pure preimage builder for the live API (supplier-terms.ts confirm, signing/web-order.ts
 * prepare and finalize) and the mock (features/orders.ts), so the two can never commit to different facts (re-check
 * keccak LOW 3: the mock used to leave out shortlistHash). Hash = keccak256(utf8(JCS(preimage))) (core hashObject).
 */
import { hashObject } from "../hash/index";
import type { Hex32 } from "../schemas/primitives";
import type { MilestoneTrigger } from "./constants";

export interface WebQuote {
  readonly termsId: string;
  readonly supplierId: string;
  /** The candidate's search: its stored Shortlist's shortlistHash (scorer shortlistHashOf), the one SupplierApproval signs. */
  readonly shortlistHash: string;
  readonly chosenIndex: number;
  readonly currency: string;
  readonly totalMinor: string;
  readonly milestones: readonly { readonly bps: number; readonly trigger: MilestoneTrigger }[];
  readonly payeeType: string;
  readonly payoutAccountHash: string;
}

/** The WEB_TERMS preimage: fixed key set, hashes lowercased, milestones reduced to {bps, trigger} in order. */
export function webQuotePreimage(w: WebQuote): Record<string, unknown> {
  return {
    kind: "WEB_TERMS",
    termsId: w.termsId,
    supplierId: w.supplierId,
    shortlistHash: w.shortlistHash.toLowerCase(),
    chosenIndex: w.chosenIndex,
    currency: w.currency,
    totalMinor: w.totalMinor,
    milestones: w.milestones.map((m) => ({ bps: m.bps, trigger: m.trigger })),
    payeeType: w.payeeType,
    payoutAccountHash: w.payoutAccountHash.toLowerCase(),
  };
}

/** keccak256(utf8(JCS(webQuotePreimage(w)))). */
export function webQuoteHash(w: WebQuote): Hex32 {
  return hashObject(webQuotePreimage(w));
}
