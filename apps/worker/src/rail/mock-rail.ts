/**
 * MockRail (§9.1): the offline PayoutRail. Payouts live in hogee_worker.mock_payouts keyed by the idempotency key, so a
 * repeated request returns the original payout exactly like Xendit (and survives a worker restart), and a reused key
 * with a different amount, currency, destination or reference is refused like Xendit's DUPLICATE_ERROR. Xendit's
 * staged test failures are mirrored by destination account: …121212 → INVALID_DESTINATION, …123456 →
 * TEMPORARY_TRANSFER_ERROR, …999999 → a code that does not fit bytes32 (exercises the PAYOUT_FAILED mapping).
 * Everything else succeeds (or is PENDING until the first poll, with `pending`).
 */
import type { Pool } from 'pg';
import { rows } from '../store/pg';
import { WORKER_SCHEMA } from '../store/schema';
import { PayoutConflictError, payoutAccountRef, type PayoutRail, type PayoutRequest, type PayoutResult, type PayoutStatus } from './rail';

export const XENDIT_TEST_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  '121212': 'INVALID_DESTINATION',
  '123456': 'TEMPORARY_TRANSFER_ERROR',
  '999999': 'rejected-by-bank: recipient KYC',
});

export interface MockRailOptions {
  /** New payouts start PENDING and succeed on the first getPayout (exercises the poll path). */
  readonly pending?: boolean;
}

interface PayoutRow {
  payout_id: string;
  status: PayoutStatus;
  failure_code: string | null;
  reference_id: string;
  amount_minor: string;
  currency: string;
  destination: string;
}

const T = `${WORKER_SCHEMA}.mock_payouts`;
const COLS = 'payout_id, status, failure_code, reference_id, amount_minor::text as amount_minor, currency, destination';
const toResult = (r: PayoutRow): PayoutResult => ({ payoutId: r.payout_id, status: r.status, ...(r.failure_code ? { failureCode: r.failure_code } : {}) });

function stagedFailure(accountNumber: string): string | undefined {
  const suffix = Object.keys(XENDIT_TEST_FAILURES).find((s) => accountNumber.endsWith(s));
  return suffix ? XENDIT_TEST_FAILURES[suffix] : undefined;
}

export class MockRail implements PayoutRail {
  readonly name = 'mock';

  constructor(
    private readonly pool: Pool,
    private readonly opts: MockRailOptions = {},
  ) {}

  async requestPayout(req: PayoutRequest): Promise<PayoutResult> {
    if (req.amountMinor <= 0n) throw new RangeError('payout amount must be positive');
    if (req.idempotencyKey.length === 0 || req.idempotencyKey.length > 100) throw new RangeError('idempotency key must be 1-100 chars');
    const destination = payoutAccountRef(req.destination);
    const failure = stagedFailure(req.destination.accountNumber);
    const status: PayoutStatus = failure ? 'FAILED' : this.opts.pending ? 'PENDING' : 'SUCCEEDED';
    const payoutId = `mock-${req.idempotencyKey.replace(/^0x/, '').slice(0, 24)}`;
    const [created] = await rows<PayoutRow>(
      this.pool,
      `insert into ${T} (idempotency_key, payout_id, reference_id, amount_minor, currency, destination, status, failure_code)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (idempotency_key) do nothing returning ${COLS}`,
      [req.idempotencyKey, payoutId, req.referenceId, req.amountMinor.toString(), req.currency, destination, status, failure ?? null],
    );
    if (created) return toResult(created);
    const [existing] = await rows<PayoutRow>(this.pool, `select ${COLS} from ${T} where idempotency_key = $1`, [req.idempotencyKey]);
    if (!existing) throw new Error('mock payout vanished');
    const same =
      existing.amount_minor === req.amountMinor.toString() &&
      existing.currency === req.currency &&
      existing.destination === destination &&
      existing.reference_id === req.referenceId;
    if (!same) throw new PayoutConflictError('idempotency key reused with a different payout body');
    return toResult(existing);
  }

  async getPayout(payoutId: string): Promise<PayoutResult> {
    const [row] = await rows<PayoutRow>(
      this.pool,
      `update ${T} set status = case when status = 'PENDING' then 'SUCCEEDED' else status end where payout_id = $1 returning ${COLS}`,
      [payoutId],
    );
    if (!row) throw new Error(`unknown mock payout ${payoutId}`);
    return toResult(row);
  }

  async findPayout(key: { readonly idempotencyKey: string; readonly referenceId: string }): Promise<PayoutResult | null> {
    const [row] = await rows<PayoutRow>(this.pool, `select ${COLS} from ${T} where idempotency_key = $1`, [key.idempotencyKey]);
    return row ? toResult(row) : null;
  }
}
