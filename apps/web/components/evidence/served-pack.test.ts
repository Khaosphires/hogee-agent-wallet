import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashesFileOf, verifyBundle, type VerifyResult } from "@hogee/verify-evidence";
import { verifyServedPack } from "./served-pack";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** The tracked final-2 Sepolia export (proof-model.test.ts FINAL_2). */
const FINAL_2 = "ev-74756ea61a72ae7c";
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

type Bytes = Uint8Array<ArrayBuffer>;

/** A pack folder as raw bytes, as `make verify` reads it from disk (read-dir.ts). */
function packBytes(runId: string): Record<string, Bytes> {
  const dir = join(ROOT, "evidence", runId);
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

/** The Proof page's check of `files`, each served as a Blob of exactly those bytes (as the API serves them). */
const served = (files: Record<string, Bytes>) => verifyServedPack(Object.keys(files), async (path) => new Blob([files[path] as Bytes]));
const verdicts = (r: VerifyResult) => r.checks.map((c) => [c.name, c.ok]);
const failed = (r: VerifyResult) => r.checks.filter((c) => !c.ok).map((c) => c.name);

const withBytes = (bytes: Bytes, at: number, insert: Uint8Array): Bytes => {
  const out = new Uint8Array(bytes.length + insert.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(insert, at);
  out.set(bytes.subarray(at), at + insert.length);
  return out;
};

// Run-10 skills re-check H-2: the browser must hash the bytes served, as the CLI hashes the bytes on disk. Blob.text()
// drops a BOM and replaces invalid UTF-8, so a decoded-then-re-encoded file could pass here and fail `make verify`.
describe("the Proof page checks the served bytes, as make verify does (re-check H-2)", () => {
  it("the tracked pack verifies (control)", async () => {
    const files = packBytes(FINAL_2);
    const r = await served(files);
    expect(r.ok, JSON.stringify(r.checks.filter((c) => !c.ok))).toBe(true);
    expect(verdicts(r)).toEqual(verdicts(verifyBundle(files)));
  });

  it("a BOM-prefixed evidence.json fails on file hashes, like verifyBundle on the raw bytes", async () => {
    const pack = packBytes(FINAL_2);
    // hashes.json is unchanged: it lists the hash of the file without the BOM, the text Blob.text() would give.
    const files = { ...pack, "evidence.json": withBytes(pack["evidence.json"] as Bytes, 0, BOM) };
    const cli = verifyBundle(files);
    expect(cli.ok).toBe(false);
    expect(failed(cli)).toEqual(["file hashes"]);
    const r = await served(files);
    expect(r.ok).toBe(false);
    expect(failed(r)).toEqual(["file hashes"]);
    expect(verdicts(r)).toEqual(verdicts(cli));
  });

  it("invalid UTF-8 is never repaired: a pack listing the repaired text's hash fails, like the CLI", async () => {
    const pack = packBytes(FINAL_2);
    const text = new TextDecoder().decode(pack["evidence.json"]);
    // 0xFF inside the first row's title: Blob.text() would read it as U+FFFD and re-encode it as EF BF BD.
    const at = new TextEncoder().encode(text.slice(0, text.indexOf('"title": "') + '"title": "'.length)).length;
    const broken = withBytes(pack["evidence.json"] as Bytes, at, new Uint8Array([0xff]));
    const repaired = new TextEncoder().encode(new TextDecoder().decode(broken));
    const hashed = { ...pack, "evidence.json": broken, "hashes.json": new TextEncoder().encode(hashesWithRepaired(pack, repaired)) };
    const cli = verifyBundle(hashed);
    expect(cli.ok).toBe(false);
    expect(failed(cli)).toEqual(expect.arrayContaining(["bundle files", "file hashes"]));
    const r = await served(hashed);
    expect(r.ok).toBe(false);
    expect(verdicts(r)).toEqual(verdicts(cli));
  });
});

/** hashes.json as a forger would write it: evidence.json listed with the hash of its repaired (U+FFFD) text. */
function hashesWithRepaired(pack: Record<string, Bytes>, repaired: Bytes): string {
  return hashesFileOf(Object.fromEntries(Object.entries({ ...pack, "evidence.json": repaired }).filter(([path]) => path !== "hashes.json")));
}
