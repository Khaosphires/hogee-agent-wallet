/**
 * Writes data/schemas/<name>.schema.json for every schema P3 produces data for (z.toJSONSchema).
 * Usage: tsx scripts/gen-json-schemas.ts [--check]
 *   --check  write nothing; exit 1 if data/schemas is missing, stale or has extra *.schema.json files.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderJsonSchemas } from "./lib/json-schemas";
import { REPO_ROOT } from "./lib/paths";

const outDir = join(REPO_ROOT, "data", "schemas");
const checkOnly = process.argv.includes("--check");
const rendered = renderJsonSchemas();
const existing = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".schema.json")) : [];
const extra = existing.filter((f) => !rendered.has(f));

if (checkOnly) {
  const problems: string[] = [];
  for (const [file, content] of rendered) {
    const path = join(outDir, file);
    if (!existsSync(path)) problems.push(`missing  data/schemas/${file}`);
    else if (readFileSync(path, "utf8") !== content) problems.push(`stale    data/schemas/${file}`);
  }
  for (const file of extra) problems.push(`extra    data/schemas/${file}`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\ngen:schemas --check failed: run \`pnpm --filter @hogee/core gen:schemas\`\n`);
    process.exit(1);
  }
  process.stdout.write(`gen:schemas --check: ${rendered.size} schemas up to date\n`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const file of extra) rmSync(join(outDir, file));
  for (const [file, content] of rendered) writeFileSync(join(outDir, file), content);
  process.stdout.write(`gen:schemas: wrote ${rendered.size} files to data/schemas${extra.length ? ` (removed ${extra.length} stale)` : ""}\n`);
}
