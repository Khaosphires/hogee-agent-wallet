/**
 * Builds the worker from env (process entry and its live test): config, signer keys (read once, then scrubbed from
 * the env), the deployment manifest, the DB pool and the chain client, then refuses to start unless the chain is the
 * manifest's chain, the configured lender/oracle keys are the deployment's roles, the manifest names the contracts
 * Treasury links (re-check L9) and no worker key is the observer (re-check L-3); fail closed. Each job handler runs
 * under the job lock, over every facility of this deployment; settle-spend, reconcile and cfo-guard wait up to 20 s for
 * it instead of skipping (job-locks.ts, fix-cfo-load, re-check A-5), giving way to the relay while a pause or
 * cancelLoosen is pending (v-4).
 */
import { readFileSync } from 'node:fs';
import {
  createHogeePublicClient,
  iPlanRegistryAbi,
  loadDeployment,
  parseDeployment,
  seedNonce,
  type DeploymentManifest,
  type HogeePublicClient,
} from '@hogee/chain';
import { createDb } from '@hogee/db';
import { BaseError, ContractFunctionRevertedError, getAddress, parseAbi, zeroAddress, type Address } from 'viem';
import { loadWorkerConfig, type WorkerConfig } from '../config/env';
import { loadSigners, type WorkerSigners } from '../config/keys';
import type { JobDeps } from '../jobs/deps';
import { facilitiesFor } from '../jobs/facility';
import { runAgentActions } from '../jobs/agent-actions';
import { runReconcile } from '../jobs/reconcile';
import { runRelay } from '../jobs/relay';
import { runStageGate } from '../jobs/stage-gate';
import { GuardPacer, runCfoGuard } from '../jobs/cfo-guard';
import { runTimelockExecutor } from '../jobs/timelock-executor';
import { runSettle } from '../jobs/settle';
import { runTick } from '../jobs/tick';
import { MockRail } from '../rail/mock-rail';
import { PayoutRouter } from '../rail/route';
import { xenditRailFromEnv } from '../rail/xendit-rail';
import { autonomyRunning, consumeCrashFlag } from '../store/flags';
import { applySessionTimeouts, rows } from '../store/pg';
import { publishRoles } from '../store/roles';
import { migrateWorkerSchema } from '../store/schema';
import type { WorkerQueue } from './boss';
import { WORKER_POOL_MAX, lockedJob } from './job-locks';
import type { Logger } from './log';
import { relayWake } from './relay-wake';

export class WorkerStartError extends Error {
  override readonly name = 'WorkerStartError';
}

export interface WorkerApp {
  readonly config: WorkerConfig;
  readonly deps: JobDeps;
  readonly handlers: Readonly<Record<WorkerQueue, () => Promise<void>>>;
  close(): Promise<void>;
}

function deploymentOf(config: WorkerConfig): DeploymentManifest {
  const manifest = config.deploymentFile
    ? parseDeployment(JSON.parse(readFileSync(config.deploymentFile, 'utf8')) as unknown)
    : loadDeployment(config.chainTag, config.deploymentId);
  if (manifest.deploymentId !== config.deploymentId) throw new WorkerStartError('the deployment manifest is not DEPLOYMENT_ID');
  return manifest;
}

/**
 * Treasury views outside the frozen ABI, read with a small local ABI (as chain/mirror.ts does): oracle() on every
 * shape; escrow(), salesOracle() and observer() on a Treasury built from the task 1.8 source (the loop-1-src Treasury
 * has no escrow(), so that read reverts there).
 */
const treasuryExtraAbi = parseAbi([
  'function oracle() view returns (address)',
  'function escrow() view returns (address)',
  'function salesOracle() view returns (address)',
  'function observer() view returns (address)',
]);

/** The chain reads the startup checks make. */
export type PreflightClient = Pick<HogeePublicClient, 'getChainId' | 'readContract'>;

export interface PreflightTarget {
  readonly client: PreflightClient;
  readonly deployment: DeploymentManifest;
  readonly signers: WorkerSigners;
}

async function preflight(d: JobDeps): Promise<void> {
  const chainId = await d.client.getChainId();
  if (chainId !== d.deployment.chainId) throw new WorkerStartError(`the RPC serves chain ${chainId}, the manifest is for chain ${d.deployment.chainId}`);
  const [table] = await rows<{ ok: boolean }>(d.db.$client, `select to_regclass('public.payments') is not null as ok`);
  if (!table?.ok) throw new WorkerStartError('the database has no Hogee schema: run the packages/db migrations first');
  await checkDeploymentOnChain(d);
}

