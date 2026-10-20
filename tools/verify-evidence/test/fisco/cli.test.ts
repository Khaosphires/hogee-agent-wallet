/**
 * The `make verify-fisco` CLI (exit codes 0 / 1 / 2, final-2 pinned on the command line, the tracked source broadcast
 * compared at the pinned path, the folder named after the packId, the pack read under its own caps), and the
 * regression that a pack under evidence/fisco/ is never taken for an evidence bundle: neither `latestBundle`
 * (`make verify`) nor the API's evidence store lists it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestBundle, main as verifyMain } from "../../src/cli";
import { main, printable, readForgeArtifacts } from "../../src/fisco/cli";
import { FINAL_2, type SourceIdentity } from "../../src/fisco/pack";
import { listRuns, ownsRun } from "../../../../packages/api/src/evidence/store";
import { artifactOf, CODE_NAMES } from "./fixture";
import { buildPack } from "./fixture-steps";
import { SOURCE } from "./source";
import { edit, type Files } from "./tamper";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

let pack: Files;
let packId: string;
let source: Files;
let identity: SourceIdentity;
const roots: string[] = [];
const newRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hogee-fisco-"));
  roots.push(d);
  return d;
};
function write(dir: string, files: Files): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}
const quiet = () => undefined;

beforeAll(async () => {
  const fx = await buildPack();
  pack = fx.files;
  packId = fx.dir;
  source = fx.source.files;
  identity = fx.identity;
}, 60_000);
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/**
 * evidence/<run>/ + evidence/fisco/<folder>/ under a fresh root, and a scratch repo root holding the tracked source
 * broadcast at the identity's path (`broadcast: null` leaves it out).
 */
function layout(o: { folder?: string; files?: Files; broadcast?: string | null } = {}): { root: string; bundle: string; dir: string; repo: string } {
  const root = newRoot();
  const bundle = write(join(root, SOURCE.runId), source);
  const dir = write(join(root, "fisco", o.folder ?? packId), o.files ?? pack);
  const repo = newRoot();
  const broadcast = o.broadcast === undefined ? (pack["sepolia-broadcast.json"] as string) : o.broadcast;
  if (broadcast !== null) write(repo, { [identity.broadcastFile]: broadcast });
  return { root, bundle, dir, repo };
}

/** Runs the CLI against the fixture's identity and a layout's repo root; returns the exit code and the lines. */
function cli(l: { bundle: string; dir: string; repo: string }, extra: readonly string[] = []): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = main([l.dir, "--sepolia-bundle", l.bundle, ...extra], (x) => lines.push(x), identity, l.repo);
  return { code, lines };
}
const lineOf = (lines: readonly string[], name: string): string => lines.find((l) => l.includes(` ${name}`)) ?? "";

