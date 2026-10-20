/**
 * `make evidence` (pnpm --filter @hogee/api evidence): exports the server facility's evidence bundle into evidence/
 * with the live API's environment (DATABASE_URL, CHAIN + RPC, DEPLOYMENT_ID, HOGEE_FACILITY_ID, optional
 * HOGEE_EVIDENCE_DIR / HOGEE_GIT_COMMIT), waits for it, and prints the run. Read-only: it signs and sends nothing.
 * Exit 0: written (or already there with the same evidence); 1: the export failed or another one is running.
 */
import { ConfigError } from "../http/problem";
import { createLiveDeps } from "../runtime/deps";
import { jsonLogger } from "../runtime/ports";
import { EvidenceBusyError, exportEvidence } from "./export";

async function main(): Promise<number> {
  const log = jsonLogger();
  let deps: Awaited<ReturnType<typeof createLiveDeps>>;
  try {
    deps = await createLiveDeps(process.env, log);
  } catch (error: unknown) {
    // ConfigError names the variable, never its value.
    process.stderr.write(`evidence: ${error instanceof ConfigError ? error.message : "cannot reach the database or the chain"}\n`);
    return 1;
  }
  try {
    const root = deps.config.evidenceDir;
    if (!root) {
      process.stderr.write("evidence: no evidence directory (set HOGEE_EVIDENCE_DIR or run inside the repo)\n");
      return 1;
    }
    const scope = { facilityId: deps.config.facilityId, founderId: deps.config.founderId };
    const result = await exportEvidence(deps, scope, { root, wait: true });
    const { verified } = await result.done;
    process.stdout.write(`evidence: ${result.created ? "wrote" : "unchanged, kept"} ${root}/${result.runId}${result.created ? ` (self-check: ${verified ? "verifies" : "does NOT verify; run make verify"})` : ""}\n`);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`evidence: ${error instanceof EvidenceBusyError ? error.message : "the export failed (see the log above)"}\n`);
    if (!(error instanceof EvidenceBusyError)) log.error("evidence_cli_failed", { error });
    return 1;
  } finally {
    await deps.db.$client.end().catch(() => undefined);
  }
}

process.exitCode = await main();