/**
 * The deployment as the chain reports it (fail closed): the lender and oracle keys are its roles; the manifest names
 * the escrow and sales oracle Treasury links (re-check L9); on final-1, no worker key is the observer (re-check L-3).
 */
export async function checkDeploymentOnChain(d: PreflightTarget): Promise<void> {
  const treasury = d.deployment.contracts.Treasury.address;
  const [lender, oracle] = await Promise.all([
    d.client.readContract({ address: d.deployment.contracts.PlanRegistry.address, abi: iPlanRegistryAbi, functionName: 'lender' }),
    d.client.readContract({ address: treasury, abi: treasuryExtraAbi, functionName: 'oracle' }),
  ]);
  if (getAddress(lender) !== getAddress(d.signers.lender.address)) throw new WorkerStartError(`the ${d.signers.set} lender key is not the deployment's lender`);
  if (getAddress(oracle) !== getAddress(d.signers.oracle.address)) throw new WorkerStartError(`the ${d.signers.set} oracle key is not the deployment's oracle`);
  if (await checkLinks(d)) await checkObserver(d);
}

const readTreasury = (d: PreflightTarget, functionName: 'escrow' | 'salesOracle' | 'observer'): Promise<Address> =>
  d.client.readContract({ address: d.deployment.contracts.Treasury.address, abi: treasuryExtraAbi, functionName });

/**
 * Re-check L9. A manifest with MilestoneEscrow (final-1) must name the escrow and sales oracle Treasury links. One
 * without it must not front a Treasury that links an escrow: the MilestoneFunded orphan watch and the observer mirror
 * key off the manifest's MilestoneEscrow, so they would be silently off. A reverting escrow() is the loop-1-src
 * Treasury (no such view): the loop-1 shape, fine. Any other read error propagates. Returns whether it is final-1.
 */
async function checkLinks(d: PreflightTarget): Promise<boolean> {
  const { MilestoneEscrow: escrow, SalesOracle: sales } = d.deployment.contracts;
  if (!escrow) {
    const linked = await readTreasury(d, 'escrow').catch((error: unknown) => {
      if (error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionRevertedError)) return zeroAddress;
      throw error;
    });
    if (getAddress(linked) !== zeroAddress) {
      throw new WorkerStartError(`the manifest has no MilestoneEscrow, but Treasury.escrow() is ${getAddress(linked)}: use the deployment's full final-1 manifest`);
    }
    return false;
  }
  const [linkedEscrow, linkedSales] = await Promise.all([readTreasury(d, 'escrow'), readTreasury(d, 'salesOracle')]);
  if (getAddress(linkedEscrow) !== escrow.address) {
    throw new WorkerStartError(`the manifest's MilestoneEscrow ${escrow.address} is not Treasury.escrow() ${getAddress(linkedEscrow)}`);
  }
  if (!sales || getAddress(linkedSales) !== sales.address) {
    throw new WorkerStartError(`the manifest's SalesOracle ${sales?.address ?? '(none)'} is not Treasury.salesOracle() ${getAddress(linkedSales)}`);
  }
  return true;
}

/**
 * Re-check L-3. The observer's cancelLoosen veto survives TIGHTEN_REVOKE_AGENT; on a key this worker holds it could
 * cancel every co-signed UNPAUSE. The contracts keep the agent, owner EOA, lender and oracle off it, not the relayer.
 * Zero = no observer.
 */
async function checkObserver(d: PreflightTarget): Promise<void> {
  const observer = getAddress(await readTreasury(d, 'observer'));
  if (observer === zeroAddress) return;
  const { agent, oracle, lender, relayer } = d.signers;
  const roles = { agent, oracle, lender, relayer } as const;
  for (const [role, account] of Object.entries(roles)) {
    if (getAddress(account.address) === observer) {
      throw new WorkerStartError(`the ${d.signers.set} ${role} key is the deployment's observer (Treasury.observer()): the cancelLoosen veto must sit on a key the worker does not hold`);
    }
  }
}

/**
 * A `nonces` row for every worker key before any job runs (audit run-4). The reconcile nonce check can only report a
 * use outside the allocator (EXTERNAL_AGENT_KEY_USE, EXTERNAL_KEY_USE) for a key that has a row, and a key's first
 * allocation would otherwise absorb an outside use made before it. An existing row is never moved.
 */
async function seedNonceRows(d: JobDeps): Promise<void> {
  for (const role of ['agent', 'oracle', 'lender', 'relayer'] as const) {
    await seedNonce(d.db, { signer: d.signers[role].address, chainId: d.deployment.chainId, client: d.client });
  }
}

