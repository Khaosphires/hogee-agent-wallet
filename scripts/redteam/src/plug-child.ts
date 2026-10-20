/**
 * "Pull the plug" child (project.md §13.3 #2, T19): one worker agent-actions pass that SIGKILLs itself the moment the
 * payment's raw tx has been broadcast, before the worker records anything after it (the same `onStep` checkpoint the
 * worker's own crash tests use). Params arrive as JSON in PLUG_CHILD; the role keys arrive as *_PRIVATE_KEY_FINAL in
 * this process's env only and are read (and scrubbed) by the worker's own loader.
 */
import { writeSync } from "node:fs";
import { createHogeePublicClient, parseDeployment } from "@hogee/chain";
import { createDb } from "@hogee/db";
import { loadSigners, runAgentActions, silentLogger } from "@hogee/worker";
import { parseEther } from "viem";
import { errorReason } from "./redact";

interface ChildParams {
  readonly dbUrl: string;
  readonly chain: "local" | "sepolia";
  readonly rpcUrls: readonly string[];
  readonly deployment: unknown;
  readonly facilityId: string;
  readonly paymentId: string;
  readonly maxFeeWei: string;
}

async function main(): Promise<void> {
  const raw = process.env.PLUG_CHILD;
  if (!raw) throw new Error("PLUG_CHILD is not set");
  const p = JSON.parse(raw) as ChildParams;
  const signers = loadSigners(process.env, "FINAL", { scrub: true });
  const db = createDb(p.dbUrl, { maxConnections: 2 });
  const client = createHogeePublicClient({ chain: p.chain, rpcUrls: [...p.rpcUrls], pollingIntervalMs: p.chain === "local" ? 50 : 12_000 });
  await runAgentActions(
    {
      db,
      client,
      signers,
      deployment: parseDeployment(p.deployment),
      config: { maxFeeWei: BigInt(p.maxFeeWei), lowBalanceWei: parseEther("0.01"), stuckPendingPasses: 3, payoutMaxAttempts: 3 },
      log: silentLogger,
      onStep: (step, paymentId) => {
        if (step !== "broadcast" || paymentId !== p.paymentId) return;
        writeSync(1, `${JSON.stringify({ step, paymentId, pid: process.pid })}\n`);
        process.kill(process.pid, "SIGKILL");
      },
    },
    [p.facilityId],
  );
  writeSync(1, `${JSON.stringify({ step: "completed" })}\n`);
  process.exit(3);
}

main().catch((error: unknown) => {
  // Redacted like the runner's own error text (an RPC error carries the provider URL); the parent stores it in a bundle.
  writeSync(2, `plug-child failed: ${errorReason(error, 500)}\n`);
  process.exit(2);
});
