/**
 * Worker process entry: `pnpm --filter @hogee/worker start` (env-configured; see README). The only process that signs
 * (D19). At boot it runs reconcile (crash recovery) and one tick, then hands the schedules to pg-boss. SIGINT/SIGTERM
 * stop pg-boss gracefully (running jobs finish; every job is resumable anyway) and close the pool; a second signal
 * exits at once.
 */
import { shortErrorReason } from '@hogee/chain';
import type { PgBoss } from 'pg-boss';
import { createWorkerApp, type WorkerApp } from './runtime/app';
import { startBoss } from './runtime/boss';
import { createLogger } from './runtime/log';

const log = createLogger({ base: { svc: 'hogee-worker' } });
const SHUTDOWN_TIMEOUT_MS = 30_000;

let app: WorkerApp | undefined;
let boss: PgBoss | undefined;
let stopping = false;

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) {
    log.warn('shutdown_forced', { reason });
    process.exit(1);
  }
  stopping = true;
  log.info('shutdown_requested', { reason });
  try {
    await boss?.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS, close: true });
    await app?.close();
    log.info('shutdown_complete', { reason });
  } catch (error: unknown) {
    log.error('shutdown_failed', { error });
    code = code || 1;
  }
  process.exit(code);
}

async function main(): Promise<void> {
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (error: unknown) => {
    log.error('unhandled_rejection', { error });
    void shutdown('unhandledRejection', 1);
  });
  // Node would print the raw stack (which can carry a provider URL); log it redacted instead.
  process.on('uncaughtException', (error: unknown) => {
    log.error('uncaught_exception', { error });
    void shutdown('uncaughtException', 1);
  });
  app = await createWorkerApp(process.env, log);
  await app.handlers.reconcile();
  await app.handlers['autonomous-tick']();
  if (stopping) return;
  const s = app.config.schedules;
  boss = await startBoss({
    connectionString: app.config.databaseUrl,
    schedules: {
      'autonomous-tick': s.tick,
      reconcile: s.reconcile,
      'settle-spend': s.settle,
      relay: s.relay,
      'record-sale': s.recordSale,
      'timelock-executor': s.timelock,
      'stage-gate': s.stageGate,
      'agent-actions': s.agentActions,
      'cfo-guard': s.cfoGuard,
    },
    handlers: app.handlers,
    log,
  });
}

main().catch((error: unknown) => {
  log.error('worker_start_failed', { error: shortErrorReason(error, 300) });
  void app?.close();
  process.exit(1);
});
