/**
 * Operator commands (`pnpm --filter @hogee/worker ops <command>`), run on the worker host with DATABASE_URL set:
 *   status                         active halt (if any) with every reason not yet acknowledged (with its event id),
 *                                  every open safety-pause request, and the latest heartbeat of every job
 *   halt --reason <text>           manual kill switch: stop new signing and payouts now
 *   resume --note <text> --ack-through <id> [--abandon-pause] [--by x]
 *                                  clear the active halt after checking its causes (the note is stored). It
 *                                  acknowledges the reasons up to event <id> (the last one `status` showed;
 *                                  required whenever unacknowledged reasons exist) and refuses if a newer one exists.
 *                                  It refuses while a safety pause of the halt is still open (Treasury.paused() not
 *                                  confirmed) unless --abandon-pause, which closes those requests.
 * Reads no key and signs nothing.
 */
import { createDb, type Db } from '@hogee/db';
import { createLogger, type Logger } from '../runtime/log';
import { activeHalt, clearHalt, haltReasons, raiseHalt, type HaltReason } from '../store/halt';
import { readHeartbeats } from '../store/heartbeat';
import { openSafetyPauses, type SafetyPauseRequest } from '../store/safety-pause';
import { migrateWorkerSchema } from '../store/schema';

export interface OpsDeps {
  readonly db: Db;
  readonly log: Logger;
  readonly print: (line: string) => void;
}

const USAGE = 'usage: ops status | ops halt --reason <text> | ops resume --note <text> --ack-through <event id> [--abandon-pause] [--by <name>]';
const EVENT_ID_RE = /^[0-9]{1,18}$/;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const reasonLine = (r: HaltReason): string => `  - #${r.id} ${r.raisedAt.toISOString()} ${r.reason} ${JSON.stringify(r.detail)}`;
const pauseLine = (p: SafetyPauseRequest): string =>
  `  - ${p.id} (halt #${p.haltId}, ${p.reason}): ${plural(p.attempts, 'attempt')}, last ${p.lastAttemptId ?? 'none'}${p.lastError ? `, last error: ${p.lastError}` : ''}`;

/** Runs one command; returns the process exit code (0 done, 1 refused, 2 usage). */
export async function runOps(argv: readonly string[], d: OpsDeps): Promise<number> {
  const [command, ...args] = argv;
  const pool = d.db.$client;
  switch (command) {
    case 'status': {
      const halt = await activeHalt(pool);
      d.print(halt ? `HALTED since ${halt.haltedAt.toISOString()}: ${halt.reason} ${JSON.stringify(halt.detail)}` : 'running (no active halt)');
      if (halt) {
        const open = (await haltReasons(pool, halt.id)).filter((r) => r.acknowledgedAt === null);
        const last = open.at(-1)?.id;
        d.print(`  ${plural(open.length, 'unacknowledged reason')} (check each${last ? `, then \`ops resume --note <text> --ack-through ${last}\`` : ''}):`);
        for (const r of open) d.print(reasonLine(r));
      }
      const pauses = await openSafetyPauses(pool);
      if (pauses.length > 0) {
        d.print(`${plural(pauses.length, 'open safety pause request')} (Treasury.paused() not confirmed yet; \`ops resume\` refuses until they close, or --abandon-pause):`);
        for (const p of pauses) d.print(pauseLine(p));
      }
      for (const b of await readHeartbeats(pool)) d.print(`${b.job} [${b.scope}] ${b.status} at ${b.beatAt.toISOString()} (beats: ${b.beats})`);
      return 0;
    }
    case 'halt': {
      const reason = flag(args, 'reason');
      if (!reason) return usage(d);
      const { halt, raised } = await raiseHalt(pool, d.log, 'OPERATOR_HALT', { note: reason });
      d.print(raised ? `halted: ${halt.reason}` : `already halted: ${halt.reason}`);
      return 0;
    }
    case 'resume': {
      const note = flag(args, 'note');
      // Without --ack-through nothing may be acknowledged: any unacknowledged reason refuses the resume.
      const ackThrough = args.includes('--ack-through') ? flag(args, 'ack-through') : '0';
      if (!note || !ackThrough || !EVENT_ID_RE.test(ackThrough)) return usage(d);
      const result = await clearHalt(pool, d.log, { by: flag(args, 'by') ?? 'ops-cli', note, ackThrough, abandonPause: args.includes('--abandon-pause') });
      switch (result.status) {
        case 'none':
          d.print('nothing to resume: no active halt');
          return 0;
        case 'newer_events':
          d.print(`refused: ${plural(result.newer.length, 'unacknowledged reason')} after #${ackThrough} (check each, then pass --ack-through <the last id>):`);
          for (const r of result.newer) d.print(reasonLine(r));
          return 1;
        case 'open_pauses':
          d.print(`refused: ${plural(result.open.length, 'safety pause request')} of this halt still open (Treasury.paused() not confirmed):`);
          for (const p of result.open) d.print(pauseLine(p));
          d.print('wait for reconcile to confirm the pause, or pause the treasury yourself and re-run with --abandon-pause');
          return 1;
        case 'cleared': {
          const { halt, acknowledged, abandoned } = result;
          d.print(`resumed: cleared ${halt.reason} (halted since ${halt.haltedAt.toISOString()})`);
          d.print(`acknowledged ${plural(acknowledged.length, 'reason')}: ${acknowledged.map((r) => r.reason).join(', ')}`);
          if (abandoned.length > 0) d.print(`abandoned ${plural(abandoned.length, 'safety pause')}: ${abandoned.join(', ')}`);
          return 0;
        }
      }
    }
    default:
      return usage(d);
  }
}

function usage(d: OpsDeps): number {
  d.print(USAGE);
  return 2;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(2);
  }
  const db = createDb(url, { maxConnections: 2 });
  try {
    await migrateWorkerSchema(db.$client);
    const code = await runOps(process.argv.slice(2), { db, log: createLogger({ base: { svc: 'worker-ops' } }), print: (s) => process.stdout.write(`${s}\n`) });
    process.exitCode = code;
  } finally {
    await db.$client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`ops failed: ${error instanceof Error ? error.name : 'error'}\n`);
    process.exit(1);
  });
}