describe("verify-fisco CLI", () => {
  it("exits 0 on a valid pack and 1 on a tampered one", () => {
    const l = layout();
    const { code, lines } = cli(l);
    expect(code).toBe(0);
    expect(lines.at(-1)).toMatch(/^VERIFIED: .*not recomputed/);
    expect(lineOf(lines, "source broadcast (repo copy)")).toMatch(/^ {2}ok /);
    expect(lineOf(lines, "pack folder")).toMatch(/^ {2}ok /);
    const bad = write(join(l.root, "fisco", "fm-bad"), edit(pack, "steps.json", (v) => void (v.final.reads[0].value = "1")));
    expect(cli({ ...l, dir: bad }).code).toBe(1);
  });

  it("FINAL_2 pins the tracked final-2 broadcast by path and keccak256", () => {
    expect(FINAL_2.broadcastFile).toBe("contracts/broadcast/DeployFinal.s.sol/11155111/run-1792385076465.json");
    expect(FINAL_2.broadcastKeccak).toBe("0xd729b12a79cd978406e1fa52cc6e85a5b65a3b3b92104431c730efb1fef0f52a");
    expect(keccak256(new Uint8Array(readFileSync(join(REPO_ROOT, FINAL_2.broadcastFile))))).toBe(FINAL_2.broadcastKeccak);
  });

  it("fails, never skips, a missing or different tracked copy of the pinned source broadcast", () => {
    const missing = cli(layout({ broadcast: null }));
    expect(missing.code).toBe(1);
    expect(lineOf(missing.lines, "source broadcast (repo copy)")).toMatch(/^ {2}FAIL .*missing/);
    const other = cli(layout({ broadcast: `${pack["sepolia-broadcast.json"]} ` }));
    expect(other.code).toBe(1);
    expect(lineOf(other.lines, "source broadcast (repo copy)")).toMatch(/^ {2}FAIL /);
  });

  it("fails a pack whose broadcastFile names a missing run file, with the tracked copy in place (run-11 C4)", () => {
    const files = edit(pack, "deployment.json", (d) => void (d.sepolia.broadcastFile = String(d.sepolia.broadcastFile).replace(/run-[0-9]+\.json$/, "run-2.json")));
    const { code, lines } = cli(layout({ files }));
    expect(code).toBe(1);
    expect(lineOf(lines, "deploy inputs")).toMatch(/^ {2}FAIL /);
  });

  it("fails when the folder is not named after the packId", () => {
    const { code, lines } = cli(layout({ folder: "fm-0123456789abcdef" }));
    expect(code).toBe(1);
    expect(lineOf(lines, "pack folder")).toMatch(/^ {2}FAIL .*fm-0123456789abcdef/);
  });

  it("says the artifacts come from the pack when no forge build is given", () => {
    const { code, lines } = cli(layout());
    expect(code).toBe(0);
    expect(lineOf(lines, "code identity")).toMatch(/^ {2}ok .*artifacts from the pack, not rebuilt/);
  });

  it("escapes control characters a pack puts in its file names or folder, so it cannot hide or forge a line", () => {
    const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
    const evil = "evil\u001b[2K\r\n  ok   final state\u009b2K\u2028.json";
    const named = cli(layout({ files: { ...pack, [evil]: "{}\n" } }));
    expect(named.code).toBe(1);
    for (const line of named.lines) expect(line).not.toMatch(CONTROL);
    expect(lineOf(named.lines, "pack files")).toContain("unexpected file evil\\x1b[2K\\r\\n  ok   final state\\x9b2K\\u2028.json");
    expect(named.lines.filter((x) => x.startsWith("  ok   final state"))).toEqual([]);
    expect(named.lines.at(-1)).toMatch(/^NOT VERIFIED/);
    const folder = cli(layout({ folder: "fm-0123456789abcdef\u001b[1A\nVERIFIED" }));
    expect(folder.code).toBe(1);
    for (const line of folder.lines) expect(line).not.toMatch(CONTROL);
    expect(folder.lines[0]).toContain("fm-0123456789abcdef\\x1b[1A\\nVERIFIED");
    const json = cli(layout({ files: { ...pack, [evil]: "{}\n" } }), ["--json"]).lines.join("\n");
    expect(json.replaceAll("\n", "")).not.toMatch(CONTROL);
    expect(JSON.stringify(JSON.parse(json))).toContain("evil\\u001b[2K\\r\\n");
  });

  it("escapes invisible and format characters too (soft hyphen, ALM, zero-width, word joiner, invisible operators, BOM)", () => {
    const HIDDEN = "­؜​‌‍⁠⁡⁢⁣⁤﻿";
    const INVISIBLE = /[­؜​-‍⁠-⁤﻿]/;
    expect(printable(`ok${HIDDEN}`)).toBe("ok\\xad\\u061c\\u200b\\u200c\\u200d\\u2060\\u2061\\u2062\\u2063\\u2064\\ufeff");
    const evil = `evil${HIDDEN}.json`;
    const text = cli(layout({ files: { ...pack, [evil]: "{}\n" } }));
    expect(text.code).toBe(1);
    for (const line of text.lines) expect(line).not.toMatch(INVISIBLE);
    const json = cli(layout({ files: { ...pack, [evil]: "{}\n" } }), ["--json"]).lines.join("\n");
    expect(json).not.toMatch(INVISIBLE);
    expect(JSON.stringify(JSON.parse(json))).toContain(`unexpected file ${evil}`);
  });

  it("reads the pack under the pack's caps (4 MiB per file, code files 49,155 B, 400 entries)", () => {
    const big = cli(layout({ files: { ...pack, "big.bin": "x".repeat(4 * 1024 * 1024 + 1), "code/Treasury.hex": "0".repeat(49_156) } }));
    expect(big.code).toBe(1);
    expect(lineOf(big.lines, "pack files on disk")).toMatch(/^ {2}FAIL .*big\.bin: too large/);
    expect(lineOf(big.lines, "pack files on disk")).toMatch(/code\/Treasury\.hex: too large/);
    const junk = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`junk/${i}.json`, "{}"]));
    const many = cli(layout({ files: { ...pack, ...junk } }));
    expect(many.code).toBe(1);
    expect(lineOf(many.lines, "pack files on disk")).toMatch(/more than 400 entries/);
  });

  it("pins final-2 on the command line: a pack of another source run is not verified", () => {
    const { bundle, dir } = layout();
    expect(main([dir, "--sepolia-bundle", bundle], quiet)).toBe(1);
  });

  it("prints JSON with --json", () => {
    const { code, lines } = cli(layout(), ["--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, packId });
  });

  it("reads a forge out/ directory and fails when it differs from the packed artifacts", () => {
    const l = layout();
    const out = join(l.root, "out");
    for (const n of CODE_NAMES) {
      const a = artifactOf(n);
      write(join(out, `${n}.sol`), { [`${n}.json`]: JSON.stringify({ abi: [], bytecode: { object: a.bytecode }, deployedBytecode: { object: a.deployedBytecode, immutableReferences: a.immutableReferences } }) });
    }
    expect(Object.keys(readForgeArtifacts(out)).sort()).toEqual([...CODE_NAMES].sort());
    const built = cli(l, ["--artifacts", out]);
    expect(built.code).toBe(0);
    expect(lineOf(built.lines, "code identity")).toMatch(/artifacts equal the local forge build/);
    writeFileSync(join(out, "SalesOracle.sol", "SalesOracle.json"), "{}");
    expect(cli(l, ["--artifacts", out]).code).toBe(1);
  });

  it("exits 2 with nothing to verify or a bad argument", () => {
    const { bundle, dir } = layout();
    expect(main([], quiet)).toBe(2);
    expect(main([dir], quiet)).toBe(2);
    expect(main([join(newRoot(), "nope"), "--sepolia-bundle", bundle], quiet)).toBe(2);
    expect(main([dir, "--sepolia-bundle"], quiet)).toBe(2);
    expect(main([dir, "--sepolia-bundle", bundle, "--artifacts", join(newRoot(), "nope")], quiet)).toBe(2);
    expect(main([dir, "--sepolia-bundle", bundle, "--rpc", "x"], quiet)).toBe(2);
  });
});

describe("evidence/fisco/ is never an evidence bundle", () => {
  it("latestBundle and `make verify` skip it", () => {
    const { root, bundle } = layout();
    expect(latestBundle(root)).toBe(bundle);
    const only = newRoot();
    write(join(only, "fisco", packId), pack);
    expect(latestBundle(only)).toBeNull();
    expect(verifyMain(["--root", only], quiet)).toBe(2);
  });

  it("the API evidence store neither lists nor owns it", async () => {
    const { root } = layout();
    const tenant = { facilityId: "fac-test", deploymentId: SOURCE.deploymentId, chainId: SOURCE.chainId };
    const runs = await listRuns(root, tenant);
    expect(runs.map((r) => r.runId)).toEqual([SOURCE.runId]);
    expect(await ownsRun(root, "fisco", tenant)).toBe(false);
    expect(await ownsRun(root, `fisco/${packId}`, tenant)).toBe(false);
  });
});
