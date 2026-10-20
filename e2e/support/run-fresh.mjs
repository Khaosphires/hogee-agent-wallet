#!/usr/bin/env node
// Runs Playwright against a mock server in the fresh scenario (VISION-DECISIONS §7: MOCK_SCENARIO=fresh, a founder at
// the start of the chat journey), cross-platform (an env prefix in a package script would not work on Windows).
//   node support/run-fresh.mjs --cooling=<seconds> <playwright test args…>    (from e2e/)
// --cooling sets DEMO_TIMELOCK_SECONDS, the mock's payee cooling and officer timelock (default 120 s, as on Sepolia):
// the journey uses 5 s, the demo video a value its captions state. The web server inherits this environment
// (Playwright merges process.env), so stop any server already on the port first: a reused one keeps its own scenario.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2e = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const coolingArg = args.find((a) => a.startsWith("--cooling="));
const cooling = coolingArg?.slice("--cooling=".length) ?? "120";
if (!/^[1-9][0-9]{0,3}$/.test(cooling)) {
  console.error(`--cooling must be a whole number of seconds (1-9999), got "${cooling}"`);
  process.exit(1);
}
const playwright = args.filter((a) => a !== coolingArg);
const env = { ...process.env, MOCK_SCENARIO: "fresh", DEMO_TIMELOCK_SECONDS: cooling };
const run = spawnSync("pnpm", ["exec", "playwright", "test", ...playwright], { cwd: e2e, stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(run.status ?? 1);
