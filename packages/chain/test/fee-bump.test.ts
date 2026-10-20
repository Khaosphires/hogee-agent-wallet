/**
 * What a fee bump may re-sign (security re-check H1): only the row's own stored tx, signed by the account doing the
 * bump, for the expected chain, at the row's nonce, and bound to the row's deployment like signAndStore's request.
 * A DB writer who swaps the stored bytes (or repoints a row) must not get them re-signed by a worker key.
 */
import { keccak256, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { buildPause, buildRecordDenied, storedTxRefusal, type SignedRow } from '../src/index';
import { actionRow, CHAIN, DEPLOYMENT, TREASURY } from './fixtures/signed-rows';

const lender = privateKeyToAccount(generatePrivateKey());
const throwaway = privateKeyToAccount(generatePrivateKey());
const ATTACKER: Address = '0x000000000000000000000000000000000000bad0';
const PAUSE = buildPause().data;
const ZERO32: Hex = `0x${'0'.repeat(64)}`;

async function signed(
  account: typeof lender,
  over: Partial<{ to: Address; data: Hex; value: bigint; nonce: number; chainId: number }> = {},
): Promise<{ raw: Hex; hash: Hex }> {
  const raw = await account.signTransaction({
    type: 'eip1559',
    chainId: over.chainId ?? CHAIN,
    nonce: over.nonce ?? 4,
    to: over.to ?? TREASURY,
    data: over.data ?? PAUSE,
    value: over.value ?? 0n,
    gas: 80_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  return { raw, hash: keccak256(raw) };
}

/** A pending Treasury.pause chain action whose signer_address is the lender, holding `tx` as its stored bytes. */
const pauseRow = (tx: { raw: Hex; hash: Hex }, over: Partial<SignedRow> = {}): SignedRow => ({
  ...actionRow({ id: 'safety-pause:orphan:1', state: 'BROADCAST', account: lender, nonce: 4n, raw: tx.raw, txHash: tx.hash }),
  ...over,
});
const binding = { account: lender, chainId: CHAIN, deployment: DEPLOYMENT };

describe('storedTxRefusal (feeBump re-signs only a stored tx it could have signed itself)', () => {
  it('accepts the row’s own pause(), signed by the bumping account for this chain and nonce', async () => {
    expect(await storedTxRefusal(pauseRow(await signed(lender)), binding)).toBeNull();
  });

  it('refuses bytes another key signed (a DB writer swapped them in): nothing is re-signed with the lender key', async () => {
    const swapped = await signed(throwaway, { to: ATTACKER, data: '0x', value: parseEther('10') });
    expect(await storedTxRefusal(pauseRow(swapped), binding)).toMatch(/not signed by the account/);
    // Even the right call, if another key signed it.
    expect(await storedTxRefusal(pauseRow(await signed(throwaway)), binding)).toMatch(/not signed by the account/);
  });

  it('refuses a call the row does not describe, even signed by the account', async () => {
    expect(await storedTxRefusal(pauseRow(await signed(lender, { to: ATTACKER })), binding)).toMatch(/to is not the deployment's Treasury/);
    const denied = buildRecordDenied({ lineId: ZERO32, decisionId: ZERO32, reasonCode: ZERO32, proposalHash: ZERO32 }).data;
    expect(await storedTxRefusal(pauseRow(await signed(lender, { data: denied })), binding)).toMatch(/calldata is not Treasury.pause/);
    expect(await storedTxRefusal(pauseRow(await signed(lender, { value: 1n })), binding)).toMatch(/value must be 0/);
  });

  it('refuses another chain, a row on another chain, or bytes at another nonce than the row', async () => {
    expect(await storedTxRefusal(pauseRow(await signed(lender, { chainId: 1 })), binding)).toMatch(/chainId/);
    expect(await storedTxRefusal(pauseRow(await signed(lender), { chainId: 1 }), binding)).toMatch(/chainId/);
    expect(await storedTxRefusal(pauseRow(await signed(lender)), { ...binding, chainId: 1 })).toMatch(/chainId/);
    expect(await storedTxRefusal(pauseRow(await signed(lender, { nonce: 9 })), binding)).toMatch(/nonce/);
  });

  it('refuses a bump by another account than the row’s signer', async () => {
    expect(await storedTxRefusal(pauseRow(await signed(lender)), { ...binding, account: throwaway })).toMatch(/account does not match the stored signer/);
  });

  it('refuses bytes that are not a transaction', async () => {
    expect(await storedTxRefusal(pauseRow({ raw: '0x02deadbeef', hash: keccak256('0x02deadbeef') }), binding)).toMatch(/not a signed EIP-1559 tx/);
  });
});
