/**
 * Re-check A-2: an agent spend signed while the officer's (or founder's) Treasury.pause is still on its way gets an
 * earlier agent nonce than nothing stops, and is mined before the pause. So before the AGENT key signs a payment,
 * every agent-key payment path (agent-actions' sendPayment, pacing's signAndSend) refuses while a Treasury.pause of
 * this deployment is PENDING, BROADCAST or INCLUDED without a revert: nothing is signed and the row waits for the next
 * pass, as while halted. The relayer's founder-signed payments are not held back. Fake pool: no halt, and the pending
 * pause query answers from `pending`; any signing step after the gate fails loudly on the fake db.
 */
import { buildPause, type TxSigner } from '@hogee/chain';
import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { JobDeps } from '../../src/jobs/deps';
import { failureOf, sendPayment } from '../../src/jobs/agent-actions-sign';
import type { PaymentRow } from '../../src/jobs/inflight';
import { signAndSend } from '../../src/jobs/pacing';
import { silentLogger } from '../../src/runtime/log';
import { PausePendingError } from '../../src/store/pause-pending';

const DEPLOYMENT = { deploymentId: 'final-2', chainId: 11155111, contracts: { Treasury: { address: `0x${'cd'.repeat(20)}` } } };

function world(pending: readonly string[]) {
  const pauseChecks: unknown[][] = [];
  const pool = {
    async query(text: string, values: unknown[] = []) {
      if (text.includes('.halts')) return { rows: [] };
      if (text.includes("kind = 'Treasury.pause'")) {
        pauseChecks.push(values);
        return { rows: pending.slice(0, 1).map((id) => ({ id })) };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const signTransaction = vi.fn(async () => {
    throw new Error('must not sign');
  });
  const signer = { address: `0x${'22'.repeat(20)}`, signTransaction } as unknown as TxSigner;
  const d = { db: { $client: pool }, client: {}, log: silentLogger, signers: { agent: signer, relayer: signer }, config: { maxFeeWei: 1n }, deployment: DEPLOYMENT } as unknown as JobDeps;
  return { d, signer, signTransaction, pauseChecks };
}

const spec = (signer: TxSigner, role: 'agent' | 'relayer') => ({
  facilityId: 'fac-a',
  paymentId: 'proposal:a',
  call: buildPause(),
  signer,
  role,
  planId: `0x${'0a'.repeat(32)}` as Hex,
  traceId: 'trace:proposal:a',
});

const pacingRow: PaymentRow = {
  id: 'pacing:ADS:20380',
  kind: 'SPEND',
  state: 'POLICY_OK',
  lineKey: 'ADS',
  payeeId: 'shopee-ads',
  amountMinor: '7500',
  intentId: `0x${'0b'.repeat(32)}`,
  invoiceHash: `0x${'0'.repeat(63)}1`,
  planVersion: 1,
  decisionId: '0192f3a0-0000-7000-8000-000000000001',
  rationaleHash: `0x${'0c'.repeat(32)}`,
  signed: false,
  txHash: null,
  supersededTxHashes: [],
  block: null,
};
const committed = { planId: `0x${'0a'.repeat(32)}` as Hex } as never;

describe('A-2: no agent-key payment is signed while a Treasury.pause is pending', () => {
  it('agent-actions (sendPayment, agent key): refuses with PausePendingError, nothing signed; asked for this deployment', async () => {
    const { d, signer, signTransaction, pauseChecks } = world(['act-pause-1']);
    const sent = sendPayment(d, spec(signer, 'agent'));
    await expect(sent).rejects.toBeInstanceOf(PausePendingError);
    await expect(sent).rejects.toThrow(/act-pause-1/);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(pauseChecks).toEqual([[DEPLOYMENT.deploymentId, DEPLOYMENT.chainId]]);
  });

  it('pacing (signAndSend, agent key): throws PausePendingError before anything is signed', async () => {
    const { d, signTransaction } = world(['act-pause-1']);
    await expect(signAndSend(d, { facilityId: 'fac-a', committed, row: pacingRow })).rejects.toBeInstanceOf(PausePendingError);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it('a refused send is a deferral (retried next pass), like a halt', () => {
    expect(failureOf(new PausePendingError('act-pause-1'))).toEqual({ result: 'deferred', reason: 'PAUSE_PENDING' });
  });

  it('with no pause pending the agent-key path goes on to signing (here the fake db stops it)', async () => {
    const { d, signer, pauseChecks } = world([]);
    const sent = sendPayment(d, spec(signer, 'agent'));
    await expect(sent).rejects.toThrow();
    await expect(sent).rejects.not.toBeInstanceOf(PausePendingError);
    expect(pauseChecks).toHaveLength(1);
  });

  it('the relayer (founder-signed payments) is not held back: it never asks', async () => {
    const { d, signer, pauseChecks } = world(['act-pause-1']);
    const sent = sendPayment(d, spec(signer, 'relayer'));
    await expect(sent).rejects.not.toBeInstanceOf(PausePendingError);
    expect(pauseChecks).toEqual([]);
  });
});
