/**
 * PayoutRouter (SG-DECISIONS "Payout rail"): settle-spend asks it for the rail that pays one settlement, by the payee
 * account's channel (channels.ts) and the facility currency. Singapore payees (SG_PAYNOW) and the demo supplier
 * accounts (MOCK_ONLY) always get MockRail; MY_DUITNOW gets Xendit test mode when the worker has one, else MockRail.
 *
 * Fail closed: an unknown channel, a currency the channel does not carry, or a payee with no readable account is a
 * PayoutRouteError before any rail is called, so nothing is paid or attested (settle.ts traces one ALERT and reports
 * the row as an error every pass until an operator fixes the payee).
 *
 * The channel is a field of the account whose hash the chain binds (rail.ts), so a DB writer cannot re-route a payout
 * without failing the binding check; the currency is the facilities row, which this cross-check also bounds.
 */
import type { Pool } from 'pg';
import { payoutChannelOf } from './channels';
import { MockRail } from './mock-rail';
import type { PayoutRail } from './rail';
import { XenditRail } from './xendit-rail';

export interface PayoutRoute {
  readonly channel: string;
  readonly currency: string;
}

export interface RoutedRail {
  readonly rail: PayoutRail;
  /** e.g. "simulated PayNow payout": every PAYOUT trace of this payout carries it. */
  readonly label?: string;
}

export type PayoutRouteRefusal = 'UNKNOWN_CHANNEL' | 'CURRENCY_MISMATCH' | 'NO_ACCOUNT';

export class PayoutRouteError extends Error {
  override readonly name = 'PayoutRouteError';
  constructor(
    message: string,
    readonly code: PayoutRouteRefusal,
  ) {
    super(message);
  }
}

/** A channel or currency as it may appear in a message: the code shape only, never free text. */
const shown = (v: string, re: RegExp): string => (re.test(v) ? v : '(invalid)');
const CHANNEL_RE = /^[A-Z0-9_]{1,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export class PayoutRouter {
  readonly name: string;
  readonly #mock: PayoutRail;
  readonly #xendit: PayoutRail | undefined;

  constructor(rails: { readonly mock: PayoutRail; readonly xendit?: PayoutRail }) {
    this.#mock = rails.mock;
    this.#xendit = rails.xendit;
    this.name = rails.xendit ? `${rails.xendit.name}+${rails.mock.name}` : rails.mock.name;
  }

  /** The rail (and label) for one payout, or PayoutRouteError. */
  route(route: PayoutRoute): RoutedRail {
    const channel = payoutChannelOf(route.channel);
    if (!channel) throw new PayoutRouteError(`payout channel ${shown(route.channel, CHANNEL_RE)} has no rail: nothing is paid`, 'UNKNOWN_CHANNEL');
    if (!channel.currencies.includes(route.currency)) {
      throw new PayoutRouteError(`payout channel ${route.channel} does not carry ${shown(route.currency, CURRENCY_RE)}: nothing is paid`, 'CURRENCY_MISMATCH');
    }
    const rail = channel.rail === 'xendit' && this.#xendit ? this.#xendit : this.#mock;
    return { rail, ...(channel.label ? { label: channel.label } : {}) };
  }

  toJSON(): { name: string } {
    return { name: this.name };
  }
}

/**
 * settle-spend's router for JobDeps.rail: a router as is; a bare XenditRail (a caller that predates routing) keeps
 * SG_PAYNOW and MOCK_ONLY on a MockRail over `pool`; any other rail (MockRail, a test double) serves every route.
 */
export function payoutRouterOf(rail: PayoutRail | PayoutRouter | undefined, pool: Pool): PayoutRouter {
  if (rail instanceof PayoutRouter) return rail;
  if (rail instanceof XenditRail) return new PayoutRouter({ mock: new MockRail(pool), xendit: rail });
  return new PayoutRouter({ mock: rail ?? new MockRail(pool) });
}
