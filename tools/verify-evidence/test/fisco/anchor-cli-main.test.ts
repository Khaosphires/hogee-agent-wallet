/**
 * The verify-fisco hook (cli.ts main): the "Sepolia timestamp" line is always reported, "not anchored" passes it,
 * --require-anchor fails it, a sidecar by anyone but the hogee-deployer fails it, the online lines the entry passes
 * in are reported and counted, the offline line checks the very bytes the online line read (the entry passes the
 * same argv to both), and the new flags parse (a missing URL is exit 2, never echoed). Only the anchor lines
 * are asserted here: the rest of the verdict belongs to the other checks.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onlineAnchorLines } from "../../src/fisco/anchor-cli";
import { main } from "../../src/fisco/cli";
import { anchorPack, sidecarOf, type AnchorPack } from "./anchor-fixture";
import type { Files } from "./tamper";

let a: AnchorPack;
let good: string;
const roots: string[] = [];

beforeAll(async () => {
  a = await anchorPack();
  good = await sidecarOf(a);
}, 60_000);
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function write(dir: string, files: Files): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

/** evidence/fisco/<packId>/ (+ anchors/<packId>.sepolia.json) and an (empty) source bundle folder. */
function layout(sidecar?: string): { dir: string; bundle: string } {
  const root = mkdtempSync(join(tmpdir(), "hogee-anchor-cli-"));
  roots.push(root);
  const dir = join(root, "fisco", a.packId);
  write(dir, a.files);
  if (sidecar !== undefined) write(join(root, "fisco", "anchors"), { [`${a.packId}.sepolia.json`]: sidecar });
  const bundle = join(root, "bundle");
  mkdirSync(bundle);
  return { dir, bundle };
}

function run(argv: readonly string[], online: Parameters<typeof main>[4] = []): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = main(argv, (l) => lines.push(l), undefined, undefined, online);
  return { code, lines };
}
const anchorOf = (lines: readonly string[]): string[] => lines.filter((l) => l.includes(" Sepolia timestamp"));

describe("verify-fisco: the Sepolia timestamp line", () => {
  it("reports 'not anchored' as a passing line", () => {
    const l = layout();
    expect(anchorOf(run([l.dir, "--sepolia-bundle", l.bundle]).lines)).toEqual([expect.stringMatching(/^ {2}ok {3}Sepolia timestamp — not anchored/)]);
  });

  it("--require-anchor turns 'not anchored' into a FAIL", () => {
    const l = layout();
    const { code, lines } = run([l.dir, "--sepolia-bundle", l.bundle, "--require-anchor"]);
    expect(code).toBe(1);
    expect(anchorOf(lines)).toEqual([expect.stringMatching(/^ {2}FAIL Sepolia timestamp — not anchored .*required/)]);
  });

  it("fails a sidecar not signed by the hogee-deployer (the CLI pins it)", () => {
    const l = layout(good);
    const { code, lines } = run([l.dir, "--sepolia-bundle", l.bundle]);
    expect(code).toBe(1);
    expect(anchorOf(lines)).toEqual([expect.stringMatching(/FAIL Sepolia timestamp — .*not the hogee-deployer/)]);
  });

  it("reports the online lines it is given, and a failing one fails the run", () => {
    const l = layout();
    const { code, lines } = run([l.dir, "--sepolia-bundle", l.bundle, "--anchor-rpc", "https://sepolia.example.test/"], [{ name: "Sepolia timestamp (online)", ok: false, detail: "nothing to confirm" }]);
    expect(code).toBe(1);
    expect(anchorOf(lines)).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("sepolia.example.test");
  });

  it("checks offline the sidecar bytes the online line read, as the entry runs them (same argv), though the file changes", async () => {
    const l = layout(good);
    const argv = [l.dir, "--sepolia-bundle", l.bundle, "--anchor-rpc", "https://sepolia.example.test/"];
    const block = { number: "0x8a1b2c", hash: JSON.parse(good).receipt.blockHash as string, parentHash: `0x${"0".repeat(64)}`, timestamp: "0x0" };
    const online = await onlineAnchorLines(argv, new Set(["--sepolia-bundle", "--artifacts", "--anchor-rpc"]), {
      env: {},
      fetch: async (_u, init) => {
        const { method } = JSON.parse(init.body) as { method: string };
        const result = method === "eth_chainId" ? "0xaa36a7" : method === "eth_getTransactionReceipt" ? JSON.parse(good).receipt : block;
        return { ok: true, status: 200, json: async () => ({ result }) };
      },
    });
    expect(online).toHaveLength(1);
    writeFileSync(join(dirname(l.dir), "anchors", `${a.packId}.sepolia.json`), "{}");
    const { lines } = run(argv, online);
    // The bytes read first (signed by the test key, so the pinned CLI refuses the signer), not the "{}" now on disk.
    expect(anchorOf(lines)[0]).toMatch(/FAIL Sepolia timestamp — .*not the hogee-deployer/);
    expect(anchorOf(run([...argv], online).lines)[0]).toMatch(/FAIL Sepolia timestamp — .*schema/);
  });

  it("parses the new flags: a missing URL is exit 2; the usage line names them", () => {
    const l = layout();
    const missing = run([l.dir, "--sepolia-bundle", l.bundle, "--anchor-rpc"]);
    expect(missing).toEqual({ code: 2, lines: ["verify-fisco: --anchor-rpc needs a URL"] });
    const usage = run(["--require-anchor"]);
    expect(usage.code).toBe(2);
    expect(usage.lines[0]).toContain("[--require-anchor] [--anchor-rpc <url>]");
    expect(run([l.dir, "--sepolia-bundle", l.bundle, "--anchor", "x"]).code).toBe(2);
  });

  it("puts the line in --json output too", () => {
    const l = layout();
    const out = JSON.parse(run([l.dir, "--sepolia-bundle", l.bundle, "--json"]).lines.join("\n")) as { checks: { name: string; ok: boolean }[] };
    expect(out.checks.filter((c) => c.name === "Sepolia timestamp")).toEqual([expect.objectContaining({ ok: true })]);
  });
});
