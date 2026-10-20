#!/usr/bin/env node
// Starts the web app on http://localhost:$PORT (default 3000) in mock mode (MOCK_API=1) with the demo routes on
// (DEMO_MODE=1). MOCK_SCENARIO picks the demo data: unset, it is the "Sample business" (lived: Mei about three weeks
// in, UX round 2), so a fresh start is demo-ready; fresh is a founder at the start of the chat journey; default is the
// status gallery the smoke e2e pins. REPLAY=<runId> (the offline demo) or HOGEE_COUNTRY=MY keep their own data: no
// sample business is chosen for them. The Sample business switch in the quick settings changes it at runtime.
// PERSONA_COOKIE_SECRET and OFFICER_TOKEN default to fresh random values for this run only (never written to disk);
// export your own to keep a stable officer access code.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The scenario a dev:mock run serves: MOCK_SCENARIO when set, else the sample business unless REPLAY or MY says otherwise. */
export function defaultScenario(env) {
  const set = env.MOCK_SCENARIO?.trim();
  if (set) return set;
  const country = env.HOGEE_COUNTRY?.trim() || "SG";
  return env.REPLAY?.trim() || country !== "SG" ? undefined : "lived";
}

/** The child's environment (pure, so scripts/dev-mock.test.mjs can check it). */
export function devMockEnv(env, fresh = () => randomBytes(32).toString("hex")) {
  const out = { ...env, MOCK_API: env.MOCK_API ?? "1", DEMO_MODE: "1", NEXT_TELEMETRY_DISABLED: "1" };
  const scenario = defaultScenario(env);
  if (scenario) out.MOCK_SCENARIO = scenario;
  out.PERSONA_COOKIE_SECRET ||= fresh();
  const printToken = !out.OFFICER_TOKEN;
  if (printToken) out.OFFICER_TOKEN = fresh();
  return { env: out, printToken };
}

function main() {
  // VISION-DECISIONS §1: each agent previews on its own port (3000 is the integrated demo's).
  const port = process.env.PORT?.trim() || "3000";
  if (!/^[0-9]{2,5}$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    console.error(`PORT must be a number from 1024 to 65535, got "${port}"`);
    process.exit(1);
  }
  // Telemetry off: `next dev` would otherwise call out of localhost.
  const { env, printToken } = devMockEnv(process.env);
  if (printToken) {
    console.log(`\n  Mock mode. Officer access code for this run (Persona switch → Officer):\n  ${env.OFFICER_TOKEN}\n`);
  }
  console.log(`  Demo data: ${env.MOCK_SCENARIO === "lived" ? "Sample business (lived)" : (env.MOCK_SCENARIO ?? "default")}\n`);
  const child = spawn("next", ["dev", "--hostname", "localhost", "--port", port], {
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) main();
