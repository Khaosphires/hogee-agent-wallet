/**
 * Multi-contract event decoding (final-1). Every ABI inherits IHogeeEvents, so any Hogee event decodes from any
 * address; HOGEE_EVENT_SOURCES says which contract emits each one, and a watcher bound to a contract refuses events
 * that contract never emits. SaleRecorded comes from SalesOracle; RevenueRecorded / ReserveSkimmed from Treasury (the
 * creditRevenue hook); the milestone events from MilestoneEscrow; the governance module's events (delegatecall),
 * PayeeBound for ADD_PAYEE and Unpaused from Treasury's address.
 */
import { encodeAbiParameters, encodeEventTopics, getAbiItem, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_NAMES,
  HOGEE_EVENT_SOURCES,
  decodeHogeeLogs,
  hogeeWatchTargets,
  iMilestoneEscrowAbi,
  iPlanRegistryAbi,
  iSalesOracleAbi,
  iTreasuryAbi,
  memoryLogCursor,
  pollLogs,
  readDeploymentLogs,
  readLogs,
  type DeploymentContracts,
  type LogReader,
} from '../src/index';

const ADDR = {
  PlanRegistry: '0x00000000000000000000000000000000000000aa',
  Treasury: '0x00000000000000000000000000000000000071e5',
  MilestoneEscrow: '0x000000000000000000000000000000000000e5c0',
  SalesOracle: '0x00000000000000000000000000000000000005a1',
} as const satisfies Record<string, Address>;
const FINAL_1: DeploymentContracts = {
  PlanRegistry: { address: ADDR.PlanRegistry },
  Treasury: { address: ADDR.Treasury },
  MilestoneEscrow: { address: ADDR.MilestoneEscrow },
  SalesOracle: { address: ADDR.SalesOracle },
};
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const eventNames = (abi: readonly { type: string; name?: string }[]) => abi.filter((x) => x.type === 'event').map((x) => x.name as string);

/** A raw log of `eventName` with zero-ish non-indexed data, at `address`, block `block`, log index `index`. */
function rawLog(eventName: string, address: Address, block: bigint, index: number, args: Record<string, unknown> = {}): Log {
  const event = getAbiItem({ abi: iTreasuryAbi, name: eventName as never }) as AbiEvent;
  const indexed = Object.fromEntries(event.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name ?? ''] ?? defaultOf(i.type)]));
  const topics = encodeEventTopics({ abi: [event], eventName, args: indexed } as never) as Hex[];
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    event.inputs.filter((i) => !i.indexed).map((i) => args[i.name ?? ''] ?? defaultOf(i.type)),
  );
  return {
    address,
    topics: topics as [Hex, ...Hex[]],
    data,
    blockNumber: block,
    blockHash: h(9000 + Number(block)),
    transactionHash: h(8000 + Number(block) * 10 + index),
    transactionIndex: 0,
    logIndex: index,
    removed: false,
  };
}

function defaultOf(type: string): unknown {
  if (type === 'address') return ADDR.PlanRegistry;
  if (type === 'bool') return false;
  if (type.startsWith('uint') || type.startsWith('int')) return 1n;
  return h(1);
}

function fakeRpc(logs: Log[], head = 50n): LogReader {
  return {
    getBlock: async () => ({ number: head }),
    getLogs: async ({ address, fromBlock, toBlock }) =>
      logs.filter((l) => l.address.toLowerCase() === address.toLowerCase() && (l.blockNumber ?? -1n) >= fromBlock && (l.blockNumber ?? -1n) <= toBlock),
  };
}

describe('HOGEE_EVENT_SOURCES', () => {
  it('names exactly one emitting contract for every Hogee event of every ABI', () => {
    const all = new Set([...eventNames(iTreasuryAbi), ...eventNames(iMilestoneEscrowAbi), ...eventNames(iSalesOracleAbi), ...eventNames(iPlanRegistryAbi)]);
    expect(Object.keys(HOGEE_EVENT_SOURCES).sort()).toEqual([...all].sort());
    for (const source of Object.values(HOGEE_EVENT_SOURCES)) expect(CONTRACT_NAMES).toContain(source);
  });

  it('final-1: sales from SalesOracle, revenue and skim from Treasury, milestones from MilestoneEscrow, governance from Treasury', () => {
    expect(HOGEE_EVENT_SOURCES.SaleRecorded).toBe('SalesOracle');
    expect([HOGEE_EVENT_SOURCES.RevenueRecorded, HOGEE_EVENT_SOURCES.ReserveSkimmed]).toEqual(['Treasury', 'Treasury']);
    expect([HOGEE_EVENT_SOURCES.MilestoneFunded, HOGEE_EVENT_SOURCES.MilestoneReleased]).toEqual(['MilestoneEscrow', 'MilestoneEscrow']);
    const governance = ['OwnerSpent', 'StageReleased', 'LoosenQueued', 'LoosenExecuted', 'LoosenCancelled', 'ReserveWithdrawn', 'PayeeBound', 'Unpaused'] as const;
    expect(governance.map((e) => HOGEE_EVENT_SOURCES[e])).toEqual(governance.map(() => 'Treasury'));
    expect([HOGEE_EVENT_SOURCES.PlanCommitted, HOGEE_EVENT_SOURCES.FounderKeyRegistered]).toEqual(['PlanRegistry', 'PlanRegistry']);
  });

  it('hogeeWatchTargets: every deployed contract with its address (loop-1 has no escrow or oracle)', () => {
    expect(hogeeWatchTargets(FINAL_1)).toEqual([
      { source: 'PlanRegistry', address: ADDR.PlanRegistry },
      { source: 'Treasury', address: ADDR.Treasury },
      { source: 'MilestoneEscrow', address: ADDR.MilestoneEscrow },
      { source: 'SalesOracle', address: ADDR.SalesOracle },
    ]);
    expect(hogeeWatchTargets({ PlanRegistry: FINAL_1.PlanRegistry, Treasury: FINAL_1.Treasury }).map((t) => t.source)).toEqual(['PlanRegistry', 'Treasury']);
  });
});

