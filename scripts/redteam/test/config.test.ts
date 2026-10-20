/** The one target switch: anvil by default, sepolia with the deployed manifest; errors name flags, never values. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRunConfig, RunConfigError } from "../src/config";

const NOW = new Date("2026-10-18T09:00:00.000Z");
const local = { rpc: "http://127.0.0.1:8591", db: "postgres://hogee@127.0.0.1:55511/hogee" };

describe("loadRunConfig", () => {
  it("defaults to anvil and reads the live-test env names", () => {
    const c = loadRunConfig([], { TEST_RPC_URL: local.rpc, TEST_DATABASE_URL: local.db }, NOW);
    expect(c).toMatchObject({ target: "anvil", rpcUrls: [local.rpc], databaseUrl: local.db, anvilExtras: true, anvilSg: true, runId: "rt-20261018t090000z-anvil", coolingSeconds: 120 });
  });

  it("takes flags over env, and --no-extras (pnpm's -- separator is skipped)", () => {
    const c = loadRunConfig(["--", "--rpc-url", local.rpc, "--database-url=" + local.db, "--no-extras", "--run-id", "rt-1"], {}, NOW);
    expect(c).toMatchObject({ rpcUrls: [local.rpc], anvilExtras: false, anvilSg: true, runId: "rt-1" });
  });

  it("--no-sg skips the Singapore world only", () => {
    const c = loadRunConfig(["--rpc-url", local.rpc, "--database-url", local.db, "--no-sg"], {}, NOW);
    expect(c).toMatchObject({ anvilExtras: true, anvilSg: false });
  });

  it("the WEB world runs by default on Anvil; --no-web skips it only; Sepolia never runs it", () => {
    expect(loadRunConfig(["--rpc-url", local.rpc, "--database-url", local.db], {}, NOW)).toMatchObject({ anvilWeb: true, anvilSg: true });
    expect(loadRunConfig(["--rpc-url", local.rpc, "--database-url", local.db, "--no-web"], {}, NOW)).toMatchObject({ anvilWeb: false, anvilSg: true, anvilExtras: true });
  });

  it("anvil needs an RPC and a database; unknown flags and stray arguments are refused", () => {
    expect(() => loadRunConfig([], {}, NOW)).toThrow(/--rpc-url/);
    expect(() => loadRunConfig(["--rpc-url", local.rpc], {}, NOW)).toThrow(/--database-url/);
    expect(() => loadRunConfig(["--frobnicate"], {}, NOW)).toThrow(/unknown flag/);
    expect(() => loadRunConfig(["sepolia"], {}, NOW)).toThrow(RunConfigError);
    expect(() => loadRunConfig(["--rpc-url", local.rpc, "--database-url", local.db, "--manifest", "x.json"], {}, NOW)).toThrow(/--target sepolia/);
  });

  it("sepolia needs two https providers, a database and the manifest file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rt-cfg-"));
    try {
      const manifest = join(dir, "sepolia-final-1.json");
      const env = { SEPOLIA_RPC_URL: "https://a.example.invalid/v1/x", SEPOLIA_RPC_URL_FALLBACK: "https://b.example.invalid", DATABASE_URL: local.db };
      expect(() => loadRunConfig(["--target", "sepolia", "--manifest", manifest], env, NOW)).toThrow(/manifest file does not exist/);
      writeFileSync(manifest, "{}");
      const c = loadRunConfig(["--target", "sepolia", "--manifest", manifest], env, NOW);
      expect(c).toMatchObject({ target: "sepolia", rpcUrls: [env.SEPOLIA_RPC_URL, env.SEPOLIA_RPC_URL_FALLBACK], manifestFile: manifest, anvilExtras: false, anvilSg: false, anvilWeb: false });
      expect(loadRunConfig(["--manifest", manifest], { ...env, REDTEAM_TARGET: "sepolia" }, NOW).target).toBe("sepolia");
      expect(() => loadRunConfig(["--target", "sepolia", "--manifest", manifest], { ...env, SEPOLIA_RPC_URL_FALLBACK: "" }, NOW)).toThrow(/two providers/);
      expect(() => loadRunConfig(["--target", "sepolia", "--manifest", manifest], { ...env, SEPOLIA_RPC_URL: "http://rpc.example.invalid" }, NOW)).toThrow(/must be an https URL/);
      expect(() => loadRunConfig(["--target", "sepolia", "--manifest", manifest, "--rpc-url", local.rpc], env, NOW)).toThrow(/is for anvil/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never echoes a value in an error", () => {
    const secretish = "https://rpc.example.invalid/v3/DO-NOT-PRINT-THIS-KEY";
    try {
      loadRunConfig(["--target", "sepolia"], { SEPOLIA_RPC_URL: secretish }, NOW);
    } catch (e) {
      expect(String(e)).not.toContain("DO-NOT-PRINT");
    }
  });
});
