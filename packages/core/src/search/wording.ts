/**
 * Runtime twin of scripts/lint-wording (checkText) for strings that come from the web (seller names, listing hosts):
 * the repo lint scans committed files only, so web-derived text is checked here before it can reach a card
 * (VISION-DECISIONS §0.5, §9). Same terms, same whole-word rule (no letter, digit or underscore on either side, any
 * case), Chinese phrases anywhere. core/test/search-wording.test.ts keeps it equal to the script.
 */
const TERMS = [
  "token",
  "coin",
  "stablecoin",
  "USDC",
  "x402",
  "DeFi",
  "RWA",
  "tokenised",
  "tokenized",
  "issue",
  "trade",
  "yield",
  "purpose-bound money",
  "programmable money",
  "AI autonomously spends your money",
  "We hold funds",
  "legal advice",
  "tax advice",
  "knows every country's law",
  "compliant with",
  "certified",
] as const;
const CHINESE = ["代币", "通证", "发行", "交易"] as const;

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const BOUNDARY = "[\\p{L}\\p{N}_]";
const PATTERNS: readonly RegExp[] = [
  ...TERMS.map((t) => new RegExp(`(?<!${BOUNDARY})${escape(t)}(?!${BOUNDARY})`, "iu")),
  ...CHINESE.map((t) => new RegExp(t, "u")),
];

/** True when `text` (every line of it) has none of the wording-lint terms. */
export function passesWording(text: string): boolean {
  return text.split(/\r?\n/).every((line) => PATTERNS.every((p) => !p.test(line)));
}

/** What a card shows instead of a web-derived name that fails the wording check or is too long. */
export const NAME_HIDDEN = "(name hidden)";

/** A web-derived display name for a card: itself when it passes the wording check and fits, else NAME_HIDDEN. */
export function cardSafeName(name: string, max: number): string {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= max && passesWording(trimmed) ? trimmed : NAME_HIDDEN;
}
