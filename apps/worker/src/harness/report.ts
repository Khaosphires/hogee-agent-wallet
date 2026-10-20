/**
 * The loop:anvil report: what the chain and the DB say after the run, and the acceptance checks of task 1.6 (every
 * ADS slot paid at 7,500, no denials, drift between DB and chain = 0, a skipped slot never proposed).
 */
import { iTreasuryAbi, toBytes32Tag, type DeploymentManifest, type HogeePublicClient } from '@hogee/chain';
import { getAbiItem, type Hex } from 'viem';
import { MINED_STATES } from '../jobs/inflight';
import { activeHalt } from '../store/halt';
import { rows, type Pg } from '../store/pg';
import { WORKER_SCHEMA } from '../store/schema';

export interface SpentFact {
  readonly spendId: Hex;
  readonly txHash: Hex;
  readonly lineId: Hex;
  readonly amountMinor: bigint;
  readonly timestamp: bigint;
  readonly rationaleHash: Hex;
}

export interface PaymentFact {
  readonly id: string;
  readonly intentId: Hex;
  readonly txHash: Hex | null;
  readonly state: string;
  readonly amountMinor: bigint;
  readonly rationaleHash: Hex | null;
}

export interface Drift {
  readonly orphanLogs: readonly SpentFact[];
  readonly missingLogs: readonly PaymentFact[];
  readonly mismatches: readonly string[];
  readonly total: number;
}

const eq = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/** Spent logs vs mined payment rows: each log has its row (same intent, tx and rationale) and vice versa. */
export function computeDrift(spent: readonly SpentFact[], payments: readonly PaymentFact[]): Drift {
  const mined = payments.filter((p) => MINED_STATES.includes(p.state));
  const orphanLogs: SpentFact[] = [];
  const mismatches: string[] = [];
  const matched = new Set<string>();
  for (const log of spent) {
    const row = mined.find((p) => eq(p.intentId, log.spendId) && eq(p.txHash, log.txHash) && eq(p.rationaleHash, log.rationaleHash));
    if (!row) {
      orphanLogs.push(log);
      continue;
    }
    matched.add(row.id);
    if (row.amountMinor !== log.amountMinor) mismatches.push(`${row.id}: amount ${row.amountMinor} on the row, ${log.amountMinor} on chain`);
  }
  const missingLogs = mined.filter((p) => !matched.has(p.id));
  return { orphanLogs, missingLogs, mismatches, total: orphanLogs.length + missingLogs.length + mismatches.length };
}

/** Largest rolling-window sum at any spend: Treasury keeps an entry live while spentAt + window > now. */
export function maxWindowSum(spent: readonly SpentFact[], windowSeconds: bigint): bigint {
  const sorted = [...spent].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let max = 0n;
  for (const s of sorted) {
    const sum = sorted.filter((e) => e.timestamp <= s.timestamp && e.timestamp + windowSeconds > s.timestamp).reduce((acc, e) => acc + e.amountMinor, 0n);
    if (sum > max) max = sum;
  }
  return max;
}

export interface LoopStats {
  readonly iterations: number;
  readonly wallMs: number;
  readonly chainStart: bigint;
  readonly chainEnd: bigint;
  /** `<decision>[:<reason>]` → count, over every tick of the pacing line. */
  readonly outcomes: Readonly<Record<string, number>>;
  /** Chain days on which the line's only outcome was a SKIP (never proposed). */
  readonly skipOnlyDays: readonly number[];
}

export interface ReportInput {
  readonly pool: Pg;
  readonly client: HogeePublicClient;
  readonly deployment: DeploymentManifest;
  readonly facilityId: string;
  readonly lineKey: string;
  readonly pacingMinor: bigint;
  readonly windowCapMinor: bigint;
  readonly windowSeconds: bigint;
  readonly stats: LoopStats;
}

const SPENT = getAbiItem({ abi: iTreasuryAbi, name: 'Spent' });
const DENIED = getAbiItem({ abi: iTreasuryAbi, name: 'Denied' });
const CONFIRMED = getAbiItem({ abi: iTreasuryAbi, name: 'SettlementConfirmed' });

async function chainFacts(i: ReportInput) {
  const range = { address: i.deployment.contracts.Treasury.address, fromBlock: BigInt(i.deployment.blockNumber), toBlock: 'latest' as const };
  const [spentLogs, denied, confirmed] = await Promise.all([
    i.client.getLogs({ ...range, event: SPENT }),
    i.client.getLogs({ ...range, event: DENIED }),
    i.client.getLogs({ ...range, event: CONFIRMED }),
  ]);
  const spent: SpentFact[] = [];
  for (const l of spentLogs) {
    const block = await i.client.getBlock({ blockNumber: l.blockNumber });
    spent.push({ spendId: l.args.spendId as Hex, txHash: l.transactionHash, lineId: l.args.lineId as Hex, amountMinor: l.args.amountMinor as bigint, timestamp: block.timestamp, rationaleHash: l.args.rationaleHash as Hex });
  }
  const lineId = toBytes32Tag(i.lineKey);
  const treasury = i.deployment.contracts.Treasury.address;
  const [sequence, pocket, paused] = await Promise.all([
    i.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'lineSequence', args: [lineId] }),
    i.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'pocket', args: [lineId] }),
    i.client.readContract({ address: treasury, abi: iTreasuryAbi, functionName: 'paused' }),
  ]);
  return { spent, denied: denied.length, confirmed: confirmed.length, sequence: BigInt(sequence), pocketSpent: pocket.spentMinor, paused };
}

