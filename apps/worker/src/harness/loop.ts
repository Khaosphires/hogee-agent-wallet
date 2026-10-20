/**
 * The loop driver for `loop:anvil`: the production jobs (runTick, runReconcile, runSettle) driven on Anvil with
 * time warp. Each iteration moves the chain clock by a jittered tick interval (§12.4: 15–30 min), runs one tick,
 * waits for its transactions, mines past Anvil's `finalized` (latest − 64), reconciles and settles. It stops at the
 * chain-day or wall-clock limit, then drains settlement so every paid slot ends SETTLED.
 */
import type { LineKey } from '@hogee/core';
import type { createTestClient } from 'viem';
import type { JobDeps } from '../jobs/deps';
import { chainDay } from '../jobs/decide';
import { runReconcile } from '../jobs/reconcile';
import { runSettle } from '../jobs/settle';
import { runTick } from '../jobs/tick';
import { activeHalt } from '../store/halt';
import { poolOf, rows } from '../store/pg';
import type { LoopStats } from './report';

export interface LoopOptions {
  readonly deps: JobDeps;
  readonly test: ReturnType<typeof createTestClient>;
  readonly facilityId: string;
  readonly lineKey: LineKey;
  /** Chain seconds per tick, drawn uniformly from [min, max]. */
  readonly stepSeconds: { readonly min: number; readonly max: number };
  readonly chainDays?: number;
  readonly wallMs?: number;
  readonly random: () => number;
  readonly progress: (line: string) => void;
  /** Minimum wall-clock ms per iteration (a real-time soak); 0 = as fast as the node allows. */
  readonly paceMs?: number;
}

/** Anvil's `finalized` lags `latest` by 64 blocks. */
const FINALITY_BLOCKS = 65;

/** Deterministic PRNG for the tick jitter (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function settlementOpen(o: LoopOptions): Promise<number> {
  const [r] = await rows<{ n: number }>(
    poolOf(o.deps.db),
    `select count(*)::int as n from payments where facility_id = $1 and state not in ('SETTLED', 'SETTLEMENT_FAILED', 'POLICY_DENIED', 'REVERTED', 'CANCELLED')`,
    [o.facilityId],
  );
  return Number(r?.n ?? 0);
}

async function backOffice(o: LoopOptions): Promise<void> {
  await o.test.mine({ blocks: FINALITY_BLOCKS });
  await runReconcile(o.deps, [o.facilityId]);
  await runSettle(o.deps, [o.facilityId]);
}

export async function runLoop(o: LoopOptions): Promise<LoopStats> {
  const started = Date.now();
  const chainStart = (await o.deps.client.getBlock({ blockTag: 'latest' })).timestamp;
  const outcomes: Record<string, number> = {};
  const dayDecisions = new Map<number, Set<string>>();
  let iterations = 0;
  let lastDay = chainDay(chainStart);
  for (;;) {
    const iterationStart = Date.now();
    const step = Math.round(o.stepSeconds.min + o.random() * (o.stepSeconds.max - o.stepSeconds.min));
    await o.test.increaseTime({ seconds: step });
    await o.test.mine({ blocks: 1 });
    const tick = await runTick(o.deps, o.facilityId);
    if (tick.status === 'halted' || (await activeHalt(poolOf(o.deps.db)))) throw new Error(`the worker halted: ${tick.detail ?? 'see the halts table'}`);
    if (tick.status !== 'ok') outcomes[`tick:${tick.status}`] = (outcomes[`tick:${tick.status}`] ?? 0) + 1;
    for (const line of tick.lines.filter((l) => l.lineKey === o.lineKey)) {
      const key = line.reason ? `${line.decision}:${line.reason}` : line.decision;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (tick.chainDay !== undefined) dayDecisions.set(tick.chainDay, new Set([...(dayDecisions.get(tick.chainDay) ?? []), line.decision]));
      if (line.txHash) await o.deps.client.waitForTransactionReceipt({ hash: line.txHash });
    }
    await backOffice(o);
    iterations += 1;
    const now = (await o.deps.client.getBlock({ blockTag: 'latest' })).timestamp;
    if (chainDay(now) !== lastDay) {
      lastDay = chainDay(now);
      o.progress(`chain day ${(Number(now - chainStart) / 86_400).toFixed(1)}: ${iterations} ticks, outcomes ${JSON.stringify(outcomes)}`);
    }
    const chainDone = o.chainDays !== undefined && now - chainStart >= BigInt(Math.round(o.chainDays * 86_400));
    const wallDone = o.wallMs !== undefined && Date.now() - started >= o.wallMs;
    if (chainDone || wallDone) break;
    const rest = (o.paceMs ?? 0) - (Date.now() - iterationStart);
    if (rest > 0) await new Promise((r) => setTimeout(r, rest));
  }
  for (let round = 0; round < 8 && (await settlementOpen(o)) > 0; round += 1) await backOffice(o);
  const chainEnd = (await o.deps.client.getBlock({ blockTag: 'latest' })).timestamp;
  const skipOnlyDays = [...dayDecisions.entries()].filter(([, d]) => d.size === 1 && d.has('skip')).map(([day]) => day);
  return { iterations, wallMs: Date.now() - started, chainStart, chainEnd, outcomes, skipOnlyDays };
}
