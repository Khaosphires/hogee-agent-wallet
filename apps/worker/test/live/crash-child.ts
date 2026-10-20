/**
 * Crash child for crash.live.test.ts: runs one autonomous tick and SIGKILLs itself at a durable checkpoint
 * (`inserted`, `signed` or `broadcast`), like `kill -9` landing mid-tick. Params arrive as JSON in CRASH_CHILD; the
 * runtime-generated test role keys arrive as *_PRIVATE_KEY_LOOP env values and are read by the worker's own loader.
 */
import { writeSync } from 'node:fs';
import { createHogeePublicClient, parseDeployment } from '@hogee/chain';
import { createDb } from '@hogee/db';
import { parseEther } from 'viem';
import { loadSigners } from '../../src/config/keys';
import type { TickStep } from '../../src/jobs/deps';
import { runTick } from '../../src/jobs/tick';
import { silentLogger } from '../../src/runtime/log';

interface ChildParams {
  readonly dbUrl: string;
  readonly rpcUrl: string;
  readonly deployment: unknown;
  readonly facilityId: string;
  readonly crashAt: TickStep;
}

async function main(): Promise<void> {
  const raw = process.env.CRASH_CHILD;
  if (!raw) throw new Error('CRASH_CHILD is not set');
  const p = JSON.parse(raw) as ChildParams;
  const signers = loadSigners(process.env, 'LOOP', { scrub: true });
  const db = createDb(p.dbUrl, { maxConnections: 2 });
  const client = createHogeePublicClient({ chain: 'local', rpcUrls: [p.rpcUrl], pollingIntervalMs: 50 });
  await runTick(
    {
      db,
      client,
      signers,
      deployment: parseDeployment(p.deployment),
      config: { maxFeeWei: 1_000n * 1_000_000_000n, lowBalanceWei: parseEther('0.01'), stuckPendingPasses: 3, payoutMaxAttempts: 3 },
      log: silentLogger,
      onStep: (step, paymentId) => {
        if (step !== p.crashAt) return;
        // Synchronous write: async pipe writes can be lost on SIGKILL.
        writeSync(1, `${JSON.stringify({ step, paymentId })}\n`);
        process.kill(process.pid, 'SIGKILL');
      },
    },
    p.facilityId,
  );
  writeSync(1, `${JSON.stringify({ step: 'completed' })}\n`);
  process.exit(3); // the checkpoint was never reached
}

main().catch((error: unknown) => {
  writeSync(2, `crash-child failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
