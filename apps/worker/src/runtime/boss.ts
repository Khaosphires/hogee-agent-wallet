/**
 * pg-boss wiring (§12.4): one queue per job, each `exclusive` (at most one job queued or active, so a slow tick never piles
 * up a backlog), no automatic retries (the next scheduled run is the retry), crons in UTC. Each handler runs with
 * local concurrency 1. pg-boss errors are logged through the redacting logger (its messages can carry the URL).
 */
import { PgBoss } from 'pg-boss';
import type { Logger } from './log';

/** The API wakes relay, record-sale, agent-actions, timelock-executor, stage-gate and cfo-guard by queue name (packages/api API_JOBS). */
// VISION-DECISIONS §7: + cfo-guard (the CFO's bounded tightening; v-cfo fills jobs/cfo-guard.ts).
export const WORKER_QUEUES = ['autonomous-tick', 'reconcile', 'settle-spend', 'relay', 'record-sale', 'timelock-executor', 'stage-gate', 'agent-actions', 'cfo-guard'] as const;
export type WorkerQueue = (typeof WORKER_QUEUES)[number];

export interface BossOptions {
  readonly connectionString: string;
  /** pg-boss schema (default `pgboss`). */
  readonly schema?: string;
  readonly schedules: Readonly<Record<WorkerQueue, string>>;
  readonly handlers: Readonly<Record<WorkerQueue, () => Promise<void>>>;
  readonly log: Logger;
  readonly pollingIntervalSeconds?: number;
}

/**
 * pg-boss fails a job that stays active longer than this. After a crash the dead job blocks its exclusive queue until
 * it expires, so keep it short; a job that really runs longer is still protected by the job lock (no overlap), and
 * the worker reconciles and ticks at boot without waiting for pg-boss.
 */
const EXPIRE_SECONDS = 300;

export async function startBoss(o: BossOptions): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: o.connectionString, schema: o.schema ?? 'pgboss', application_name: 'hogee-worker', max: 4 });
  boss.on('error', (error: unknown) => o.log.error('pgboss_error', { error }));
  await boss.start();
  for (const queue of WORKER_QUEUES) {
    await boss.createQueue(queue, { policy: 'exclusive', retryLimit: 0, expireInSeconds: EXPIRE_SECONDS });
    await boss.updateQueue(queue, { retryLimit: 0, expireInSeconds: EXPIRE_SECONDS }); // createQueue keeps an existing queue's options
    await boss.schedule(queue, o.schedules[queue], {}, { tz: 'UTC' });
    const handler = o.handlers[queue];
    await boss.work(queue, { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: o.pollingIntervalSeconds ?? 2 }, async () => {
      await handler();
    });
  }
  o.log.info('pgboss_started', { queues: WORKER_QUEUES, schedules: o.schedules });
  return boss;
}
