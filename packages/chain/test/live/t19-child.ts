/**
 * T19 child process: signs + stores a spend, broadcasts it, then SIGKILLs itself BEFORE the "BROADCAST"
 * db write, exactly like `kill -9` landing between broadcast and the state update. Spawned by
 * t19.live.test.ts with `node --import tsx`; params arrive as JSON in T19_CHILD (test-only Anvil key).
 */
import { writeSync } from 'node:fs';
import { createDb } from '@hogee/db';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { broadcast, createHogeePublicClient, signAndStore, type SignDeployment, type SignTarget } from '../../src/index';

interface ChildParams {
  readonly dbUrl: string;
  readonly rpcUrl: string;
  readonly key: Hex;
  readonly target: SignTarget;
  readonly to: Address;
  readonly data: Hex;
  readonly chainId: number;
  readonly capWei: string;
  readonly deployment: SignDeployment;
  readonly planId: Hex;
}

async function main(): Promise<void> {
  const raw = process.env.T19_CHILD;
  if (!raw) throw new Error('T19_CHILD is not set');
  const p = JSON.parse(raw) as ChildParams;
  const db = createDb(p.dbUrl, { maxConnections: 2 });
  const client = createHogeePublicClient({ chain: 'local', rpcUrls: [p.rpcUrl], pollingIntervalMs: 50 });
  const stored = await signAndStore(db, {
    target: p.target,
    request: { to: p.to, data: p.data },
    account: privateKeyToAccount(p.key),
    client,
    chainId: p.chainId,
    capWei: BigInt(p.capWei),
    deployment: p.deployment,
    planId: p.planId,
  });
  const sent = await broadcast(client, stored.rawTx);
  // Synchronous write: async pipe writes can be lost on SIGKILL (macOS).
  writeSync(1, `${JSON.stringify({ status: sent.status, txHash: sent.txHash, nonce: stored.nonce.toString() })}\n`);
  process.kill(process.pid, 'SIGKILL'); // dies here: markBroadcast never runs
}

main().catch((error: unknown) => {
  writeSync(2, `t19-child failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
