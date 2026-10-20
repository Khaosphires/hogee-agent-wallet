/**
 * viem clients for the worker (project.md §6.1 viem row, D19).
 *
 * - `fallback()` transport over every configured RPC URL (Sepolia needs 2: SEPOLIA_RPC_URL and
 *   SEPOLIA_RPC_URL_FALLBACK); local Anvil uses http://127.0.0.1:8545. Sepolia providers must be https (plain
 *   http only on loopback: localhost, 127.0.0.1, [::1]).
 * - `pollingInterval` ≥ 12 s on Sepolia (RPC_POLLING_MS), so free-tier RPC limits hold.
 * - Accounts come only from private keys the CALLER passes in (the worker reads its own env). This module
 *   never reads `.env`, never reads key env vars, and never puts a key or an RPC URL (which may embed an
 *   API key) into an error message.
 */
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { anvil, sepolia } from 'viem/chains';

export const CHAIN_NAMES = ['local', 'sepolia'] as const;
export type ChainName = (typeof CHAIN_NAMES)[number];

/** viem chain per CHAIN value. Anvil's default chain id is 31337. */
export const HOGEE_CHAINS: { readonly [K in ChainName]: Chain } = { local: anvil, sepolia };

export const LOCAL_RPC_URL = 'http://127.0.0.1:8545';
/** §6.1: one Sepolia slot is 12 s; polling faster only burns free-tier RPC quota. */
export const MIN_SEPOLIA_POLLING_MS = 12_000;
export const DEFAULT_LOCAL_POLLING_MS = 1_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

export interface ChainConfig {
  readonly chain: ChainName;
  /** Tried in order by viem's `fallback()` transport. */
  readonly rpcUrls: readonly string[];
  readonly pollingIntervalMs: number;
  /** Per-request timeout of each http transport (default 10 s). */
  readonly rpcTimeoutMs?: number;
}

export class ChainConfigError extends Error {
  override readonly name = 'ChainConfigError';
}

export type HogeePublicClient = PublicClient<Transport, Chain>;
export type HogeeWalletClient = WalletClient<Transport, Chain, Account>;

/** The env names this module understands (project.md §18.3). Keys are deliberately not in this list. */
export interface ChainEnv {
  readonly CHAIN?: string | undefined;
  readonly SEPOLIA_RPC_URL?: string | undefined;
  readonly SEPOLIA_RPC_URL_FALLBACK?: string | undefined;
  readonly RPC_POLLING_MS?: string | undefined;
}

function isChainName(value: string): value is ChainName {
  return (CHAIN_NAMES as readonly string[]).includes(value);
}

/** Hosts a plain-http RPC URL may name on Sepolia: the request never leaves the machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `https:` is required for a Sepolia provider (its URL usually embeds an API key, and its replies decide what the
 * worker signs), except for a loopback host (a local proxy or node). Local Anvil keeps plain `http:`.
 */
function checkRpcUrl(url: string, label: string, chain: ChainName): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChainConfigError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ChainConfigError(`${label} must be an http(s) URL`);
  }
  if (chain === 'sepolia' && parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new ChainConfigError(`${label} must be an https URL (plain http only for localhost, 127.0.0.1 or [::1])`);
  }
  return url;
}

function parsePolling(raw: string | undefined, chain: ChainName): number {
  if (raw === undefined || raw.trim() === '') {
    return chain === 'sepolia' ? MIN_SEPOLIA_POLLING_MS : DEFAULT_LOCAL_POLLING_MS;
  }
  if (!/^[1-9][0-9]*$/.test(raw.trim())) throw new ChainConfigError('RPC_POLLING_MS must be a positive integer');
  return Number(raw.trim());
}

/**
 * Validates a config and returns a frozen copy. Sepolia needs at least two distinct RPC URLs and a
 * polling interval of at least 12 s; local needs at least one URL.
 */
