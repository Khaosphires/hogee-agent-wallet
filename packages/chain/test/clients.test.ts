import { generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  accountFromPrivateKey,
  chainConfigFromEnv,
  ChainConfigError,
  createHogeePublicClient,
  createHogeeWalletClient,
  LOCAL_RPC_URL,
  MIN_SEPOLIA_POLLING_MS,
  validateChainConfig,
} from '../src/index';

const SECRET_URL = 'https://eth-sepolia.example.invalid/v2/SECRET-API-KEY';
const SECOND_URL = 'https://rpc.sepolia.example.invalid';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return '';
}

describe('chainConfigFromEnv', () => {
  it('defaults to local Anvil with 1 s polling', () => {
    expect(chainConfigFromEnv({})).toMatchObject({ chain: 'local', rpcUrls: [LOCAL_RPC_URL], pollingIntervalMs: 1_000 });
  });

  it('builds a two-provider Sepolia fallback with ≥ 12 s polling', () => {
    const config = chainConfigFromEnv({ CHAIN: 'sepolia', SEPOLIA_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL_FALLBACK: SECOND_URL });
    expect(config).toMatchObject({ chain: 'sepolia', rpcUrls: [SECRET_URL, SECOND_URL], pollingIntervalMs: MIN_SEPOLIA_POLLING_MS });
    expect(chainConfigFromEnv({ CHAIN: 'sepolia', SEPOLIA_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL_FALLBACK: SECOND_URL, RPC_POLLING_MS: '15000' }).pollingIntervalMs).toBe(15_000);
  });

  it.each([
    [{ CHAIN: 'fisco' }, /CHAIN must be local or sepolia/],
    [{ CHAIN: 'sepolia', SEPOLIA_RPC_URL: SECRET_URL }, /SEPOLIA_RPC_URL_FALLBACK is required/],
    [{ CHAIN: 'sepolia', SEPOLIA_RPC_URL_FALLBACK: SECOND_URL }, /SEPOLIA_RPC_URL is required/],
    [{ CHAIN: 'sepolia', SEPOLIA_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL_FALLBACK: SECRET_URL }, /distinct/],
    [{ CHAIN: 'sepolia', SEPOLIA_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL_FALLBACK: SECOND_URL, RPC_POLLING_MS: '4000' }, /at least 12000/],
    [{ RPC_POLLING_MS: '1.5' }, /positive integer/],
    [{ CHAIN: 'sepolia', SEPOLIA_RPC_URL: 'ftp://x.invalid/SECRET-API-KEY', SEPOLIA_RPC_URL_FALLBACK: SECOND_URL }, /http\(s\)/],
  ])('rejects %j', (env, message) => {
    expect(() => chainConfigFromEnv(env)).toThrow(ChainConfigError);
    expect(messageOf(() => chainConfigFromEnv(env))).toMatch(message);
  });

  it('requires https for a Sepolia provider (the URL may carry an API key), except on loopback', () => {
    const plain = 'http://rpc.sepolia.example.invalid/v2/SECRET-API-KEY';
    for (const env of [
      { CHAIN: 'sepolia', SEPOLIA_RPC_URL: plain, SEPOLIA_RPC_URL_FALLBACK: SECOND_URL },
      { CHAIN: 'sepolia', SEPOLIA_RPC_URL: SECRET_URL, SEPOLIA_RPC_URL_FALLBACK: plain },
    ]) {
      expect(() => chainConfigFromEnv(env)).toThrow(ChainConfigError);
      const msg = messageOf(() => chainConfigFromEnv(env));
      expect(msg).toMatch(/SEPOLIA_RPC_URL(_FALLBACK)? must be an https URL/);
      expect(msg).not.toMatch(/SECRET-API-KEY/);
    }
    expect(() => validateChainConfig({ chain: 'sepolia', rpcUrls: [plain, SECOND_URL], pollingIntervalMs: 12_000 })).toThrow(/https/);
    for (const loopback of ['http://localhost:8545', 'http://127.0.0.1:8545', 'http://[::1]:8545']) {
      expect(chainConfigFromEnv({ CHAIN: 'sepolia', SEPOLIA_RPC_URL: loopback, SEPOLIA_RPC_URL_FALLBACK: SECOND_URL }).rpcUrls[0]).toBe(loopback);
    }
    // A loopback look-alike is not loopback.
    expect(() => chainConfigFromEnv({ CHAIN: 'sepolia', SEPOLIA_RPC_URL: 'http://127.0.0.1.example.invalid', SEPOLIA_RPC_URL_FALLBACK: SECOND_URL })).toThrow(/https/);
    // Local Anvil keeps plain http.
    expect(validateChainConfig({ chain: 'local', rpcUrls: ['http://anvil.internal:8545'], pollingIntervalMs: 1_000 }).rpcUrls).toEqual(['http://anvil.internal:8545']);
  });

  it('never echoes an RPC URL (which may embed an API key) in an error', () => {
    const msg = messageOf(() =>
      chainConfigFromEnv({ CHAIN: 'sepolia', SEPOLIA_RPC_URL: 'ftp://x.invalid/SECRET-API-KEY', SEPOLIA_RPC_URL_FALLBACK: SECOND_URL }),
    );
    expect(msg).not.toMatch(/SECRET-API-KEY/);
  });
});

describe('validateChainConfig', () => {
  it('requires two providers on Sepolia even when built by hand', () => {
    expect(() => validateChainConfig({ chain: 'sepolia', rpcUrls: [SECRET_URL], pollingIntervalMs: 12_000 })).toThrow(/two RPC providers/);
    expect(() => validateChainConfig({ chain: 'local', rpcUrls: [], pollingIntervalMs: 1_000 })).toThrow(/at least one/);
  });
});

describe('client factories', () => {
  it('creates a Sepolia public client polling every ≥ 12 s on a fallback transport (no network touched)', () => {
    const client = createHogeePublicClient({ chain: 'sepolia', rpcUrls: [SECRET_URL, SECOND_URL], pollingIntervalMs: 12_000 });
    expect(client.chain.id).toBe(11_155_111);
    expect(client.pollingInterval).toBe(12_000);
    expect(client.transport.type).toBe('fallback');
  });

  it('creates a wallet client from a caller-supplied key and never echoes a bad key', () => {
    const wallet = createHogeeWalletClient({ chain: 'local', rpcUrls: [LOCAL_RPC_URL], pollingIntervalMs: 1_000 }, generatePrivateKey());
    expect(wallet.chain.id).toBe(31_337);
    expect(wallet.account.type).toBe('local');
    const badKey = `0x${'z'.repeat(64)}` as const;
    const msg = messageOf(() => accountFromPrivateKey(badKey));
    expect(msg).toMatch(/32-byte hex/);
    expect(msg).not.toContain('zzzz');
  });

  it('a well-formed key outside the secp256k1 range never appears in the error (noble quotes it)', () => {
    const above = `0x${'f'.repeat(64)}` as const; // ≥ the curve order
    const zero = `0x${'0'.repeat(64)}` as const;
    for (const key of [above, zero]) {
      let caught: unknown;
      try {
        accountFromPrivateKey(key);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ChainConfigError);
      const err = caught as Error;
      expect(err.message).toMatch(/not a valid secp256k1 private key/);
      expect(err.cause).toBeUndefined();
      const text = `${err.message} ${String(err.stack)}`;
      expect(text).not.toMatch(/ffffffff|115792089237316195423570985008687907853269984665640564039457584007913129639935|got 0/i);
    }
  });
});
