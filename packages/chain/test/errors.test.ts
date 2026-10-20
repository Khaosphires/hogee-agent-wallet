/**
 * Redaction of provider URLs (they can embed an API key) from everything that leaves this package: outcome
 * reasons and rethrown errors. The original stays reachable as `cause` for local debugging.
 */
import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  broadcast,
  FeeCapExceededError,
  fillNonceHoles,
  headAt,
  isReplacementUnderpriced,
  RedactedError,
  redactError,
  redactText,
  shortErrorReason,
  SignTargetError,
} from '../src/index';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const KEY = 'not-a-real-key';
const leaks = (s: string) => s.includes(KEY) || /https?:/i.test(s);

/** A node error the way viem builds it: short message, URL in a later line and in `details`. */
function providerError(first = 'HTTP request failed.'): Error {
  const inner = Object.assign(new Error(`${first}\nURL: https://eth-sepolia.example/v2/${KEY}`), { details: `fetch https://eth-sepolia.example/v2/${KEY}` });
  return Object.assign(new Error(`${first}\n\nURL: https://eth-sepolia.example/v2/${KEY}`), { shortMessage: first, cause: inner });
}

describe('redactText', () => {
  it.each([
    [`fetch failed: https://eth-sepolia.example/v2/${KEY} (timeout)`, 'fetch failed: <url> (timeout)'],
    [`fetch failed: eth-sepolia.g.alchemy.com/v2/${KEY}`, 'fetch failed: <url>'],
    [`proxy sepolia.infura.io:443/v3/${KEY}?x=1 refused`, 'proxy <url> refused'],
    [`see https%3A%2F%2Feth-sepolia.example%2Fv2%2F${KEY} for`, 'see <url> for'],
    [`{"url":"https:\\/\\/eth-sepolia.example\\/v2\\/${KEY}","id":1}`, '{"url":"<url>","id":1}'],
    [`ws: wss://eth-sepolia.example/ws/v2/${KEY}`, 'ws: <url>'],
  ])('redacts %s', (input, output) => {
    expect(redactText(input)).toBe(output);
  });

  // VISION-DECISIONS §7: a Tavily key echoed outside a URL (request body, header dump).
  it.each([
    ['search failed: {"api_key":"tvly-dev-AbC123xyz_456-789QRS"}', 'search failed: {"api_key":"<key>"}'],
    ['Authorization: Bearer tvly-AbCdEfGh12345678', 'Authorization: Bearer <key>'],
    ['tvly-0123456789abcdef and tvly-fedcba9876543210', '<key> and <key>'],
  ])('masks a Tavily key in %s', (input, output) => {
    expect(redactText(input)).toBe(output);
  });

  it('keeps text that only names the tvly- prefix', () => {
    expect(redactText('TAVILY_API_KEY is malformed (expected tvly- followed by the key)')).toBe('TAVILY_API_KEY is malformed (expected tvly- followed by the key)');
  });

  it('a Tavily key anywhere in an error chain gets the error wrapped (redactError)', () => {
    const original = new Error('provider said 401 for tvly-AbCdEfGh12345678');
    const wrapped = redactError(original);
    expect(wrapped).toBeInstanceOf(RedactedError);
    expect((wrapped as Error).message).not.toContain('tvly-AbCdEfGh12345678');
  });

  it('leaves ordinary node and app text alone', () => {
    for (const text of ['nonce too low', 'replacement transaction underpriced', 'Version: viem@2.57.6', 'reverted with 0xdeadbeef', 'payments/pay-1 is SIGNED, expected POLICY_OK']) {
      expect(redactText(text)).toBe(text);
    }
  });
});

describe('redactError', () => {
  it('returns an error that carries no URL unchanged (typed errors and their classes survive)', () => {
    const typed = new SignTargetError('payments/p1 is SIGNED, expected POLICY_OK');
    expect(redactError(typed)).toBe(typed);
    const nonce = Object.assign(new Error('Transaction creation failed.'), { details: 'nonce too low' });
    expect(redactError(nonce)).toBe(nonce);
  });

  it('wraps one that carries a URL anywhere in its chain: redacted message, the original as cause; idempotent', () => {
    const original = providerError();
    const wrapped = redactError(original);
    expect(wrapped).toBeInstanceOf(RedactedError);
    expect((wrapped as Error).message).toBe('Error: HTTP request failed.');
    expect(leaks((wrapped as Error).message)).toBe(false);
    expect((wrapped as Error).cause).toBe(original);
    expect(redactError(wrapped)).toBe(wrapped);
    expect(leaks(shortErrorReason(wrapped))).toBe(false);
  });
});

describe('rethrown errors are redacted', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const fees = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

  it('broadcast: an unclassified node error with a URL is rethrown redacted; classification still sees the cause', async () => {
    const raw = await account.signTransaction({ type: 'eip1559', chainId: 31337, nonce: 0, to: account.address, value: 0n, gas: 21_000n, ...fees });
    const err = await broadcast({ sendRawTransaction: async () => Promise.reject(providerError('replacement transaction underpriced')) }, raw).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedactedError);
    expect(leaks((err as Error).message)).toBe(false);
    expect(isReplacementUnderpriced(err)).toBe(true);
    const plain = await broadcast({ sendRawTransaction: async () => Promise.reject(new Error('insufficient funds')) }, raw).catch((e: unknown) => e);
    expect(plain).not.toBeInstanceOf(RedactedError);
    expect(keccak256(raw)).toMatch(/^0x/);
  });

  it('fillNonceHoles: a fee estimate or send failure with a URL is rethrown redacted; the fee cap error stays typed', async () => {
    const feeFails = { estimateFeesPerGas: async () => Promise.reject(providerError()), sendRawTransaction: async (): Promise<Hex> => '0x' };
    const err = await fillNonceHoles({ client: feeFails, account, chainId: 31337, holes: [0n], capWei: 10n ** 12n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedactedError);
    expect(leaks((err as Error).message)).toBe(false);
    const sendFails = { estimateFeesPerGas: async () => fees, sendRawTransaction: async (): Promise<Hex> => Promise.reject(providerError('fetch failed')) };
    await expect(fillNonceHoles({ client: sendFails, account, chainId: 31337, holes: [0n], capWei: 10n ** 12n })).rejects.toBeInstanceOf(RedactedError);
    const capped = { estimateFeesPerGas: async () => fees, sendRawTransaction: async (): Promise<Hex> => '0x' };
    await expect(fillNonceHoles({ client: capped, account, chainId: 31337, holes: [0n], capWei: 1n })).rejects.toBeInstanceOf(FeeCapExceededError);
  });

  it('headAt: a getBlock failure with a URL is rethrown redacted', async () => {
    const err = await headAt({ getBlock: async () => Promise.reject(providerError()) }, 'finalized').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedactedError);
    expect(leaks((err as Error).message)).toBe(false);
  });
});
