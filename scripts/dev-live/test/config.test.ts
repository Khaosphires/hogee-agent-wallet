/** Launcher flags: ports and two switches only (everything else is generated or fixed); the children's fixed settings. */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { anvilArgs, countryEnv, loadLaunchConfig, pgpassLine, REPO_DATA_DIR, sharedEnv, WEB_ENV_BLANKS, webEnv, webSteps } from "../src/config";
import { baseEnv } from "../src/procs";

describe("loadLaunchConfig", () => {
  it("defaults to Anvil 8545, Postgres 55432, web 3000, seeding on", () => {
    expect(loadLaunchConfig([])).toEqual({ anvilPort: 8545, pgPort: 55432, webPort: 3000, keepData: false, seed: true });
  });

  it("takes ports (with or without =), --keep-data, --no-seed, and ignores pnpm's --", () => {
    expect(loadLaunchConfig(["--", "--anvil-port", "8546", "--pg-port=55433", "--web-port", "3001", "--keep-data", "--no-seed"])).toEqual({
      anvilPort: 8546,
      pgPort: 55433,
      webPort: 3001,
      keepData: true,
      seed: false,
    });
  });

  it("takes --country MY|SG (absent: the API's default country decides) and refuses any other", () => {
    expect(loadLaunchConfig([]).country).toBeUndefined();
    expect(loadLaunchConfig(["--country", "SG"]).country).toBe("SG");
    expect(loadLaunchConfig(["--country=MY"]).country).toBe("MY");
    for (const c of ["ID", "sg", "TH"]) expect(() => loadLaunchConfig(["--country", c]), c).toThrow(/--country must be MY or SG/);
  });

  it("--prod builds then starts next (the production CSP); the default stays next dev (re-check review LOW 3)", () => {
    expect(loadLaunchConfig([]).prod).toBeUndefined();
    expect(loadLaunchConfig(["--prod"]).prod).toBe(true);
    expect(webSteps({ webPort: 3401 })).toEqual({ serve: ["dev", "--hostname", "localhost", "--port", "3401"] });
    expect(webSteps({ webPort: 3401, prod: true })).toEqual({ build: ["build"], serve: ["start", "--hostname", "localhost", "--port", "3401"] });
  });

  it("refuses unknown flags, bad or clashing ports", () => {
    expect(() => loadLaunchConfig(["--mainnet"])).toThrow(/unknown flag/);
    expect(() => loadLaunchConfig(["--anvil-port", "99999"])).toThrow(/TCP port/);
    expect(() => loadLaunchConfig(["--anvil-port", "3000"])).toThrow(/must differ/);
    expect(() => loadLaunchConfig(["anvil"])).toThrow(/unexpected argument/);
  });
});

describe("child settings", () => {
  it("Anvil: loopback, no CORS, a block a second, finalized ~2 blocks behind latest", () => {
    const args = anvilArgs(8641);
    expect(args).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--port", "8641", "--no-cors", "--slots-in-an-epoch", "1"]));
    expect(args[args.indexOf("--block-time") + 1]).toBe("1");
  });

  it("the web child blanks every switch an apps/web/.env* file could set, and the launcher's values win", () => {
    const env = webEnv({ MOCK_API: "0", DEMO_MODE: "1", PAYOUT_RAIL: "mock" });
    for (const name of ["REPLAY", "MODEL_PROVIDER", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "PRESIDIO_ANALYZER_URL", "XENDIT_SECRET_KEY", "SEPOLIA_RPC_URL"]) {
      expect(env[name]).toBe("");
    }
    expect(env).toMatchObject({ MOCK_API: "0", DEMO_MODE: "1", PAYOUT_RAIL: "mock" });
    expect(Object.keys(env)).toHaveLength(WEB_ENV_BLANKS.length + 3);
    expect(webEnv({ REPLAY: "rt-1" }).REPLAY).toBe("rt-1");
  });

  it("the worker and the API get HOGEE_DATA_DIR (the repo's data/, holding the sanctions list) and the mock payout rail", () => {
    const env = sharedEnv({ databaseUrl: "postgres://hogee@127.0.0.1:55432/hogee", pgpassFile: "/x/pgpass", rpcUrl: "http://127.0.0.1:8545", deploymentId: "final-1", deploymentFile: "/x/anvil-final-1.json" });
    expect(env).toEqual({
      DATABASE_URL: "postgres://hogee@127.0.0.1:55432/hogee",
      PGPASSFILE: "/x/pgpass",
      CHAIN: "local",
      LOCAL_RPC_URL: "http://127.0.0.1:8545",
      DEPLOYMENT_ID: "final-1",
      CHAIN_TAG: "anvil",
      DEPLOYMENT_FILE: "/x/anvil-final-1.json",
      PAYOUT_RAIL: "mock",
      HOGEE_DATA_DIR: REPO_DATA_DIR,
    });
    expect(isAbsolute(REPO_DATA_DIR)).toBe(true);
    expect(existsSync(join(REPO_DATA_DIR, "sanctions", "un_sc.csv"))).toBe(true);
    expect(existsSync(join(REPO_DATA_DIR, "country-packs"))).toBe(true);
  });

  it("states the API's country and tenant explicitly", () => {
    expect(countryEnv({ countryCode: "SG", facilityId: "fac-mei", founderId: "founder-mei" })).toEqual({ HOGEE_COUNTRY: "SG", HOGEE_FACILITY_ID: "fac-mei", HOGEE_FOUNDER_ID: "founder-mei" });
    expect(countryEnv({ countryCode: "MY", facilityId: "fac-rina", founderId: "founder-rina" })).toEqual({ HOGEE_COUNTRY: "MY", HOGEE_FACILITY_ID: "fac-rina", HOGEE_FOUNDER_ID: "founder-rina" });
  });

  it("writes a pgpass line for the throwaway cluster, escaping : and \\", () => {
    expect(pgpassLine(55561, "hogee", "abc")).toBe("127.0.0.1:55561:*:hogee:abc\n");
    expect(pgpassLine(55561, "hogee", "a:b\\c")).toBe("127.0.0.1:55561:*:hogee:a\\:b\\\\c\n");
  });

  it("puts the launcher's own node first on the children's PATH (Turbopack spawns `node` for CSS; nvm installs are not on the fixed list)", () => {
    const path = baseEnv().PATH?.split(":") ?? [];
    expect(path[0]).toBe(dirname(process.execPath));
    expect(path).toContain("/usr/bin");
    expect(baseEnv({ PATH: "/x" }).PATH).toBe("/x");
  });
});
