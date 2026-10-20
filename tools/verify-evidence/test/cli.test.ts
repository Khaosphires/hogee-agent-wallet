/** The `make verify` CLI: latest bundle, exit codes, and links never followed on disk. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestBundle, main } from "../src/cli";
import { buildFixture, editJson, type Fixture } from "./fixture";

let fx: Fixture;
const roots: string[] = [];
const newRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "hogee-verify-"));
  roots.push(d);
  return d;
};
function writeBundle(root: string, runId: string, files: Record<string, string>): string {
  const dir = join(root, runId);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}
const quiet = () => undefined;

beforeAll(async () => {
  fx = await buildFixture();
});
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe("verify-evidence CLI", () => {
  it("exits 0 on a valid bundle and 1 on a tampered one", () => {
    const root = newRoot();
    const good = writeBundle(root, "run-good", fx.files);
    const bad = writeBundle(root, "run-bad", editJson(fx.files, "plans.json", (p) => void (p[0].manifest.totalMinor = "1000001")));
    expect(main([good], quiet)).toBe(0);
    expect(main([bad], quiet)).toBe(1);
  });

  it("picks the latest exported bundle under --root, and exits 2 when there is none", () => {
    const root = newRoot();
    writeBundle(root, "run-old", editJson(fx.files, "contracts.json", (c) => void (c.exportedAt = "2026-10-01T00:00:00.000Z")));
    writeBundle(root, "run-new", fx.files);
    expect(latestBundle(root)).toBe(join(root, "run-new"));
    expect(main(["--root", root], quiet)).toBe(0); // run-new is verified; the older, edited run-old is not picked
  });

  it("refuses a symlinked file inside a bundle", () => {
    const root = newRoot();
    const dir = writeBundle(root, "run-link", fx.files);
    const outside = join(newRoot(), "secret.txt");
    writeFileSync(outside, "not evidence");
    rmSync(join(dir, "SUMMARY.md"));
    symlinkSync(outside, join(dir, "SUMMARY.md"));
    const lines: string[] = [];
    expect(main([dir], (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toMatch(/SUMMARY.md: not a regular file/);
  });

  it("exits 2 with no bundle", () => {
    expect(main(["--root", newRoot()], quiet)).toBe(2);
  });
});
