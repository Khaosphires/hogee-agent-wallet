/**
 * Each world's task 1.16 bundle, written after the cases into <run>/export/<world>/<ev-…>/ (`make verify BUNDLE=…`).
 *   1. Every block mined so far becomes final (the clock), then one finality pass per facility settles what the run left
 *      INCLUDED (FINALIZED or REVERTED from the receipt at `finalized`), as a running worker would. Nothing is signed.
 *      Without it the exporter refuses: a reverted forced send is still INCLUDED until a finality pass.
 *   2. The API's own exporter runs on the world's deps. Their catalog is the one the world's plans committed to (the
 *      API test fixtures), so the bundle holds that country pack; `make evidence` with the data/ catalog cannot.
 * The run's secret scan covers these folders. An export that fails or does not verify fails the run (cli.ts).
 */
import { join } from "node:path";
import { advanceFinality } from "@hogee/chain";
import { exportEvidence } from "./api-internals";
import type { Infra, Stack } from "./stack";
import { errorReason } from "./redact";

export interface WorldExport {
  readonly world: string;
  readonly facilityId: string;
  /** verified: the exporter's own verifier passed on the files it wrote. */
  readonly status: "verified" | "not_verified" | "failed";
  readonly runId?: string;
  /** The bundle folder, relative to the red-team run folder. */
  readonly path?: string;
  readonly reason?: string;
}

const GIT_COMMIT = /^[0-9a-f]{7,40}$/;

async function exportWorld(s: Stack, dir: string, gitCommit: string): Promise<WorldExport> {
  const base = { world: s.label, facilityId: s.facilityId };
  try {
    const { deployment } = s.workerDeps();
    await advanceFinality(s.db, s.client, { chainId: deployment.chainId, deployment, facilityId: s.facilityId, nonceSearchFromBlock: BigInt(deployment.blockNumber) });
    const rel = join("export", s.label);
    const r = await exportEvidence(s.deps, { facilityId: s.facilityId, founderId: s.founderId }, { root: join(dir, rel), wait: true, ...(GIT_COMMIT.test(gitCommit) ? { gitCommit } : {}) });
    const { verified } = await r.done;
    const out = { ...base, runId: r.runId, path: join(rel, r.runId) };
    if (verified === null) return { ...out, status: "not_verified", reason: "the bundle already existed; nothing was written or checked" };
    return { ...out, status: verified ? "verified" : "not_verified", ...(verified ? {} : { reason: `make verify BUNDLE=${join(rel, r.runId)} lists the failing checks` }) };
  } catch (error: unknown) {
    return { ...base, status: "failed", reason: errorReason(error, 300) };
  }
}

/** One finality horizon for every world (they share the chain), then each world's export, in order. */
export async function exportWorlds(infra: Infra, worlds: readonly Stack[], dir: string, gitCommit: string): Promise<WorldExport[]> {
  if (worlds.length === 0) return [];
  try {
    await infra.clock.finalize();
  } catch (error: unknown) {
    const reason = `the chain did not finalize: ${errorReason(error, 300)}`;
    return worlds.map((s) => ({ world: s.label, facilityId: s.facilityId, status: "failed", reason }));
  }
  const out: WorldExport[] = [];
  for (const s of worlds) out.push(await exportWorld(s, dir, gitCommit));
  return out;
}