describe('decoding per contract', () => {
  const sale = rawLog('SaleRecorded', ADDR.SalesOracle, 5n, 0, { saleIdHash: h(77), amountBucket: 12_000n });
  const forgedRevenue = rawLog('RevenueRecorded', ADDR.SalesOracle, 5n, 1, { saleIdHash: h(77) });

  it('keeps the events the source emits and refuses any other (a mis-wired address or a hostile provider)', () => {
    const [decoded] = decodeHogeeLogs([sale], 'SalesOracle');
    expect(decoded?.eventName === 'SaleRecorded' && decoded.args).toMatchObject({ saleIdHash: h(77), amountBucket: 12_000n });
    expect(() => decodeHogeeLogs([sale, forgedRevenue], 'SalesOracle')).toThrow(/RevenueRecorded is not emitted by SalesOracle/);
    expect(() => decodeHogeeLogs([rawLog('MilestoneReleased', ADDR.Treasury, 5n, 2)], 'Treasury')).toThrow(/MilestoneReleased/);
    expect(decodeHogeeLogs([sale, forgedRevenue]).map((l) => l.eventName)).toEqual(['SaleRecorded', 'RevenueRecorded']); // no source: decode only
  });

  it('readLogs / pollLogs with a source: a misattributed event fails the chunk and the cursor does not move', async () => {
    const client = fakeRpc([sale, forgedRevenue]);
    await expect(readLogs(client, { address: ADDR.SalesOracle, source: 'SalesOracle', fromBlock: 1n, toBlock: 10n })).rejects.toThrow(/not emitted by/);
    const cursor = memoryLogCursor(1n);
    const seen: string[] = [];
    const poll = (c: LogReader) => pollLogs(c, { address: ADDR.SalesOracle, source: 'SalesOracle', tag: 'finalized', cursor, maxChunks: 1 }, async (b) => void seen.push(...b.map((l) => l.eventName)));
    await expect(poll(client)).rejects.toThrow(/not emitted by/);
    expect(seen).toEqual([]);
    const retry = await poll(fakeRpc([sale]));
    expect([retry.ranges[0], seen]).toEqual([{ fromBlock: 1n, toBlock: 10n }, ['SaleRecorded']]);
  });

  it('readDeploymentLogs: every contract of the deployment, each log checked against and tagged with its source, in chain order', async () => {
    const logs = [
      rawLog('MilestoneFunded', ADDR.MilestoneEscrow, 7n, 0, { orderId: h(5), idx: 1 }),
      rawLog('SaleRecorded', ADDR.SalesOracle, 5n, 0, { saleIdHash: h(77) }),
      rawLog('ReserveSkimmed', ADDR.Treasury, 5n, 2, { saleIdHash: h(77) }),
      rawLog('RevenueRecorded', ADDR.Treasury, 5n, 1, { saleIdHash: h(77) }),
      rawLog('LoosenQueued', ADDR.Treasury, 12n, 0, { loosenId: h(9), kind: 6 }),
      rawLog('PlanCommitted', ADDR.PlanRegistry, 3n, 4, { planId: h(3), version: 1 }),
      rawLog('MilestoneReleased', ADDR.MilestoneEscrow, 7n, 1, { orderId: h(5), idx: 1 }),
    ];
    const got = await readDeploymentLogs(fakeRpc(logs), { contracts: FINAL_1, fromBlock: 1n, toBlock: 20n });
    expect(got.map((l) => [l.blockNumber, l.logIndex, l.source, l.eventName])).toEqual([
      [3n, 4, 'PlanRegistry', 'PlanCommitted'],
      [5n, 0, 'SalesOracle', 'SaleRecorded'],
      [5n, 1, 'Treasury', 'RevenueRecorded'],
      [5n, 2, 'Treasury', 'ReserveSkimmed'],
      [7n, 0, 'MilestoneEscrow', 'MilestoneFunded'],
      [7n, 1, 'MilestoneEscrow', 'MilestoneReleased'],
      [12n, 0, 'Treasury', 'LoosenQueued'],
    ]);
    const forged = [...logs, rawLog('SaleRecorded', ADDR.Treasury, 9n, 0)];
    await expect(readDeploymentLogs(fakeRpc(forged), { contracts: FINAL_1, fromBlock: 1n, toBlock: 20n })).rejects.toThrow(/SaleRecorded is not emitted by Treasury/);
  });
});
