import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACK_DIR_RE, verifyFiscoPack, type FiscoResult } from "@hogee/verify-evidence/fisco";
import { ANCHOR_CHECK, verifyServedFisco, type FiscoSource, type ListedPack } from "./served-fisco";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
type Bytes = Uint8Array<ArrayBuffer>;

/** A folder as raw bytes, as `make verify-fisco` reads it (read-dir.ts). */
function folderBytes(dir: string): Record<string, Bytes> {
  const out: Record<string, Bytes> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).split(sep).join("/")] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

/** The tracked mirror pack (whichever evidence/fisco/fm-* is committed: P1 replaces it with each new run). */
const PACK_ID = readdirSync(join(ROOT, "evidence", "fisco")).find((n) => PACK_DIR_RE.test(n)) ?? "";
const PACK = folderBytes(join(ROOT, "evidence", "fisco", PACK_ID));
const SOURCE_RUN = (JSON.parse(new TextDecoder().decode(PACK["pack.json"])) as { sourceBundle: { runId: string } }).sourceBundle.runId;
const SOURCE = folderBytes(join(ROOT, "evidence", SOURCE_RUN));
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

const blob = (b: Bytes | undefined): Promise<Blob> => (b ? Promise.resolve(new Blob([b])) : Promise.reject(new Error("404")));

/** The local API as the page reads it: every file as a Blob of exactly its bytes. */
function served(pack: Record<string, Bytes>, sidecar?: Bytes): FiscoSource {
  return {
    packFile: (path) => blob(pack[path]),
    bundleFiles: async (runId) => (runId === SOURCE_RUN ? Object.keys(SOURCE) : Promise.reject(new Error("404"))),
    bundleFile: (_runId, path) => blob(SOURCE[path]),
    anchor: () => blob(sidecar),
  };
}

const listed = (pack: Record<string, Bytes>, anchored = false): ListedPack => ({ packId: PACK_ID, files: Object.keys(pack), anchored });
const verdicts = (r: FiscoResult) => r.checks.map((c) => [c.name, c.ok]);

