/**
 * `pnpm --filter @hogee/redteam start [--target anvil|sepolia] …` (see README.md). Prints one line per case and a
 * summary; exits 0 when no case failed (not-run cases are listed, never counted as passes) and every world's evidence
 * bundle verifies, 1 when a case failed or a bundle did not export or verify, 2 on a configuration error.
 */
import { loadRunConfig, RunConfigError, USAGE, wantsHelp } from "./config";
import { errorReason } from "./redact";
import { runSuite } from "./run";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let cfg;
  try {
    cfg = loadRunConfig(argv, process.env);
  } catch (error: unknown) {
    if (error instanceof RunConfigError) {
      process.stderr.write(`${error.message}\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }
  const result = await runSuite(cfg);
  const by = (st: string) => result.reports.filter((r) => r.status === st);
  process.stdout.write(`\nbundle: ${result.dir}\nrows: ${result.rows}; pass ${by("pass").length}, fail ${by("fail").length}, not run ${by("not_run").length}\n`);
  for (const r of by("fail")) process.stdout.write(`  FAIL ${r.taskId}: ${r.reason ?? r.notes.join("; ")}\n`);
  for (const r of by("not_run")) process.stdout.write(`  NOT RUN ${r.taskId}: ${r.reason ?? ""}\n`);
  // Country variants (the SG world) also count in their task id above; listed on their own so a pending one shows.
  for (const v of result.variants) process.stdout.write(`  ${v.variant} variant ${v.taskId}: ${v.status}${v.reason ? ` (${v.reason})` : ""}\n`);
  // Each world's task 1.16 bundle; check one offline with `make verify BUNDLE=<bundle>/<path>`.
  for (const e of result.exports) process.stdout.write(`  evidence ${e.world}: ${e.status}${e.path ? ` ${e.path}` : ""}${e.reason ? ` (${e.reason})` : ""}\n`);
  const exported = result.exports.every((e) => e.status === "verified");
  return by("fail").length === 0 && exported ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`red-team run failed: ${errorReason(error, 2000)}\n`);
    process.exit(1);
  },
);
