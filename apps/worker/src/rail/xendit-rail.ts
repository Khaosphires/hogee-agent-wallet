/**
 * XenditRail (§9.1, task 1.12): the PayoutRail over Xendit Payouts API v2, TEST MODE ONLY.
 *
 * Followed (checked 2026-10-17): docs.xendit.co now documents only Payouts v3 (`api-version: 2025-09-01`), so the v2
 * shapes come from Xendit's official SDK references for v2: xendit-node docs/Payout.md, docs/payout/*.md and
 * payout/models/GetPayouts200ResponseDataInner.ts (status / failure_code enums), and xendit-go docs/PayoutApi.md.
 * Idempotency and the staged test values: docs.xendit.co/docs/test-scenarios-payouts.md; statuses:
 * docs.xendit.co/docs/payout-status-lifecycle.md.
 *   POST /v2/payouts            header `Idempotency-key`; body {reference_id, channel_code,
 *                               channel_properties{account_number, account_holder_name}, amount, currency, description,
 *                               metadata}; `amount` is a decimal number in MAJOR units (e.g. PHP 15000.05).
 *   GET  /v2/payouts/{id}       one payout.
 *   GET  /v2/payouts?reference_id=…   {data: Payout[], has_more, links}.
 *   Same key + same body → the original payout; same key + another body → DUPLICATE_ERROR (409).
 *
 * Status → PayoutStatus: ACCEPTED | REQUESTED | LOCKED → PENDING; SUCCEEDED; FAILED (failure_code kept raw);
 * CANCELLED / REVERSED → FAILED with that word as the code (final: never retried automatically). Anything else throws.
 *
 * Trust: a returned payout is compared with the request (reference, amount, currency, channel, account, holder name,
 * and our idempotency tag in metadata) before it is believed; any difference is a PayoutConflictError (settle.ts halts),
 * never a success. Transport errors, timeouts, 429 and 5xx throw XenditTransientError and mark nothing failed (the next
 * settle pass finds the payout by its key, or re-sends the same key). A 4xx means Xendit created no payout, so there is
 * no rail-backed failure to record: it throws XenditRailError with the raw error_code (settle.ts reports `error` and
 * retries, as with MockRail's RangeError). Only `xnd_development_` secret keys are accepted; the key lives in private
 * fields and is scrubbed from every error message.
 */
import { z } from 'zod';
import { isMockOnlyChannel } from './channels';
import { PayoutConflictError, type PayoutRail, type PayoutRequest, type PayoutResult } from './rail';

export const XENDIT_API_BASE = 'https://api.xendit.co';
export const XENDIT_SECRET_KEY_ENV = 'XENDIT_SECRET_KEY';
/**
 * Xendit's `amount` decimals per currency (IDR is whole rupiah). Hogee money is 1 BU = 100 minor for all (D16). SGD is
 * listed so that an SGD payout that ever reached this rail fails as a clean Xendit refusal, not a RangeError: the
 * router (route.ts) keeps every SG payout on MockRail, and requestPayout refuses SG_PAYNOW before any call.
 */
export const XENDIT_CURRENCY_DECIMALS: Readonly<Record<string, 0 | 2>> = Object.freeze({ MYR: 2, PHP: 2, IDR: 0, SGD: 2 });

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DESCRIPTION = 'Hogee settlement';
/** metadata field binding a Xendit payout to the idempotency key it was created under. */
const TAG = 'hogee_idempotency_key';
const LIST_LIMIT = 10;
const MINOR_PER_UNIT = 100n;
const DEV_KEY_RE = /^xnd_development_[A-Za-z0-9+/=_-]{20,200}$/;
const PAYOUT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type XenditFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface XenditRailOptions {
  /** A Xendit TEST-mode secret key (xnd_development_…). */
  readonly secretKey: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: XenditFetch;
  /** Defaults to https://api.xendit.co (https only; http only on loopback, for local doubles). */
  readonly baseUrl?: string;
  /** Per-call timeout (AbortSignal); default 15 s. */
  readonly timeoutMs?: number;
}

/** A bad rail configuration. Names the variable, never its value. */
export class XenditConfigError extends Error {
  override readonly name = 'XenditConfigError';
}

