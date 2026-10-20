/**
 * The mode is picked once, at module load, and anything ambiguous throws there: REPLAY=<runId> serves replay (through
 * the mock app), MOCK_API=1 mock, MOCK_API=0 or unset live; REPLAY together with an explicit MOCK_API=0 is refused.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

async function load(env: Readonly<Record<string, string | undefined>>): Promise<unknown> {
  vi.resetModules();
  for (const name of ["REPLAY", "MOCK_API", "HOGEE_ALLOWED_HOSTS"]) vi.stubEnv(name, env[name]);
  return import("./route");
}

/**
 * The first import of ./route transforms and evaluates the whole @hogee/api and @hogee/api-mock graph (about 1.7 s
 * alone, past vitest's 5 s test timeout when the web suite runs in parallel on a loaded machine). It is done once here,
 * in plain live mode, under its own explicit timeout; every test then re-imports the module (vi.resetModules) from the
 * warm transform cache, so each test's time is its own assertions.
 */
const COLD_IMPORT_TIMEOUT_MS = 60_000;
beforeAll(async () => {
  await expect(load({})).resolves.toHaveProperty("GET");
  vi.unstubAllEnvs();
}, COLD_IMPORT_TIMEOUT_MS);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("route mode", () => {
  it("refuses REPLAY together with an explicit MOCK_API=0", async () => {
    await expect(load({ REPLAY: "rt-20261018t090000z-anvil", MOCK_API: "0" })).rejects.toThrow(/REPLAY is set together with MOCK_API=0/);
    await expect(load({ REPLAY: "rt-1", MOCK_API: " 0 " })).rejects.toThrow(/MOCK_API=0/);
  });

  it("serves replay when MOCK_API is unset or 1, and treats a blank REPLAY as unset", async () => {
    await expect(load({ REPLAY: "rt-1" })).resolves.toHaveProperty("GET");
    await expect(load({ REPLAY: "rt-1", MOCK_API: "1" })).resolves.toHaveProperty("POST");
    await expect(load({ REPLAY: "", MOCK_API: "0" })).resolves.toHaveProperty("GET");
  });

  it("still refuses a malformed REPLAY or MOCK_API", async () => {
    await expect(load({ REPLAY: "../etc" })).rejects.toThrow(/REPLAY must be an evidence run id/);
    await expect(load({ MOCK_API: "yes" })).rejects.toThrow(/MOCK_API must be "0" or "1"/);
  });
});
