import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// localhost, not 127.0.0.1: passkeys need the "localhost" RP ID (ROLE-P2 A.3 rule 6).
const BASE_URL = "http://localhost:3000";

// Per-run operator secrets for the mock server (never committed). `??=` keeps the runner's values in the workers,
// which re-evaluate this file. Reusing a server you started yourself? Export E2E_OFFICER_TOKEN with its token.
const officerToken = (process.env.E2E_OFFICER_TOKEN ??= randomBytes(32).toString("hex"));
const cookieSecret = (process.env.E2E_COOKIE_SECRET ??= randomBytes(32).toString("hex"));

// Names a dependent project ("after-reset") that did not run because a project it depends on failed. An absolute
// path, so a scratch config elsewhere that imports this one still finds it.
const DEPENDENTS_REPORTER = join(dirname(fileURLToPath(import.meta.url)), "support", "dependents-reporter.ts");

// The viewport projects run the smoke specs on the default scenario; the journey, the demo and the vectors have their
// own projects (the journey and the demo need a fresh-scenario server), and so do the two specs that reset the store.
const VIEWPORT_IGNORE = ["passkey/vectors.spec.ts", "demo/**", "journey/**", "smoke/after-reset.spec.ts", "smoke/sample-business.spec.ts"];

// dev:mock serves the "Sample business" (MOCK_SCENARIO=lived) when MOCK_SCENARIO is unset; the smoke specs expect the
// status gallery, so the server is pinned to `default` unless the runner chose one (support/run-fresh.mjs: fresh).
const SCENARIO = process.env.MOCK_SCENARIO?.trim() || "default";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // More than ~3 headless browsers at once stalled page loads on a 16-core Windows laptop
  // (dev and prod servers alike; not memory or tracing). Two workers keep the smoke run short.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [[process.env.CI ? "github" : "list"], [DEPENDENTS_REPORTER]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  // Definition of done: every page works at 1280×720 and 1920×1080 (ROLE-P2 A.5).
  projects: [
    { name: "1280x720", testIgnore: VIEWPORT_IGNORE, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } } },
    { name: "1920x1080", testIgnore: VIEWPORT_IGNORE, use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
    // Resets the shared mock store, so it waits for both viewport projects to finish.
    {
      name: "after-reset",
      testMatch: "smoke/after-reset.spec.ts",
      dependencies: ["1280x720", "1920x1080"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    // The Sample business switch (UX round 2): it rebuilds the shared store, so it runs last, after after-reset.
    {
      name: "sample-business",
      testMatch: "smoke/sample-business.spec.ts",
      dependencies: ["after-reset"],
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    // Mei's chat-first journey on the fresh scenario, one serial run that resets the store first
    // (pnpm --filter @hogee/e2e journey: support/run-fresh.mjs starts the server with MOCK_SCENARIO=fresh).
    {
      name: "journey",
      testMatch: "journey/**/*.spec.ts",
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 }, permissions: ["clipboard-read", "clipboard-write"] },
    },
    // Gate G3: writes e2e/vectors/passkey-N.json (pnpm --filter @hogee/e2e vectors).
    { name: "vectors", testMatch: "passkey/vectors.spec.ts", use: { ...devices["Desktop Chrome"] } },
    // The 5-minute demo video at 1080p, in two parts joined afterwards: Mei's chat journey on the fresh mock, then the
    // replay scenes on REPLAY=<runId> (REPLAY=<runId> pnpm --filter @hogee/e2e demo:record; demo/record-replay.mjs).
    {
      name: "demo",
      testMatch: "demo/demo.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        video: { mode: "on", size: { width: 1920, height: 1080 } },
        // The video's officer switch types the access code: the password field shows dots, a trace would record it.
        trace: "off",
      },
    },
  ],
  webServer: {
    // Mock mode with the demo routes on (apps/web/scripts/dev-mock.mjs).
    command: "pnpm --filter @hogee/web dev:mock",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { OFFICER_TOKEN: officerToken, PERSONA_COOKIE_SECRET: cookieSecret, MOCK_SCENARIO: SCENARIO },
  },
});