/** Xendit refused or answered something unusable. `code` is Xendit's raw error_code (or ours); `status` the HTTP status. */
export class XenditRailError extends Error {
  override readonly name: string = 'XenditRailError';
  readonly transient: boolean = false;
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Network failure, timeout, 429, 5xx or a garbled answer: retry later; the payout may or may not exist. */
export class XenditTransientError extends XenditRailError {
  override readonly name = 'XenditTransientError';
  override readonly transient = true;
}

/** The key, trimmed, if it is a Xendit test-mode secret key; else XenditConfigError (naming only the variable). */
export function assertXenditTestKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw new XenditConfigError(`${XENDIT_SECRET_KEY_ENV} is required when PAYOUT_RAIL=xendit`);
  if (key.startsWith('xnd_production_')) {
    throw new XenditConfigError(`${XENDIT_SECRET_KEY_ENV} is a live-mode (xnd_production_) key; only test-mode xnd_development_ secret keys are accepted`);
  }
  if (!DEV_KEY_RE.test(key)) throw new XenditConfigError(`${XENDIT_SECRET_KEY_ENV} must be a Xendit test-mode secret key (xnd_development_…)`);
  return key;
}

function decimalsOf(currency: string): 0 | 2 {
  const decimals = XENDIT_CURRENCY_DECIMALS[currency];
  if (decimals === undefined) throw new RangeError(`currency ${/^[A-Z]{3}$/.test(currency) ? currency : '(invalid)'} is not supported by the Xendit rail`);
  return decimals;
}

/** A Xendit `amount` in Hogee minor units, or null unless it is an exact non-negative amount in the currency's decimals. */
export function minorFromXendit(amount: unknown, currency: string): bigint | null {
  const decimals = XENDIT_CURRENCY_DECIMALS[currency];
  if (decimals === undefined) return null;
  const text = typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : typeof amount === 'string' ? amount.trim() : '';
  const m = /^([0-9]{1,16})(?:\.([0-9]{1,18}))?$/.exec(text);
  if (!m) return null;
  const fraction = (m[2] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) return null;
  return BigInt(m[1] ?? '0') * MINOR_PER_UNIT + BigInt(fraction.padEnd(2, '0'));
}

/** Hogee minor units → Xendit's major-unit `amount`, exactly (refused when a JSON number cannot carry it exactly). */
export function xenditAmount(amountMinor: bigint, currency: string): number {
  const decimals = decimalsOf(currency);
  if (amountMinor <= 0n) throw new RangeError('payout amount must be positive');
  const units = amountMinor / MINOR_PER_UNIT;
  const cents = amountMinor % MINOR_PER_UNIT;
  if (decimals === 0 && cents !== 0n) throw new RangeError(`${currency} payouts take whole units; the amount has a fraction`);
  const amount = Number(decimals === 0 ? units.toString() : `${units}.${cents.toString().padStart(2, '0')}`);
  if (minorFromXendit(amount, currency) !== amountMinor) throw new RangeError('payout amount cannot be sent exactly as a JSON number');
  return amount;
}

