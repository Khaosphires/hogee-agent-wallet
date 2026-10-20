/**
 * The wording rule for everything the founder can see (VISION-DECISIONS §0.5): the repo's own `checkText` (the wording
 * lint, with its allow-list), plus the words only the e2e bans: "confidence" (say "estimate") and the plurals of the
 * crypto words, which the lint's allow-list lets through for a usage-column heading that no page shows.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Finding {
  readonly term: string;
  readonly matched: string;
}

const LINT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "lint-wording");

/** The wording lint's own checker, imported as apps/web/lib/reason-labels.test.ts does (a URL, so Windows works too). */
const { checkText } = (await import(pathToFileURL(join(LINT_DIR, "index.mjs")).href)) as {
  checkText: (text: string, allowed?: readonly string[]) => readonly Finding[];
};

/** The lint's exact allowed phrases (scripts/lint-wording/allow.txt), read once. */
const ALLOWED: readonly string[] = readFileSync(join(LINT_DIR, "allow.txt"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

/** e2e-only: the page never says "confidence", and never a crypto word in any form. */
const E2E_ONLY = /\b(tokens?|tokeni[sz]ed|coins?|stablecoins?|confidence)\b/gi;

/** Every banned word in `text`, as found (empty when the text is clean). */
export function bannedWordsIn(text: string): string[] {
  const lint = checkText(text, ALLOWED).map((f) => f.matched);
  return [...lint, ...[...text.matchAll(E2E_ONLY)].map((m) => m[0])];
}
