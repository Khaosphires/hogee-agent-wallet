/**
 * minedSignedBytes: the landed tx's own signed bytes, rebuilt from the node's copy. Fails closed: null unless the bytes
 * hash back to the asked hash.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { minedSignedBytes } from '../src/mined-bytes';
import { signedTx } from './fixtures/fake-chain';

const account = privateKeyToAccount(generatePrivateKey());
const TO = '0x00000000000000000000000000000000000000aa' as const;

/** A node's copy of a signed tx: its fields and signature, the data as `input`. */
function nodeCopy(raw: Hex, hash: Hex) {
  const { data, ...signed } = parseTransaction(raw);
  return { ...signed, input: data ?? '0x', hash, from: account.address };
}

describe('minedSignedBytes', () => {
  it('rebuilds an EIP-1559 tx byte for byte from the node copy', async () => {
    const tx = await signedTx(account, { nonce: 7n, to: TO, data: '0x8456cb59' });
    const client = { getTransaction: async () => nodeCopy(tx.raw, tx.hash) };
    expect(await minedSignedBytes(client as never, tx.hash)).toBe(tx.raw);
  });

  it('returns null when the rebuilt bytes do not hash back (a different tx answered for that hash)', async () => {
    const a = await signedTx(account, { nonce: 7n, to: TO, data: '0x8456cb59' });
    const b = await signedTx(account, { nonce: 7n, to: TO, data: '0x8456cb59', maxFeePerGas: 3_000_000_000n });
    const client = { getTransaction: async () => nodeCopy(b.raw, a.hash) };
    expect(await minedSignedBytes(client as never, a.hash)).toBeNull();
  });

  it('returns null when the node has no copy, or no signature', async () => {
    const tx = await signedTx(account, { nonce: 1n, to: TO, data: '0x' });
    const missing = { getTransaction: async () => { throw new Error('not found'); } };
    expect(await minedSignedBytes(missing as never, tx.hash)).toBeNull();
    const unsigned = { getTransaction: async () => ({ ...nodeCopy(tx.raw, tx.hash), r: undefined, s: undefined }) };
    expect(await minedSignedBytes(unsigned as never, tx.hash)).toBeNull();
  });
});
