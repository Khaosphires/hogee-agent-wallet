/**
 * The node side: the sidecar is found at <pack>/../anchors/<packId>.sepolia.json and read without following links
 * (a symlinked file or folder, a hard link, a FIFO or an oversize file is refused, never read); `anchorLine` gives
 * the CLI its "Sepolia timestamp" line (not anchored passes, --require-anchor fails it), and `onlineAnchorLines` the
 * online one when --anchor-rpc (or HOGEE_ANCHOR_RPC) asks for it.
 */
import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ANCHOR_BYTES } from "../../src/fisco/anchor";
import { anchorLine, onlineAnchorLines } from "../../src/fisco/anchor-cli";
import { anchorPathOf, readAnchorFile } from "../../src/fisco/anchor-file";
import type { AnchorFetch } from "../../src/fisco/anchor-online";
import { anchorPack, BLOCK, SIGNER, sidecarOf, type AnchorPack } from "./anchor-fixture";

let a: AnchorPack;
let good: string;
const roots: string[] = [];
const newRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hogee-anchor-"));
  roots.push(d);
  return d;
};

beforeAll(async () => {
  a = await anchorPack();
  good = await sidecarOf(a);
}, 60_000);
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** <root>/fisco/<packId>/ (no files needed on disk here) and, optionally, the sidecar beside it. */
function layout(sidecar?: string): { dir: string; anchors: string; path: string } {
  const fisco = join(newRoot(), "fisco");
  const dir = join(fisco, a.packId);
  mkdirSync(dir, { recursive: true });
  const anchors = join(fisco, "anchors");
  const path = join(anchors, `${a.packId}.sepolia.json`);
  if (sidecar !== undefined) {
    mkdirSync(anchors);
    writeFileSync(path, sidecar);
  }
  return { dir, anchors, path };
}

describe("readAnchorFile", () => {
  it("finds the sidecar next to the pack and reads it", () => {
    const l = layout(good);
    expect(anchorPathOf(l.dir, a.packId)).toBe(l.path);
    const r = readAnchorFile(l.path);
    expect(r.kind).toBe("bytes");
    expect(r.kind === "bytes" && new TextDecoder().decode(r.bytes)).toBe(good);
  });

  it("a missing folder or file is not anchored", () => {
    const l = layout();
    expect(readAnchorFile(l.path).kind).toBe("missing");
    mkdirSync(l.anchors);
    expect(readAnchorFile(l.path).kind).toBe("missing");
  });

  it("refuses a symlinked sidecar, a symlinked anchors folder, a hard link, a FIFO and an oversize file", () => {
    const elsewhere = join(newRoot(), "real.json");
    writeFileSync(elsewhere, good);
    const linked = layout();
    mkdirSync(linked.anchors);
    symlinkSync(elsewhere, linked.path);
    expect(readAnchorFile(linked.path)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/not a regular file/) });

    const folder = layout();
    const realAnchors = newRoot();
    writeFileSync(join(realAnchors, `${a.packId}.sepolia.json`), good);
    symlinkSync(realAnchors, folder.anchors);
    expect(readAnchorFile(folder.path)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/not a real folder/) });

    const hard = layout();
    mkdirSync(hard.anchors);
    linkSync(elsewhere, hard.path);
    expect(readAnchorFile(hard.path)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/hard link/) });

    const fifo = layout();
    mkdirSync(fifo.anchors);
    execFileSync("/usr/bin/mkfifo", [fifo.path]);
    expect(readAnchorFile(fifo.path)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/not a regular file/) });

    const big = layout(`${good}${" ".repeat(MAX_ANCHOR_BYTES)}`);
    expect(readAnchorFile(big.path)).toMatchObject({ kind: "refused", reason: expect.stringMatching(/larger than/) });
  });
});

const okFetch: AnchorFetch = async (_url, init) => {
  const { method } = JSON.parse(init.body) as { method: string };
  const result = method === "eth_chainId" ? "0xaa36a7" : method === "eth_getTransactionReceipt" ? JSON.parse(good).receipt : { ...BLOCK };
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
};

const VALUE_FLAGS: ReadonlySet<string> = new Set(["--sepolia-bundle", "--artifacts", "--anchor-rpc"]);

