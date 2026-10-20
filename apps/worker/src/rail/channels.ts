/**
 * Payout channels (SG-DECISIONS "Payout rail", 18 Oct 23:35): which rail may pay a payee, keyed by the channel of the
 * payout account the founder signed the hash of, and the currencies a payout on that channel may carry.
 *
 *   MY_DUITNOW  MYR       Xendit test mode when PAYOUT_RAIL=xendit, MockRail otherwise (Rina, Malaysia).
 *   SG_PAYNOW   SGD       MockRail ALWAYS, labelled "simulated PayNow payout". Xendit has no PayNow payouts and the
 *                         Xendit integration is MYR/PHP/IDR only, so no Singapore payout is ever real or sent to Xendit.
 *   MOCK_ONLY   MYR, SGD  MockRail always: the demo supplier catalog's "DO NOT PAY" accounts (data/suppliers/demo).
 *
 * Account numbers: a bank account is 4-34 digits (MY_DUITNOW, MOCK_ONLY, and any channel not in the table, which the
 * router then refuses); a PayNow account is a proxy: a UEN (the demo payees use synthetic "S99ZZ…" UENs, P1 18 Oct)
 * or a +65 mobile, upper case, no separators, the form the hash was signed over.
 *
 * Anything else is refused (route.ts), never guessed into a rail. No imports: xendit-rail.ts reads this table too.
 */

export type RailKind = 'xendit' | 'mock';

export interface PayoutChannel {
  /** ISO 4217 codes a payout on this channel may carry (the facility currency must be one of them). */
  readonly currencies: readonly string[];
  /** 'xendit': Xendit test mode when the worker runs with PAYOUT_RAIL=xendit, else MockRail. 'mock': MockRail always. */
  readonly rail: RailKind;
  /** Shown with every payout on this channel (the PAYOUT trace, so the evidence and the UI carry it). */
  readonly label?: string;
  /** The account number's canonical form on this channel. */
  readonly accountNumber: RegExp;
}

export const SIMULATED_PAYNOW_LABEL = 'simulated PayNow payout';

/** A bank account number: 4-34 digits. */
export const BANK_ACCOUNT_RE = /^[0-9]{4,34}$/;
/**
 * A PayNow proxy: a UEN (8 digits + letter; 9 digits + letter; or T/S/R + 2 digits + 2-letter entity type + 4 digits
 * + letter) or an SG mobile (+65, then 8 digits from 8 or 9).
 */
export const PAYNOW_PROXY_RE = /^(?:[0-9]{8}[A-Z]|[0-9]{9}[A-Z]|[STR][0-9]{2}[A-Z]{2}[0-9]{4}[A-Z]|\+65[89][0-9]{7})$/;

const channel = (c: PayoutChannel): PayoutChannel => Object.freeze({ ...c, currencies: Object.freeze([...c.currencies]) });

export const PAYOUT_CHANNELS: Readonly<Record<string, PayoutChannel>> = Object.freeze({
  MY_DUITNOW: channel({ currencies: ['MYR'], rail: 'xendit', accountNumber: BANK_ACCOUNT_RE }),
  SG_PAYNOW: channel({ currencies: ['SGD'], rail: 'mock', label: SIMULATED_PAYNOW_LABEL, accountNumber: PAYNOW_PROXY_RE }),
  MOCK_ONLY: channel({ currencies: ['MYR', 'SGD'], rail: 'mock', accountNumber: BANK_ACCOUNT_RE }),
});

/** The channel's entry, or undefined (own keys only: "constructor" or "__proto__" is not a channel). */
export function payoutChannelOf(code: string): PayoutChannel | undefined {
  return Object.hasOwn(PAYOUT_CHANNELS, code) ? PAYOUT_CHANNELS[code] : undefined;
}

/** The account number form of a channel: its own, else a bank account (an unknown channel is refused by the router). */
export function accountNumberPattern(code: string): RegExp {
  return payoutChannelOf(code)?.accountNumber ?? BANK_ACCOUNT_RE;
}

/**
 * True for a channel the table keeps on MockRail (SG_PAYNOW, MOCK_ONLY): XenditRail refuses these destinations before
 * any call, so even a XenditRail used without the router never sends a PayNow payout to Xendit. The router (route.ts)
 * is the fail-closed gate for unknown channels.
 */
export function isMockOnlyChannel(code: string): boolean {
  return payoutChannelOf(code)?.rail === 'mock';
}