export function validateChainConfig(config: ChainConfig): ChainConfig {
  if (!isChainName(config.chain)) throw new ChainConfigError('chain must be one of: local, sepolia');
  const rpcUrls = config.rpcUrls.map((url, i) => checkRpcUrl(url, `rpcUrls[${i}]`, config.chain));
  if (rpcUrls.length === 0) throw new ChainConfigError('at least one RPC URL is required');
  if (new Set(rpcUrls).size !== rpcUrls.length) throw new ChainConfigError('RPC URLs must be distinct');
  if (config.chain === 'sepolia' && rpcUrls.length < 2) {
    throw new ChainConfigError('sepolia needs two RPC providers (SEPOLIA_RPC_URL and SEPOLIA_RPC_URL_FALLBACK)');
  }
  if (!Number.isSafeInteger(config.pollingIntervalMs) || config.pollingIntervalMs <= 0) {
    throw new ChainConfigError('pollingIntervalMs must be a positive integer');
  }
  if (config.chain === 'sepolia' && config.pollingIntervalMs < MIN_SEPOLIA_POLLING_MS) {
    throw new ChainConfigError(`sepolia pollingIntervalMs must be at least ${MIN_SEPOLIA_POLLING_MS}`);
  }
  const rpcTimeoutMs = config.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) {
    throw new ChainConfigError('rpcTimeoutMs must be a positive integer');
  }
  return Object.freeze({ chain: config.chain, rpcUrls: Object.freeze(rpcUrls), pollingIntervalMs: config.pollingIntervalMs, rpcTimeoutMs });
}

/**
 * Builds a config from env values the caller passes in (e.g. `chainConfigFromEnv(process.env)`).
 * CHAIN defaults to `local`. Reads only the names in {@link ChainEnv}; never touches key variables.
 */
export function chainConfigFromEnv(env: ChainEnv): ChainConfig {
  const chain = (env.CHAIN ?? 'local').trim();
  if (!isChainName(chain)) throw new ChainConfigError('CHAIN must be local or sepolia');
  const pollingIntervalMs = parsePolling(env.RPC_POLLING_MS, chain);
  if (chain === 'local') return validateChainConfig({ chain, rpcUrls: [LOCAL_RPC_URL], pollingIntervalMs });
  const primary = env.SEPOLIA_RPC_URL?.trim();
  const secondary = env.SEPOLIA_RPC_URL_FALLBACK?.trim();
  if (!primary) throw new ChainConfigError('SEPOLIA_RPC_URL is required when CHAIN=sepolia');
  if (!secondary) throw new ChainConfigError('SEPOLIA_RPC_URL_FALLBACK is required when CHAIN=sepolia');
  return validateChainConfig({
    chain,
    rpcUrls: [checkRpcUrl(primary, 'SEPOLIA_RPC_URL', chain), checkRpcUrl(secondary, 'SEPOLIA_RPC_URL_FALLBACK', chain)],
    pollingIntervalMs,
  });
}

/** `fallback()` over one http transport per URL, in the configured order (no ranking, deterministic). */
export function hogeeTransport(config: ChainConfig): Transport {
  const valid = validateChainConfig(config);
  const timeout = valid.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  return fallback(
    valid.rpcUrls.map((url) => http(url, { timeout, retryCount: 1 })),
    { rank: false, retryCount: 2 },
  );
}

export function createHogeePublicClient(config: ChainConfig): HogeePublicClient {
  const valid = validateChainConfig(config);
  return createPublicClient({
    chain: HOGEE_CHAINS[valid.chain],
    transport: hogeeTransport(valid),
    pollingInterval: valid.pollingIntervalMs,
  }) as HogeePublicClient;
}

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Local account from a caller-supplied private key. The key is validated but never echoed: a 64-hex value outside the
 * secp256k1 range (0, or ≥ the curve order) makes viem/noble throw a message that quotes it, so that error is replaced
 * by one that names nothing and carries no `cause` (re-check L8).
 */
export function accountFromPrivateKey(privateKey: Hex): PrivateKeyAccount {
  if (typeof privateKey !== 'string' || !PRIVATE_KEY_RE.test(privateKey)) {
    throw new ChainConfigError('private key must be 0x-prefixed 32-byte hex');
  }
  try {
    return privateKeyToAccount(privateKey);
  } catch {
    throw new ChainConfigError('private key is not a valid secp256k1 private key');
  }
}

/** Wallet client for one signer (agent, oracle, relayer or lender key; `_LOOP` / `_FINAL` per deployment). */
export function createHogeeWalletClient(config: ChainConfig, privateKey: Hex): HogeeWalletClient {
  const valid = validateChainConfig(config);
  return createWalletClient({
    account: accountFromPrivateKey(privateKey),
    chain: HOGEE_CHAINS[valid.chain],
    transport: hogeeTransport(valid),
    pollingInterval: valid.pollingIntervalMs,
  }) as HogeeWalletClient;
}
