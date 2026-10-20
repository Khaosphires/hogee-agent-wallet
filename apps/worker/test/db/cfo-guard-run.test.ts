/**
 * cfo-guard pass bounds (audit run-9 lead 3 and its hardening note), on Postgres with a stub chain:
 *   - a pass that runs past its deadline sends nothing, reports `deadline` and traces it once per facility per day
 *     (the job lock is released instead of waiting on a slow RPC);
 *   - a refused proposal's DENY is traced once per line, reason and chain day, not on every pass;
 *   - (fixr-cfo, re-check LOW 5) a send's RPC calls count against the deadline: a send stuck on the chain stops there,
 *     its row is never signed, the proposals after it are not sent, and both are traced.
 * Needs TEST_DATABASE_URL.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPolicyContext } from '../../src/chain/context';
import { runCfoGuard, sendProposals, traceRefusal } from '../../src/jobs/cfo-guard';
import { Deadline } from '../../src/runtime/deadline';
import { DB_SETUP_TIMEOUT_MS, DB_URL, openTestDb, type TestDb } from '../support/db';
import { committed, rinaSnapshot, roles } from '../support/fixtures';

const log = { child: () => log, info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

describe.skipIf(!DB_URL)('cfo-guard pass bounds (Postgres)', () => {
  let t: TestDb;
  const facilityId = `fac-cfo-run-${Date.now()}`;
  const events = async (traceId: string) =>
    (await t.db.$client.query<{ kind: string; policy_verdict: string | null; reason_code: string | null }>('select kind, policy_verdict, reason_code from traces where facility_id = $1 and trace_id = $2 order by seq', [facilityId, traceId])).rows;
  const traceIds = async (like: string) =>
    (await t.db.$client.query<{ trace_id: string }>('select distinct trace_id from traces where facility_id = $1 and trace_id like $2', [facilityId, like])).rows.map((r) => r.trace_id);

  beforeAll(async () => {
    t = await openTestDb();
    // An open halt (another db file's) would end the pass before what this file checks.
    await t.db.$client.query('truncate hogee_worker.halts, hogee_worker.halt_events, hogee_worker.safety_pauses');
    await t.db.$client.query(
      `insert into facilities (facility_id, cap_minor, currency, reserve_floor_bps, lender_address, deployment_id, chain_id) values ($1, '1000', 'MYR', 300, $2, 'loop-1', 31337)`,
      [facilityId, `0x${'ab'.repeat(20)}`],
    );
  }, DB_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await t?.close();
  });

  it('a pass stuck on the chain stops at its deadline: nothing sent, status deadline, one trace per day', async () => {
    let sent = 0;
    const hanging = {
      estimateFeesPerGas: () => new Promise(() => undefined),
      sendRawTransaction: async () => void (sent += 1),
    } as never;
    const d = { db: t.db, client: hanging, log, config: { maxFeeWei: 1n }, signers: {}, deployment: {} } as never;
    const started = Date.now();
    const [r] = await runCfoGuard(d, [facilityId], { deadlineMs: 50 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ facilityId, tightened: [], status: 'deadline' });
    expect(sent).toBe(0);
    const [again] = await runCfoGuard(d, [facilityId], { deadlineMs: 50 });
    expect(again).toMatchObject({ status: 'deadline' });
    const ids = await traceIds('trace:cfo-guard:deadline:%');
    expect(ids).toHaveLength(1);
    expect((await events(ids[0] as string)).map((e) => e.kind)).toEqual(['ALERT']);
  });

  it('a refused proposal is traced once per line, reason and chain day', async () => {
    const d = { db: t.db, log } as never;
    const p = { facilityId, planVersion: 1 };
    const tight = { action: 'LOWER_WINDOW_CAP' as const, lineKey: 'ADS' as const, newValue: 52_500n, reason: 'Ads spent fast.' };
    const traceId = 'trace:cfo-guard:20000:ADS';
    expect(await traceRefusal(d, p, tight, traceId, 'NotAgent')).toBe('ADS: NotAgent');
    expect(await traceRefusal(d, p, tight, traceId, 'NotAgent')).toBe('ADS: NotAgent');
    expect(await events(traceId)).toEqual([{ kind: 'POLICY_VERDICT', policy_verdict: 'DENY', reason_code: 'NotAgent' }]);
    await traceRefusal(d, p, tight, traceId, 'AgentExpired'); // another reason the same day is a new denial
    await traceRefusal(d, p, tight, 'trace:cfo-guard:20001:ADS', 'NotAgent'); // the next chain day (a new trace id)
    expect((await events(traceId)).map((e) => e.reason_code)).toEqual(['NotAgent', 'AgentExpired']);
    expect(await events('trace:cfo-guard:20001:ADS')).toHaveLength(1);
  });

  it('a send stuck on the chain stops at the deadline: never signed, nothing after it sent, traced', async () => {
    const hanging = new Proxy({}, { get: () => () => new Promise(() => undefined) });
    const deployment = { deploymentId: 'loop-1', chainId: 31337, contracts: { Treasury: { address: `0x${'cd'.repeat(20)}` } } };
    const d = { db: t.db, client: hanging, log, config: { maxFeeWei: 10n ** 12n }, signers: { agent: privateKeyToAccount(generatePrivateKey()) }, deployment } as never;
    const snapshot = rinaSnapshot();
    const ctx = buildPolicyContext({ snapshot, committed, roles, mined: { usedIntents: new Set(), paidInvoices: new Set() } });
    const day = 30_000;
    const proposals = [
      { action: 'LOWER_WINDOW_CAP' as const, lineKey: 'ADS' as const, newValue: 52_500n, reason: 'Ads spent fast.' },
      { action: 'RAISE_RESERVE_BPS' as const, lineKey: null, newValue: 600n, reason: 'Tax payments used most of it.' },
    ];
    const started = Date.now();
    const r = await sendProposals(d, { facilityId, snapshot, ctx, day, planVersion: 1 } as never, proposals, Deadline.after(200));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ facilityId, tightened: [], status: 'deadline' });
    const acts = (await t.db.$client.query<{ id: string; raw_signed_tx: string | null; revert_reason: string | null }>(
      'select id, raw_signed_tx, revert_reason from chain_actions where facility_id = $1 and id like $2 order by id', [facilityId, `cfo-guard:${day}:%`])).rows;
    expect(acts.map((a) => a.id)).toEqual([`cfo-guard:${day}:ADS`]); // the reserve raise after it was never started
    expect(acts[0]?.raw_signed_tx).toBeNull();
    expect(acts[0]?.revert_reason).toMatch(/^REFUSED: .*deadline/);
    const kinds = (await events(`trace:cfo-guard:${day}:ADS`)).map((e) => [e.kind, e.policy_verdict]);
    expect(kinds).toEqual([['POLICY_VERDICT', 'AUTO'], ['ALERT', null]]);
  });
});

