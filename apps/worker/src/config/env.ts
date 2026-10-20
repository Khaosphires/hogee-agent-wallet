/**
 * Worker configuration from env (project.md §18.3). Only non-secret values are read here; signer keys are read by
 * keys.ts and never enter this object. Errors name the variable, never its value (an RPC URL may embed an API key).
 */
import { chainConfigFromEnv, ChainConfigError, gweiToWei, validateChainConfig, type ChainConfig } from '@hogee/chain';
import { assertXenditTestKey, XenditConfigError } from '../rail/xendit-rail';
import type { SessionTimeouts } from '../store/pg';
import { keySetForDeployment, type KeySet } from './keys';

export type WorkerEnv = Readonly<Record<string, string | undefined>>;

export class WorkerConfigError extends Error {
  override readonly name = 'WorkerConfigError';
}

export interface JobSchedules {
  /** autonomous-tick cron (§12.4: every 15–30 min). */
  readonly tick: string;
  /** reconcile cron (§9.3: every minute). */
  readonly reconcile: string;
  /** settle-spend sweep cron. */
  readonly settle: string;
  /** relay sweep of the API's chain_actions outbox (the API also wakes it). */
  readonly relay: string;
  /** record-sale sweep (oracle actions). */
  readonly recordSale: string;
  /** timelock-executor (§12.4: every minute). */
  readonly timelock: string;
  /** stage-gate (§12.4: every 10 min). */
  readonly stageGate: string;
  /** agent-actions: escrow funding, approved escalations, API proposals, founder-signed payments (the API also wakes it). */
  readonly agentActions: string;
  /** cfo-guard (VISION-DECISIONS §7): the CFO's tighten-only checks of burn pace and reserve (the API also wakes it). */
  readonly cfoGuard: string;
}

export interface WorkerConfig {
  readonly databaseUrl: string;
  readonly chain: ChainConfig;
  /** e.g. loop-1 / final-1 (§8.1). Selects the key set. */
  readonly deploymentId: string;
  /** <chain> part of packages/chain/deployments/<chain>-<deploymentId>.json. */
  readonly chainTag: string;
  /** Explicit manifest path (the local harness); else the packages/chain deployments directory. */
  readonly deploymentFile: string | undefined;
  readonly keySet: KeySet;
  /** MAX_FEE_GWEI in wei: a tick above it is skipped (§12.4) and nothing routine is signed above it. */
  readonly maxFeeWei: bigint;
  /**
   * MAX_SAFETY_FEE_GWEI in wei (default 10 × MAX_FEE_GWEI, never below it): the fee cap of the orphan safety pause
   * only (jobs/safety-pause.ts). A pause is never silently skipped for fees: above this cap it is retried every pass
   * with an error log, and a pause still pending is re-signed ≥ 10 % higher each pass up to this cap.
   */
  readonly maxSafetyFeeWei: bigint;
  /** Hot-key balance below which the worker alerts (§25.5). */
  readonly lowBalanceWei: bigint;
  readonly schedules: JobSchedules;
  /** Consecutive reconcile passes a non-canonical `pending` may persist before the worker halts. */
  readonly stuckPendingPasses: number;
  /** Payout attempts (attempt+1 per retryable failure, §9.1) before failSettlement. */
  readonly payoutMaxAttempts: number;
  /**
   * PAYOUT_RAIL (default mock). xendit needs a test-mode XENDIT_SECRET_KEY, checked here but read by the rail itself.
   * It only selects the rail for Xendit channels (MY_DUITNOW): SG_PAYNOW and MOCK_ONLY always pay out on MockRail
   * (rail/route.ts).
   */
  readonly payoutRail: 'mock' | 'xendit';
  /**
   * statement_timeout / lock_timeout of every worker pg connection (DB_STATEMENT_TIMEOUT_MS, DB_LOCK_TIMEOUT_MS), so
   * one stuck statement cannot hold the job's session advisory lock and starve reconcile.
   */
  readonly dbTimeouts: SessionTimeouts;
}

const DEFAULT_SCHEDULES: JobSchedules = {
  tick: '*/20 * * * *',
  reconcile: '* * * * *',
  settle: '* * * * *',
  relay: '* * * * *',
  recordSale: '* * * * *',
  timelock: '* * * * *',
  stageGate: '*/10 * * * *',
  agentActions: '* * * * *',
  cfoGuard: '*/10 * * * *',
};
const CRON_RE = /^[0-9*/,-]+( [0-9*/,-]+){4}$/;
const WEI_PER_ETH = 1_000_000_000_000_000_000n;

function required(env: WorkerEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new WorkerConfigError(`${name} is required`);
  return value;
}

function positiveInt(env: WorkerEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw new WorkerConfigError(`${name} must be a positive integer`);
  return Number(raw);
}

function cron(env: WorkerEnv, name: string, fallback: string): string {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!CRON_RE.test(raw)) throw new WorkerConfigError(`${name} must be a 5-field cron expression`);
  return raw;
}

/** "0.05" ETH → wei; a positive decimal with at most 18 places. */
function ethToWei(env: WorkerEnv, name: string, fallback: string): bigint {
  const raw = (env[name] ?? fallback).trim();
  const m = /^([0-9]+)(?:\.([0-9]{1,18}))?$/.exec(raw);
  if (!m) throw new WorkerConfigError(`${name} must be a non-negative decimal amount of ETH`);
  return BigInt(m[1] ?? '0') * WEI_PER_ETH + BigInt((m[2] ?? '').padEnd(18, '0'));
}

