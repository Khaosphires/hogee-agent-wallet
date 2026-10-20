/** Forced reverts record only their OWN receipt: a replacement mined at the stored nonce is left to recovery. */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { buildPause, recordForcedRevertReceipt, TxReplacedError } from '../src/index';
import { signedTx } from './fixtures/fake-chain';
import { MemoryRowStore } from './fixtures/memory-rows';
import { actionRow, TREASURY } from './fixtures/signed-rows';

const account = privateKeyToAccount(generatePrivateKey());

describe('recordForcedRevertReceipt', () => {
  it('marks the row INCLUDED with the stored hash and the receipt block', async () => {
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: buildPause().data });
    const store = new MemoryRowStore();
    const row = store.add(actionRow({ id: 'f1', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash }));
    expect(await recordForcedRevertReceipt(store, row.target, mine.hash, { transactionHash: mine.hash, blockNumber: 42n })).toBe(true);
    expect(store.get(row.target)).toMatchObject({ state: 'INCLUDED', txHash: mine.hash, block: 42n });
  });

  it('refuses a receipt of another tx (a replacement) and leaves the row open for recovery', async () => {
    const mine = await signedTx(account, { nonce: 0n, to: TREASURY, data: buildPause().data });
    const other = await signedTx(account, { nonce: 0n, to: account.address, data: '0x' });
    const store = new MemoryRowStore();
    const row = store.add(actionRow({ id: 'f2', state: 'BROADCAST', account, nonce: 0n, raw: mine.raw, txHash: mine.hash }));
    const write = recordForcedRevertReceipt(store, row.target, mine.hash, { transactionHash: other.hash, blockNumber: 42n });
    await expect(write).rejects.toThrow(TxReplacedError);
    await expect(write).rejects.toMatchObject({ storedTxHash: mine.hash, minedTxHash: other.hash });
    expect(store.get(row.target)).toMatchObject({ state: 'BROADCAST', txHash: mine.hash, block: null });
  });
});
