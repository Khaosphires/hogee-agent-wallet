#!/usr/bin/env node
// The final cut (VIDEO-SCRIPT production step 1): REPLAY=<runId> node demo/record-replay.mjs (from e2e/), also
// `pnpm --filter @hogee/e2e demo:record` with REPLAY set.
//   1. DEMO_PART=main on the mock's fresh scenario (REPLAY unset; MOCK_SCENARIO=fresh and a short cooling, which the
//      pay scene's caption states: scenes.ts DEMO_COOLING_SECONDS): Mei's chat journey, then the CFO;
//   2. DEMO_PART=evidence with REPLAY=<runId>: the attacks and the evidence check on the recorded bundle
//      evidence/<runId>/ (Sepolia once the red team has run there; the captions name the bundle's chain);
//   3. join-parts.mjs: the scenes in VIDEO-SCRIPT.md's order (the attacks between the payment and the CFO), one 1080p
//      MP4 with the subtitles burned in.
// Each Playwright run starts its own web server on the config's port (e2e/playwright.config.ts: 3000; stop any server
// already on it, Playwright would reuse it). Extra arguments go to both Playwright runs: to record on another port,
// pass a scratch config that overrides baseURL and the web server's PORT, e.g.
//   REPLAY=<runId> node demo/record-replay.mjs -c /path/to/scratch.config.ts
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const e2e = join(dirname(fileURLToPath(import.meta.url)), "..");
const replay = process.env.REPLAY?.trim();
if (!replay) {
  console.error("Set REPLAY=<runId>: the evidence/<runId>/ bundle the replay scenes show (it must verify)");
  process.exit(1);
}

function step(label, command, args, env) {
  console.log(`\n== ${label}`);
  const run = spawnSync(command, args, { cwd: e2e, stdio: "inherit", env });
  if (run.status !== 0) {
    console.error(`${label} failed (exit ${run.status ?? run.signal})`);
    process.exit(run.status ?? 1);
  }
}

const extra = process.argv.slice(2);
const playwright = ["exec", "playwright", "test", "--project=demo", ...extra];
// Must equal scenes.ts DEMO_COOLING_SECONDS (the demo refuses to record otherwise).
const DEMO_COOLING_SECONDS = "20";
const { REPLAY: _replay, ...mockEnv } = process.env;
step("part 1 of 2: the mock scenes", "pnpm", playwright, { ...mockEnv, DEMO_PART: "main", MOCK_SCENARIO: "fresh", DEMO_TIMELOCK_SECONDS: DEMO_COOLING_SECONDS });
step(`part 2 of 2: the replay scenes on REPLAY=${replay}`, "pnpm", playwright, { ...process.env, DEMO_PART: "evidence", REPLAY: replay });
step("join and burn the subtitles", process.execPath, [join(e2e, "demo", "join-parts.mjs")], process.env);
