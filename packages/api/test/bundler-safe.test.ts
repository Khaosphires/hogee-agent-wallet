import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// apps/web bundles @hogee/api (and what it imports) with Next. Next treats `new URL("<literal>", import.meta.url)` as
// an asset import and fails the whole build when the literal is a directory ("Module not found: Can't resolve"), and
// Turbopack follows an indirect base (`const u = import.meta.url; new URL("..", u)`) too. Resolve paths with node:path
// from fileURLToPath(import.meta.url) instead.
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
// What apps/web/app/api/[...route]/route.ts pulls in (@hogee/chain is imported by file through chain-lib.ts).
const BUNDLED = ["packages/api", "packages/api-mock", "packages/core", "packages/db", "packages/agent", "packages/checks", "packages/privacy", "tools/verify-evidence"];
const ASSET_URL = /new URL\(\s*["'`]\.\.?\//;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|mts)$/.test(e.name) ? [p] : [];
  });
}

describe("code apps/web bundles", () => {
  it("never builds a relative new URL (an asset import to the bundler)", () => {
    const offenders = BUNDLED.flatMap((pkg) => sourceFiles(join(REPO, pkg, "src")))
      .filter((f) => readFileSync(f, "utf8").split("\n").some((line) => !/^\s*(\/\/|\/?\*)/.test(line) && ASSET_URL.test(line)))
      .map((f) => f.slice(REPO.length));
    expect(offenders).toEqual([]);
  });
});