describe("anchorLine (the CLI's offline Sepolia timestamp line)", () => {
  it("not anchored: a passing line; --require-anchor fails it", () => {
    const l = layout();
    expect(anchorLine(l.dir, a.files, a.packId, [])).toEqual({ name: "Sepolia timestamp", ok: true, detail: expect.stringMatching(/^not anchored/) });
    expect(anchorLine(l.dir, a.files, a.packId, ["--require-anchor"]).ok).toBe(false);
  });

  it("anchored: passes for the test signer, fails for the default (the hogee-deployer); only name, ok and detail", () => {
    const l = layout(good);
    const line = anchorLine(l.dir, a.files, a.packId, [], { signer: SIGNER });
    expect(line).toMatchObject({ name: "Sepolia timestamp", ok: true, detail: expect.stringContaining("https://sepolia.etherscan.io/tx/") });
    expect(Object.keys(line).sort()).toEqual(["detail", "name", "ok"]);
    expect(anchorLine(l.dir, a.files, a.packId, ["--require-anchor"])).toMatchObject({ ok: false, detail: expect.stringMatching(/not the hogee-deployer/) });
  });

  it("a refused sidecar is a failing line, never 'not anchored'", () => {
    const l = layout();
    mkdirSync(l.anchors);
    symlinkSync(join(newRoot(), "nowhere.json"), l.path);
    expect(anchorLine(l.dir, a.files, a.packId, [])).toMatchObject({ ok: false, detail: expect.stringMatching(/not a regular file/) });
  });

  it("uses the folder name when pack.json did not load, and fails on a folder that is not a pack id", () => {
    const l = layout(good);
    expect(anchorLine(l.dir, a.files, null, [], { signer: SIGNER }).ok).toBe(true);
    expect(anchorLine(join(newRoot(), "x"), a.files, null, [])).toMatchObject({ ok: false, detail: expect.stringMatching(/no packId/) });
  });
});

describe("onlineAnchorLines (--anchor-rpc / HOGEE_ANCHOR_RPC)", () => {
  const argv = (dir: string, ...more: string[]) => [dir, "--sepolia-bundle", "/nowhere", ...more];

  it("adds nothing unless asked", async () => {
    expect(await onlineAnchorLines(argv(layout(good).dir), VALUE_FLAGS, { env: {}, fetch: okFetch })).toEqual([]);
  });

  it("confirms through the flag or the environment variable", async () => {
    const l = layout(good);
    const viaFlag = await onlineAnchorLines(argv(l.dir, "--anchor-rpc", "https://sepolia.example.test/"), VALUE_FLAGS, { env: {}, fetch: okFetch });
    expect(viaFlag).toEqual([{ name: "Sepolia timestamp (online)", ok: true, detail: expect.stringMatching(/same receipt/) }]);
    const viaEnv = await onlineAnchorLines(argv(l.dir), VALUE_FLAGS, { env: { HOGEE_ANCHOR_RPC: "https://sepolia.example.test/" }, fetch: okFetch });
    expect(viaEnv.map((c) => c.ok)).toEqual([true]);
    const bad = await onlineAnchorLines(argv(l.dir, "--anchor-rpc", "http://sepolia.example.test/"), VALUE_FLAGS, { env: {}, fetch: okFetch });
    expect(bad[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/must be https/) });
  });

  it("fails with no sidecar (nothing to confirm) or a refused one; a bad command line adds nothing", async () => {
    const rpc = ["--anchor-rpc", "https://sepolia.example.test/"];
    expect((await onlineAnchorLines(argv(layout().dir, ...rpc), VALUE_FLAGS, { env: {}, fetch: okFetch }))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/nothing to confirm/) });
    const l = layout();
    mkdirSync(l.anchors);
    symlinkSync(join(newRoot(), "nowhere.json"), l.path);
    expect((await onlineAnchorLines(argv(l.dir, ...rpc), VALUE_FLAGS, { env: {}, fetch: okFetch }))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/^not run/) });
    expect(await onlineAnchorLines(["a", "b", ...rpc], VALUE_FLAGS, { env: {}, fetch: okFetch })).toEqual([]);
  });

  it("reads the sidecar once: the offline line checks the bytes the online line confirmed, though the file changes between them", async () => {
    const l = layout(good);
    const cmd = argv(l.dir, "--anchor-rpc", "https://sepolia.example.test/");
    expect((await onlineAnchorLines(cmd, VALUE_FLAGS, { env: {}, fetch: okFetch })).map((c) => c.ok)).toEqual([true]);
    writeFileSync(l.path, "{}");
    expect(anchorLine(l.dir, a.files, a.packId, cmd, { signer: SIGNER })).toMatchObject({ ok: true, detail: expect.stringMatching(/names this pack/) });
    // Another command line reads the file as it is now.
    expect(anchorLine(l.dir, a.files, a.packId, [...cmd], { signer: SIGNER })).toMatchObject({ ok: false, detail: expect.stringMatching(/schema/) });

    const swapped = layout("{}");
    const cmd2 = argv(swapped.dir, "--anchor-rpc", "https://sepolia.example.test/");
    expect((await onlineAnchorLines(cmd2, VALUE_FLAGS, { env: {}, fetch: okFetch })).map((c) => c.ok)).toEqual([false]);
    writeFileSync(swapped.path, good);
    expect(anchorLine(swapped.dir, a.files, a.packId, cmd2, { signer: SIGNER }).ok).toBe(false);
  });
});