function chainConfig(env: WorkerEnv): ChainConfig {
  try {
    const base = chainConfigFromEnv(env);
    const local = env.LOCAL_RPC_URL?.trim();
    if (base.chain !== 'local' || !local) return base;
    return validateChainConfig({ chain: 'local', rpcUrls: [local], pollingIntervalMs: base.pollingIntervalMs });
  } catch (error: unknown) {
    // ChainConfigError messages name variables only; anything else is replaced so no value leaks.
    throw new WorkerConfigError(error instanceof ChainConfigError ? error.message : 'invalid chain configuration');
  }
}

function maxFee(env: WorkerEnv): bigint {
  const raw = required(env, 'MAX_FEE_GWEI');
  try {
    return gweiToWei(raw);
  } catch {
    throw new WorkerConfigError('MAX_FEE_GWEI must be a positive decimal number of gwei');
  }
}

/** Default safety-pause fee cap: this many times MAX_FEE_GWEI. */
export const SAFETY_FEE_MULTIPLIER = 10n;

function maxSafetyFee(env: WorkerEnv, routineCap: bigint): bigint {
  const raw = env.MAX_SAFETY_FEE_GWEI?.trim();
  if (raw === undefined || raw === '') return routineCap * SAFETY_FEE_MULTIPLIER;
  let cap: bigint;
  try {
    cap = gweiToWei(raw);
  } catch {
    throw new WorkerConfigError('MAX_SAFETY_FEE_GWEI must be a positive decimal number of gwei');
  }
  if (cap < routineCap) throw new WorkerConfigError('MAX_SAFETY_FEE_GWEI must be at least MAX_FEE_GWEI');
  return cap;
}

/** PAYOUT_RAIL; xendit only with a test-mode (xnd_development_) key. The key itself never enters the config. */
function payoutRail(env: WorkerEnv): 'mock' | 'xendit' {
  const rail = env.PAYOUT_RAIL?.trim() || 'mock';
  if (rail !== 'mock' && rail !== 'xendit') throw new WorkerConfigError('PAYOUT_RAIL must be mock or xendit');
  if (rail === 'xendit') {
    try {
      assertXenditTestKey(env.XENDIT_SECRET_KEY);
    } catch (error: unknown) {
      throw new WorkerConfigError(error instanceof XenditConfigError ? error.message : 'XENDIT_SECRET_KEY is invalid');
    }
  }
  return rail;
}

/** Parses and validates the worker's env. Throws WorkerConfigError naming the first bad variable. */
export function loadWorkerConfig(env: WorkerEnv): WorkerConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const deploymentId = required(env, 'DEPLOYMENT_ID');
  let keySet: KeySet;
  try {
    keySet = keySetForDeployment(deploymentId);
  } catch (error: unknown) {
    throw new WorkerConfigError(error instanceof Error ? error.message : 'DEPLOYMENT_ID names no key set');
  }
  const chain = chainConfig(env);
  const rail = payoutRail(env);
  return Object.freeze({
    databaseUrl,
    chain,
    deploymentId,
    chainTag: env.CHAIN_TAG?.trim() || (chain.chain === 'local' ? 'anvil' : 'sepolia'),
    deploymentFile: env.DEPLOYMENT_FILE?.trim() || undefined,
    keySet,
    maxFeeWei: maxFee(env),
    maxSafetyFeeWei: maxSafetyFee(env, maxFee(env)),
    lowBalanceWei: ethToWei(env, 'LOW_BALANCE_ETH', '0.05'),
    schedules: Object.freeze({
      tick: cron(env, 'TICK_CRON', DEFAULT_SCHEDULES.tick),
      reconcile: cron(env, 'RECONCILE_CRON', DEFAULT_SCHEDULES.reconcile),
      settle: cron(env, 'SETTLE_CRON', DEFAULT_SCHEDULES.settle),
      relay: cron(env, 'RELAY_CRON', DEFAULT_SCHEDULES.relay),
      recordSale: cron(env, 'RECORD_SALE_CRON', DEFAULT_SCHEDULES.recordSale),
      timelock: cron(env, 'TIMELOCK_CRON', DEFAULT_SCHEDULES.timelock),
      stageGate: cron(env, 'STAGE_GATE_CRON', DEFAULT_SCHEDULES.stageGate),
      agentActions: cron(env, 'AGENT_ACTIONS_CRON', DEFAULT_SCHEDULES.agentActions),
      cfoGuard: cron(env, 'CFO_GUARD_CRON', DEFAULT_SCHEDULES.cfoGuard),
    }),
    stuckPendingPasses: positiveInt(env, 'STUCK_PENDING_PASSES', 5),
    payoutMaxAttempts: positiveInt(env, 'PAYOUT_MAX_ATTEMPTS', 3),
    payoutRail: rail,
    dbTimeouts: Object.freeze({
      statementTimeoutMs: positiveInt(env, 'DB_STATEMENT_TIMEOUT_MS', 30_000),
      lockTimeoutMs: positiveInt(env, 'DB_LOCK_TIMEOUT_MS', 5_000),
    }),
  });
}