describe("the Proof page checks a served FISCO pack as make verify-fisco checks it on disk", () => {
  it("found the tracked pack and the Sepolia bundle it mirrors", () => {
    expect(PACK_ID).toMatch(PACK_DIR_RE);
    expect(Object.keys(SOURCE)).toContain("hashes.json");
  });

  it("gives exactly the verifier's verdicts on the raw bytes (with the source bundle), plus the folder check", async () => {
    const r = await verifyServedFisco(listed(PACK), served(PACK), null);
    const cli = verifyFiscoPack(PACK, { sepoliaBundle: SOURCE });
    expect(verdicts(r.result)).toEqual(verdicts(cli));
    expect(r.result.ok).toBe(cli.ok);
    // As the CLI: the folder is compared with the packId the verifier loaded (none when pack.json fails its schema).
    expect(r.checks.at(-1)).toMatchObject({ name: "pack folder", ok: cli.packId === PACK_ID });
    expect(r.ok).toBe(cli.ok);
  });

  it("a BOM-prefixed steps.json is checked as its bytes, never as decoded text (run-10 re-check H-2)", async () => {
    const pack = { ...PACK, "steps.json": new Uint8Array([...BOM, ...(PACK["steps.json"] as Bytes)]) };
    const r = await verifyServedFisco(listed(pack), served(pack), null);
    expect(r.ok).toBe(false);
    expect(verdicts(r.result)).toEqual(verdicts(verifyFiscoPack(pack, { sepoliaBundle: SOURCE })));
  });

  it("one changed byte is never a pass", async () => {
    const steps = new Uint8Array(PACK["steps.json"] as Bytes);
    steps[steps.length - 2] = (steps[steps.length - 2] ?? 0) ^ 0x01;
    const pack = { ...PACK, "steps.json": steps };
    expect((await verifyServedFisco(listed(pack), served(pack), null)).ok).toBe(false);
  });

  it("a pack served under another folder name fails the folder check", async () => {
    const r = await verifyServedFisco({ ...listed(PACK), packId: "fm-0000000000000000" }, served(PACK), null);
    expect(r.checks.find((c) => c.name === "pack folder")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("a listed entry no pack may hold is never fetched, and fails the check by name as make verify-fisco does", async () => {
    const asked: string[] = [];
    const source = { ...served(PACK), packFile: (path: string) => (asked.push(path), blob(PACK[path])) };
    const r = await verifyServedFisco({ ...listed(PACK), files: [...Object.keys(PACK), "notes.txt"] }, source, null);
    expect(asked).not.toContain("notes.txt");
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: "pack files", ok: false });
    expect(r.checks[0]?.detail).toContain("unexpected file notes.txt");
  });

  it("a file that can't be read stops the check (the page says it could not be read)", async () => {
    // A name a pack may hold (so it is fetched), which the API can't serve.
    const missing = `txs/0x${"ee".repeat(32)}.json`;
    expect(PACK[missing]).toBeUndefined();
    await expect(verifyServedFisco({ ...listed(PACK), files: [...Object.keys(PACK), missing] }, served(PACK), null)).rejects.toThrow();
  });
});

describe("the Sepolia timestamp in the served check", () => {
  const SIDECAR = new TextEncoder().encode('{"format":"hogee.fisco-anchor/1"}');

  it("with no anchor check in this build, nothing is fetched and no timestamp line is added", async () => {
    let fetched = false;
    const source = { ...served(PACK, SIDECAR), anchor: () => ((fetched = true), blob(SIDECAR)) };
    const r = await verifyServedFisco(listed(PACK, true), source, null);
    expect(fetched).toBe(false);
    expect(r.anchor.available).toBe(false);
    expect(r.checks.map((c) => c.name)).not.toContain(ANCHOR_CHECK);
  });

  it("hands the check the pack's bytes and the exact sidecar bytes, and counts its line", async () => {
    let seen: { files: unknown; sidecar: Uint8Array | null } | null = null;
    const checker = (files: unknown, sidecar: Uint8Array | null) => {
      seen = { files, sidecar };
      return { name: ANCHOR_CHECK, ok: false, anchored: true, anchor: null, detail: "wrong signer" };
    };
    const r = await verifyServedFisco(listed(PACK, true), served(PACK, SIDECAR), checker);
    expect(seen).not.toBeNull();
    expect([...((seen as unknown as { sidecar: Uint8Array }).sidecar ?? [])]).toEqual([...SIDECAR]);
    expect(r.checks.find((c) => c.name === ANCHOR_CHECK)).toMatchObject({ ok: false, detail: "wrong signer" });
    expect(r.ok).toBe(false);
  });

  it("a pack the API lists without a sidecar is checked with none, and \"not timestamped yet\" is no check line at all (audit run-12 v-1)", async () => {
    let sidecarSeen: Uint8Array | null | undefined;
    const checker = (_files: unknown, sidecar: Uint8Array | null) => {
      sidecarSeen = sidecar;
      return { name: ANCHOR_CHECK, ok: true, anchored: false, anchor: null, detail: "not anchored" };
    };
    const r = await verifyServedFisco(listed(PACK, false), served(PACK), checker);
    expect(sidecarSeen).toBeNull();
    expect(r.anchor).toMatchObject({ available: true, ok: true, anchored: false });
    // Neither a passing "Timestamped on Sepolia" row nor a count: the verdict is the verifier's and the folder check's.
    expect(r.checks.map((c) => c.name)).not.toContain(ANCHOR_CHECK);
    expect(r.checks).toHaveLength(r.result.checks.length + 1);
    expect(r.ok).toBe(r.result.ok && r.checks.every((c) => c.ok));
  });

  it("with the real check and no sidecar, the timestamp adds no line either", async () => {
    const r = await verifyServedFisco(listed(PACK, false), served(PACK));
    expect(r.anchor).toMatchObject({ available: true, ok: true, anchored: false });
    expect(r.checks.map((c) => c.name)).not.toContain(ANCHOR_CHECK);
  });

  it("a served sidecar that checks is a counted, passing line", async () => {
    const facts = { txHash: `0x${"c0".repeat(32)}`, blockNumber: 7, timestamp: 9 };
    const r = await verifyServedFisco(listed(PACK, true), served(PACK, SIDECAR), () => ({ ok: true, anchored: true, anchor: facts, detail: "block 7" }));
    expect(r.checks.find((c) => c.name === ANCHOR_CHECK)).toMatchObject({ ok: true, detail: "block 7" });
    expect(r.checks).toHaveLength(r.result.checks.length + 2);
  });

  it("a check that fails without a sidecar is still a counted, failing line", async () => {
    const r = await verifyServedFisco(listed(PACK, false), served(PACK), () => ({ ok: false, anchored: false, anchor: null, detail: "an anchor is required" }));
    expect(r.checks.find((c) => c.name === ANCHOR_CHECK)).toMatchObject({ ok: false, detail: "an anchor is required" });
    expect(r.ok).toBe(false);
  });

  it("a check that claims an anchor when no sidecar was served fails closed", async () => {
    const facts = { txHash: `0x${"c0".repeat(32)}`, blockNumber: 7, timestamp: 9 };
    const r = await verifyServedFisco(listed(PACK, false), served(PACK), () => ({ ok: true, anchored: true, anchor: facts, detail: "" }));
    expect(r.anchor).toMatchObject({ ok: false, anchor: null });
    expect(r.checks.find((c) => c.name === ANCHOR_CHECK)?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("an anchor the API lists but can't serve is a failed timestamp, not a pass", async () => {
    const checker = () => ({ ok: true, anchored: true, anchor: null });
    const r = await verifyServedFisco(listed(PACK, true), served(PACK), checker);
    expect(r.anchor).toMatchObject({ available: true, ok: false, detail: "the anchor file could not be read" });
    expect(r.ok).toBe(false);
  });
});