export async function createWorkerApp(env: Record<string, string | undefined>, log: Logger, exit: (code: number) => void = (code) => process.exit(code)): Promise<WorkerApp> {
  const config = loadWorkerConfig(env);
  const signers = loadSigners(env, config.keySet, { scrub: true });
  // PAYOUT_RAIL=xendit: XENDIT_SECRET_KEY is read once (test-mode keys only) and scrubbed from env, like the signer keys.
  const xendit = config.payoutRail === 'xendit' ? xenditRailFromEnv(env, { scrub: true }) : undefined;
  const deployment = deploymentOf(config);
  const db = createDb(config.databaseUrl, { maxConnections: WORKER_POOL_MAX });
  db.$client.on('error', (error: unknown) => log.error('pg_pool_error', { error }));
  applySessionTimeouts(db.$client, config.dbTimeouts, log);
  const client = createHogeePublicClient(config.chain);
  // Routed by payee channel (rail/route.ts): Singapore (SG_PAYNOW) always pays out on MockRail, never on Xendit.
  const rail = new PayoutRouter({ mock: new MockRail(db.$client), ...(xendit ? { xendit } : {}) });
  const deps: JobDeps = { db, client, signers, deployment, config, log, rail };
  try {
    await migrateWorkerSchema(db.$client);
    await preflight(deps);
    await publishRoles(db.$client, deployment, signers);
    await seedNonceRows(deps);
  } catch (error: unknown) {
    await db.$client.end();
    throw error;
  }
  const facilities = async () => (await facilitiesFor(db.$client, { deploymentId: deployment.deploymentId, chainId: deployment.chainId })).map((f) => f.facilityId);
  const locked = (job: WorkerQueue, fn: (ids: readonly string[]) => Promise<unknown>) => lockedJob(db.$client, log, job, facilities, fn);
  log.info('worker_ready', { deploymentId: deployment.deploymentId, chainId: deployment.chainId, signers: signers.set, agent: signers.agent.address, oracle: signers.oracle.address, payoutRail: deps.rail?.name });
  /** The crash-recovery demo: after a job that broadcast, an armed flag (API DEMO_MODE) stops the process at once. */
  const crashIfArmed = async (job: WorkerQueue, broadcast: boolean): Promise<void> => {
    if (!broadcast || !(await consumeCrashFlag(db.$client))) return;
    log.warn('demo_crash_after_broadcast', { job });
    exit(1);
  };
  const relayed = (reports: readonly { actions: readonly { result: string }[] }[]) => reports.some((r) => r.actions.some((a) => a.result === 'sent'));
  // Audit run-9 lead 3: every recorded sale wakes cfo-guard; a facility still runs at most one pass per interval.
  const guardPacer = new GuardPacer();
  return {
    config,
    deps,
    handlers: {
      'autonomous-tick': locked('autonomous-tick', async (ids) => {
        if (!(await autonomyRunning(db.$client))) {
          log.info('tick_skipped_autonomy_stopped', {});
          return;
        }
        for (const id of ids) {
          const report = await runTick(deps, id);
          await crashIfArmed('autonomous-tick', report.lines.some((l) => l.txHash !== undefined));
        }
      }),
      reconcile: locked('reconcile', (ids) => runReconcile(deps, ids)),
      'settle-spend': locked('settle-spend', (ids) => runSettle(deps, ids)),
      // Re-check LOW 5: a pending pause or cancelLoosen waits for the job lock instead of the next cron (relay-wake.ts).
      relay: async () => {
        const r = await relayWake(deps, facilities);
        await crashIfArmed('relay', relayed(r.reports));
      },
      'record-sale': locked('record-sale', async (ids) => crashIfArmed('record-sale', relayed(await runRelay(deps, ids, { oracle: true })))),
      'timelock-executor': locked('timelock-executor', async (ids) => {
        await runTimelockExecutor(deps, ids);
        await crashIfArmed('timelock-executor', relayed(await runRelay(deps, ids)));
      }),
      'stage-gate': locked('stage-gate', (ids) => runStageGate(deps, ids)),
      'agent-actions': locked('agent-actions', async (ids) => {
        await runAgentActions(deps, ids);
        await crashIfArmed('agent-actions', relayed(await runRelay(deps, ids)));
      }),
      'cfo-guard': locked('cfo-guard', (ids) => runCfoGuard(deps, ids, { pacer: guardPacer })),
    },
    close: () => db.$client.end(),
  };
}