async function dbFacts(i: ReportInput) {
  const payments = await rows<{ id: string; intent_id: Hex; tx_hash: Hex | null; state: string; amount_minor: string; rationale_hash: Hex | null; line_key: string }>(
    i.pool,
    `select id, intent_id, tx_hash, state, amount_minor::text as amount_minor, rationale_hash, line_key from payments where facility_id = $1 and kind = 'SPEND'`,
    [i.facilityId],
  );
  const [counts] = await rows<{ denials: number; record_denied: number; policy_denied: number; payouts: number }>(
    i.pool,
    `select (select count(*)::int from denials where facility_id = $1) as denials,
            (select count(*)::int from chain_actions where facility_id = $1 and kind = 'Treasury.recordDenied') as record_denied,
            (select count(*)::int from payments where facility_id = $1 and state = 'POLICY_DENIED') as policy_denied,
            (select count(*)::int from ${WORKER_SCHEMA}.mock_payouts) as payouts`,
    [i.facilityId],
  );
  return { payments, counts: counts ?? { denials: 0, record_denied: 0, policy_denied: 0, payouts: 0 }, halt: await activeHalt(i.pool) };
}

export interface LoopReport {
  readonly ok: boolean;
  readonly text: string;
  readonly summary: Record<string, unknown>;
}

export async function buildReport(i: ReportInput): Promise<LoopReport> {
  const chain = await chainFacts(i);
  const db = await dbFacts(i);
  const facts: PaymentFact[] = db.payments.map((p) => ({ id: p.id, intentId: p.intent_id, txHash: p.tx_hash, state: p.state, amountMinor: BigInt(p.amount_minor), rationaleHash: p.rationale_hash }));
  const drift = computeDrift(chain.spent, facts);
  const lineRows = db.payments.filter((p) => p.line_key === i.lineKey);
  const lineSpent = chain.spent.filter((s) => s.lineId.toLowerCase() === toBytes32Tag(i.lineKey));
  const proposedOnSkipDays = i.stats.skipOnlyDays.filter((day) => lineRows.some((p) => p.id === `pacing:${i.lineKey}:${day}`));
  const settled = lineRows.filter((p) => p.state === 'SETTLED').length;
  const denials = chain.denied + db.counts.denials + db.counts.record_denied + db.counts.policy_denied;
  const windowMax = maxWindowSum(lineSpent, i.windowSeconds);
  const checks: Record<string, boolean> = {
    [`every ${i.lineKey} slot paid at ${i.pacingMinor}`]: lineSpent.length > 0 && lineSpent.every((s) => s.amountMinor === i.pacingMinor),
    'no denials (Denied events, denials rows, recordDenied actions, POLICY_DENIED rows)': denials === 0,
    'drift between DB and chain = 0': drift.total === 0,
    'a skipped slot was never proposed': proposedOnSkipDays.length === 0,
    'lineSequence - 1 = slots paid': chain.sequence - 1n === BigInt(lineSpent.length),
    'rolling window never above its cap': windowMax <= i.windowCapMinor,
    'every paid slot settled and confirmed on-chain': settled === lineSpent.length && chain.confirmed === lineSpent.length,
    'no halt, treasury not paused': db.halt === null && !chain.paused,
  };
  const ok = Object.values(checks).every(Boolean);
  const days = Number(i.stats.chainEnd - i.stats.chainStart) / 86_400;
  const lines = [
    '=== loop:anvil report ===',
    `simulated ${days.toFixed(1)} chain days in ${i.stats.iterations} ticks (${(i.stats.wallMs / 1000).toFixed(1)} s wall clock)`,
    `${i.lineKey}: ${lineSpent.length} slots paid on-chain (Spent), ${lineRows.length} payment rows, ${settled} SETTLED, lineSequence ${chain.sequence}, pocket spent ${chain.pocketSpent}`,
    `slot amounts: ${[...new Set(lineSpent.map((s) => s.amountMinor.toString()))].join(', ') || '-'} minor; max rolling-window sum ${windowMax} (cap ${i.windowCapMinor})`,
    `tick outcomes: ${Object.entries(i.stats.outcomes).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `skip-only chain days: ${i.stats.skipOnlyDays.length} (proposed on any of them: ${proposedOnSkipDays.length})`,
    `denials: Denied events ${chain.denied}, denials rows ${db.counts.denials}, recordDenied actions ${db.counts.record_denied}, POLICY_DENIED rows ${db.counts.policy_denied}`,
    `settlement: ${db.counts.payouts} mock payouts, ${chain.confirmed} SettlementConfirmed`,
    `drift: ${drift.total} (orphan Spent logs ${drift.orphanLogs.length}, mined rows without Spent ${drift.missingLogs.length}, mismatches ${drift.mismatches.length})`,
    `halt: ${db.halt ? `${db.halt.reason} (ACTIVE)` : 'none'}; treasury paused: ${chain.paused}`,
    ...Object.entries(checks).map(([name, pass]) => `[${pass ? 'PASS' : 'FAIL'}] ${name}`),
    ok ? 'RESULT: PASS' : 'RESULT: FAIL',
  ];
  const summary = { ok, slotsPaid: lineSpent.length, settled, denials, drift: drift.total, windowMax: windowMax.toString(), outcomes: i.stats.outcomes, checks };
  return { ok, text: lines.join('\n'), summary };
}