const Payout = z.object({
  id: z.string(),
  reference_id: z.string(),
  channel_code: z.string(),
  channel_properties: z.object({ account_number: z.string(), account_holder_name: z.string().nullish() }),
  amount: z.union([z.number(), z.string()]),
  currency: z.string(),
  status: z.string(),
  failure_code: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
type XenditPayout = z.infer<typeof Payout>;

const PayoutList = z.union([z.array(z.unknown()), z.object({ data: z.array(z.unknown()), has_more: z.boolean().nullish() })]);
const ErrorBody = z.object({ error_code: z.string().optional(), message: z.string().optional() });

const holderOf = (name: string) => name.trim().replace(/\s+/g, ' ').toUpperCase();
const tagOf = (p: XenditPayout): unknown => p.metadata?.[TAG];
const printable = (text: string, max: number) => text.replace(/[^\x20-\x7E]+/g, ' ').slice(0, max);

/** The interface's answer for a Xendit payout. Unknown statuses throw: they are never guessed into success or failure. */
function toResult(p: XenditPayout): PayoutResult {
  switch (p.status) {
    case 'SUCCEEDED':
      return { payoutId: p.id, status: 'SUCCEEDED' };
    case 'ACCEPTED':
    case 'REQUESTED':
    case 'LOCKED':
      return { payoutId: p.id, status: 'PENDING' };
    case 'FAILED': {
      const code = p.failure_code ? printable(p.failure_code, 100).trim() : '';
      return { payoutId: p.id, status: 'FAILED', ...(code ? { failureCode: code } : {}) };
    }
    case 'CANCELLED':
    case 'REVERSED':
      return { payoutId: p.id, status: 'FAILED', failureCode: p.status };
    default:
      throw new XenditRailError(`Xendit payout ${p.id} has an unknown status`, 'UNKNOWN_STATUS');
  }
}

/** Fields of a returned payout that differ from the request (names only; values may be account numbers). */
function differences(p: XenditPayout, req: PayoutRequest): string[] {
  const holder = p.channel_properties.account_holder_name;
  const tag = tagOf(p);
  return [
    p.reference_id !== req.referenceId && 'reference_id',
    p.currency !== req.currency && 'currency',
    minorFromXendit(p.amount, req.currency) !== req.amountMinor && 'amount',
    p.channel_code !== req.destination.channel && 'channel_code',
    p.channel_properties.account_number !== req.destination.accountNumber && 'account_number',
    holder != null && holderOf(holder) !== holderOf(req.destination.holderName) && 'account_holder_name',
    tag !== undefined && tag !== null && tag !== req.idempotencyKey && 'metadata',
  ].filter((d): d is string => typeof d === 'string');
}

function checkKey(key: string, referenceId: string): void {
  if (!/^[\x21-\x7E]{1,100}$/.test(key)) throw new RangeError('idempotency key must be 1-100 printable chars');
  if (!/^[\x20-\x7E]{1,255}$/.test(referenceId)) throw new RangeError('reference id must be 1-255 printable chars');
}

function baseUrlOf(raw: string | undefined): string {
  if (raw === undefined) return XENDIT_API_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new XenditConfigError('the Xendit base URL is not a URL');
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!ok || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new XenditConfigError('the Xendit base URL must be an https origin (http only on loopback)');
  }
  return url.origin;
}

/** Why a fetch rejected, as an error name and a system code only (never the free-text message). */
function transportReason(error: unknown): string {
  const raw = (error as { name?: unknown } | null)?.name;
  const name = typeof raw === 'string' && /^[A-Za-z]{1,40}$/.test(raw) ? raw : 'Error';
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && ERROR_CODE_RE.test(code) ? `${name} ${code}` : name;
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly route: string;
  readonly method: string;
}

export class XenditRail implements PayoutRail {
  readonly name = 'xendit';
  readonly #auth: string;
  readonly #secrets: readonly string[];
  readonly #fetch: XenditFetch;
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(opts: XenditRailOptions) {
    const key = assertXenditTestKey(opts.secretKey);
    const token = Buffer.from(`${key}:`).toString('base64');
    this.#auth = `Basic ${token}`;
    this.#secrets = [key, token];
    this.#fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#base = baseUrlOf(opts.baseUrl);
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) throw new XenditConfigError('the Xendit timeout must be 1-120000 ms');
    this.#timeoutMs = timeout;
  }

  /** What a log or a JSON dump of the deps may show. */
  toJSON(): { name: string; baseUrl: string } {
    return { name: this.name, baseUrl: this.#base };
  }

  async requestPayout(req: PayoutRequest): Promise<PayoutResult> {
    checkKey(req.idempotencyKey, req.referenceId);
    const { channel, accountNumber, holderName } = req.destination;
    if (!channel || !accountNumber || !holderName) throw new RangeError('payout destination is incomplete');
    // SG-DECISIONS: PayNow (and the demo MOCK_ONLY accounts) are simulated on MockRail; never sent to Xendit.
    if (isMockOnlyChannel(channel)) throw new XenditRailError(`payout channel ${channel} is simulated on MockRail and never sent to Xendit`, 'CHANNEL_NOT_ON_XENDIT');
    const body = {
      reference_id: req.referenceId,
      channel_code: channel,
      channel_properties: { account_number: accountNumber, account_holder_name: holderName },
      amount: xenditAmount(req.amountMinor, req.currency),
      currency: req.currency,
      description: DESCRIPTION,
      metadata: { [TAG]: req.idempotencyKey },
    };
    const res = await this.#call('POST', '/v2/payouts', '/v2/payouts', { idempotencyKey: req.idempotencyKey, body });
    if (res.status >= 400 && res.status < 500 && (res.status === 409 || this.#errorOf(res.body).code === 'DUPLICATE_ERROR')) {
      throw new PayoutConflictError('Xendit refused the idempotency key: it was already used with another payout body');
    }
    const payout = this.#payoutOf(res);
    const diff = differences(payout, req);
    if (diff.length > 0) throw new PayoutConflictError(`Xendit returned a payout that differs from the request (${diff.join(', ')}); not trusted`);
    return toResult(payout);
  }

  async getPayout(payoutId: string): Promise<PayoutResult> {
    if (!PAYOUT_ID_RE.test(payoutId)) throw new XenditRailError('not a Xendit payout id', 'INVALID_PAYOUT_ID');
    const payout = this.#payoutOf(await this.#call('GET', `/v2/payouts/${encodeURIComponent(payoutId)}`, '/v2/payouts/{id}'));
    if (payout.id !== payoutId) throw new XenditRailError('Xendit answered with another payout', 'PAYOUT_ID_MISMATCH');
    return toResult(payout);
  }

  async findPayout(key: { readonly idempotencyKey: string; readonly referenceId: string }): Promise<PayoutResult | null> {
    checkKey(key.idempotencyKey, key.referenceId);
    const path = `/v2/payouts?reference_id=${encodeURIComponent(key.referenceId)}&limit=${LIST_LIMIT}`;
    const res = await this.#call('GET', path, '/v2/payouts?reference_id');
    if (res.status === 404) return null;
    this.#ok(res);
    const list = PayoutList.safeParse(res.body);
    if (!list.success) throw new XenditTransientError('Xendit GET /v2/payouts?reference_id returned an unreadable list', 'MALFORMED_RESPONSE', res.status);
    const items = Array.isArray(list.data) ? list.data : list.data.data;
    const hasMore = !Array.isArray(list.data) && list.data.has_more === true;
    const ours = items.map((item) => this.#parse(item, res)).filter((p) => p.reference_id === key.referenceId);
    if (hasMore || ours.length > 1) throw new PayoutConflictError('more than one Xendit payout carries this attempt reference');
    const [payout] = ours;
    if (!payout) return null;
    const tag = tagOf(payout);
    if (tag !== undefined && tag !== null && tag !== key.idempotencyKey) {
      throw new PayoutConflictError('the Xendit payout for this attempt reference was created under another idempotency key');
    }
    return toResult(payout);
  }

  async #call(method: 'GET' | 'POST', path: string, route: string, opts: { idempotencyKey?: string; body?: unknown } = {}): Promise<Answer> {
    const headers: Record<string, string> = { Authorization: this.#auth, Accept: 'application/json' };
    if (opts.idempotencyKey !== undefined) headers['Idempotency-key'] = opts.idempotencyKey;
    const init: RequestInit = { method, headers, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let text: string;
    let status: number;
    try {
      const res = await this.#fetch(`${this.#base}${path}`, init);
      status = res.status;
      text = await res.text();
    } catch (error: unknown) {
      throw new XenditTransientError(`Xendit ${method} ${route} failed in transport (${transportReason(error)})`, 'TRANSPORT_ERROR');
    }
    let body: unknown;
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }
    return { status, body, route, method };
  }

  /** error_code (when it looks like one) and a printable, secret-free, bounded message. */
  #errorOf(body: unknown): { code: string | undefined; message: string } {
    const parsed = ErrorBody.safeParse(body);
    if (!parsed.success) return { code: undefined, message: '' };
    const code = parsed.data.error_code && ERROR_CODE_RE.test(parsed.data.error_code) ? parsed.data.error_code : undefined;
    let message = parsed.data.message ?? '';
    for (const secret of this.#secrets) message = message.split(secret).join('[redacted]');
    message = message.replace(/xnd_[A-Za-z0-9+/=_-]*/g, '[redacted]');
    return { code, message: printable(message, 160).trim() };
  }

  /** Throws unless 2xx: 429 / 5xx transient, any other status a XenditRailError with Xendit's raw error_code. */
  #ok(res: Answer): void {
    if (res.status >= 200 && res.status < 300) return;
    const { code, message } = this.#errorOf(res.body);
    const what = `Xendit ${res.method} ${res.route} → HTTP ${res.status} ${code ?? 'no error_code'}${message ? `: ${message}` : ''}`;
    const errorCode = code ?? `HTTP_${res.status}`;
    if (res.status === 429 || res.status === 408 || res.status >= 500) throw new XenditTransientError(what, errorCode, res.status);
    throw new XenditRailError(what, errorCode, res.status);
  }

  #parse(item: unknown, res: Answer): XenditPayout {
    const parsed = Payout.safeParse(item);
    if (!parsed.success || !PAYOUT_ID_RE.test(parsed.data.id)) {
      throw new XenditTransientError(`Xendit ${res.method} ${res.route} returned an unreadable payout`, 'MALFORMED_RESPONSE', res.status);
    }
    return parsed.data;
  }

  #payoutOf(res: Answer): XenditPayout {
    this.#ok(res);
    return this.#parse(res.body, res);
  }
}

/**
 * The rail the worker runs with PAYOUT_RAIL=xendit: XENDIT_SECRET_KEY is read once and, with `scrub`, deleted from the
 * env object whatever happens, so a later env dump or child process never sees it.
 */
export function xenditRailFromEnv(env: Record<string, string | undefined>, opts: Omit<XenditRailOptions, 'secretKey'> & { readonly scrub?: boolean } = {}): XenditRail {
  const { scrub, ...rest } = opts;
  try {
    return new XenditRail({ ...rest, secretKey: env[XENDIT_SECRET_KEY_ENV] ?? '' });
  } finally {
    if (scrub) delete env[XENDIT_SECRET_KEY_ENV];
  }
}
