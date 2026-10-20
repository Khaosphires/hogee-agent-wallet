/**
 * Payout rail label (SG-DECISIONS, sg-research-b: payout rail). Every Singapore payee is an SG_PAYNOW payee, and SG
 * payouts go through the worker's MockRail: Hogee never sends a real PayNow transfer, so the UI says so wherever
 * payments or payees are listed, in the app's one word for "not real" (P1, UX round 3: "Sample payout (PayNow)"; the
 * worker and the evidence keep their own "simulated PayNow payout" wording, SG-DECISIONS). Payments carry no payee
 * channel, so this UI rule keys on the facility currency: an SGD facility has only SG_PAYNOW payees (MEI_IDS, the API
 * payee catalog). Other facilities get no label here (Malaysia keeps its own test-mode rail, and nothing is claimed).
 */
export const SIMULATED_PAYNOW_PAYOUT = "Sample payout (PayNow)";

const SG_PAYNOW_FACILITY_CURRENCY = "SGD";

export function payoutRailLabel(facilityCurrency: string | undefined): string | undefined {
  return facilityCurrency === SG_PAYNOW_FACILITY_CURRENCY ? SIMULATED_PAYNOW_PAYOUT : undefined;
}
