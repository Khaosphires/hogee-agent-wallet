/**
 * The relay and Treasury.pause (re-check A-1 related, A-3). The officer's or founder's pause (POST /api/control/pause)
 * is signed with the LENDER key first, the agent key only as a fallback: the agent key's nonces queue behind every
 * agent spend in flight, and the safety pause already orders its signers this way. The safety pause's own attempt rows
 * (`safety-pause:<request>:<n>`) are reconcile's alone (lender first, at MAX_SAFETY_FEE): the relay never takes them.
 * Fake pool (the relay's pending query honours the SQL's safety-pause exclusion); only sendAction and the mirror sync
 * are replaced.
 */
import { buildPause, type TxSigner } from '@hogee/chain';
import type { Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendAction } from '../../src/chain/actions';
import type { JobDeps } from '../../src/jobs/deps';
import { runRelay } from '../../src/jobs/relay';
import { RELAY_BUILDERS } from '../../src/jobs/relay-calls';
import { silentLogger } from '../../src/runtime/log';

vi.mock('../../src/chain/actions', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../src/chain/actions')>()), sendAction: vi.fn() }));
vi.mock('../../src/jobs/sync', () => ({ syncFacility: vi.fn(async () => undefined) }));

const TX = `0x${'ab'.repeat(32)}` as Hex;
const lender = { address: `0x${'11'.repeat(20)}` } as unknown as TxSigner;
const agent = { address: `0x${'22'.repeat(20)}` } as unknown as TxSigner;

/** Unsigned PENDING Treasury.pause rows by id; the pending query leaves a safety-pause attempt out only if its SQL does. */
function relayPool(ids: readonly string[]) {
  const queries: string[] = [];
  const pool = {
    async query(text: string) {
      queries.push(text);
      if (text.includes('from chain_actions') && text.includes('request_json')) {
        const taken = ids.filter((id) => !(id.startsWith('safety-pause:') && text.includes("id not like 'safety-pause:%'")));
        return { rows: taken.map((id) => ({ id, kind: 'Treasury.pause', ref_id: id.startsWith('safety-pause:') ? 'orphan:0x1:0' : 'fac-a', request_json: {} })) };
      }
      if (text.includes('.halts')) return { rows: [] }; // not halted
      if (text.includes('traces')) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { pool, queries };
}

const depsOf = (pool: unknown): JobDeps =>
  ({
    db: { $client: pool },
    client: {},
    log: silentLogger,
    signers: { lender, agent },
    config: { maxFeeWei: 1n },
    deployment: { chainId: 31337, contracts: { Treasury: { address: `0x${'cd'.repeat(20)}` } } },
  }) as unknown as JobDeps;

beforeEach(() => {
  vi.mocked(sendAction).mockReset();
  vi.mocked(sendAction).mockResolvedValue({ stored: { nonce: 7n, txHash: TX }, sent: { status: 'accepted' } } as never);
});

describe('A-3: the officer’s or founder’s pause is signed with the lender key first', () => {
  it('the pause plan: lender, the agent only as a fallback (Treasury._requireTightener lets the lender pause)', async () => {
    expect(await RELAY_BUILDERS['Treasury.pause']?.({} as never)).toEqual({ role: 'lender', call: buildPause(), fallback: 'agent' });
  });

  it('the relay signs it with the lender key; the agent key only when the lender’s send fails', async () => {
    const { pool } = relayPool(['act-pause-1']);
    const [first] = await runRelay(depsOf(pool), ['fac-a']);
    expect(first?.actions).toEqual([{ actionId: 'act-pause-1', kind: 'Treasury.pause', result: 'sent', detail: TX }]);
    expect(vi.mocked(sendAction).mock.calls.map((c) => c[2])).toEqual([lender]);

    vi.mocked(sendAction).mockReset();
    vi.mocked(sendAction)
      .mockRejectedValueOnce(new Error('insufficient funds for gas'))
      .mockResolvedValueOnce({ stored: { nonce: 8n, txHash: TX }, sent: { status: 'accepted' } } as never);
    const [second] = await runRelay(depsOf(pool), ['fac-a']);
    expect(second?.actions.map((a) => a.result)).toEqual(['sent']);
    expect(vi.mocked(sendAction).mock.calls.map((c) => c[2])).toEqual([lender, agent]);
  });
});

describe("A-1 related: a safety-pause attempt is reconcile's alone", () => {
  it('the relay never takes a safety-pause:<request>:<n> row; the officer pause next to it is relayed', async () => {
    const { pool } = relayPool(['safety-pause:orphan:0x1:0:1', 'act-pause-1']);
    const [report] = await runRelay(depsOf(pool), ['fac-a']);
    expect(report?.actions.map((a) => a.actionId)).toEqual(['act-pause-1']);
    expect(vi.mocked(sendAction).mock.calls.map((c) => c[1].id)).toEqual(['act-pause-1']);
  });

  it('with only a safety-pause attempt pending, the relay signs nothing', async () => {
    const { pool } = relayPool(['safety-pause:orphan:0x1:0:1']);
    const [report] = await runRelay(depsOf(pool), ['fac-a']);
    expect(report?.actions).toEqual([]);
    expect(vi.mocked(sendAction)).not.toHaveBeenCalled();
  });
});
