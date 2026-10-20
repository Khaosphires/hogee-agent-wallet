/**
 * parseTermsHint (VISION-DECISIONS §8): reads payment terms from the founder's chat text, AFTER the privacy redactor,
 * to prefill the terms card. Deterministic regex + lexeme rules, no LLM. It only ever suggests: the founder confirms
 * the split in the REST form and termsToSchedule re-checks it, so when in doubt it returns no prefill.
 *
 * - Amounts: "30%", "30 percent", "30 per cent", "30pct"; "half"; "in full" / "full payment" / "everything"; "the
 *   rest" / "remaining"; "balance" (the rest, when its clause has no other amount). A decimal ("30.5%") or a
 *   percentage over 100 refuses the whole hint.
 * - Triggers (hint-words.ts): "deposit / upfront / on order / first / now" → ON_ORDER, "sample" → ON_SAMPLE_OK,
 *   "shipment / ship / loading" → ON_SHIPMENT, "delivery / inspection / balance / COD" → ON_DELIVERY_INSPECTED.
 * - Clauses split at , ; . ! ? newline & + "and" "then". In a clause, if it opens with a trigger each amount takes the
 *   triggers before it ("deposit 30%, balance 70%"), else the triggers after it ("30% deposit 70% on delivery").
 * - Bare splits, only when the text has no other amount: "50/50", "30/70", "30 40 30", "half half". Two parts are
 *   deposit + balance, three are deposit + shipment + balance; any trigger word in the text must fit that convention.
 *
 * Result: a schedule (sum 10,000 bps, ≤ 8 parts, triggers in order, last ON_DELIVERY_INSPECTED: it always passes
 * termsToSchedule's structural rules), or `ambiguous` + DEPOSIT_TRIGGER when the split adds up but a part has no
 * trigger, or nothing. Parts of 0% are dropped; the parts are put in trigger order.
 */
import { MILESTONE_TRIGGERS, type MilestoneTrigger, type TermsMilestone } from "./constants";
import { blankBetween, lexHint, normaliseHint, type NumLexeme, type Lexeme } from "./hint-lexer";
import {
  BALANCE_TRIGGER, BALANCE_WORD, BARE_SPLIT_TRIGGERS, EVERYTHING_WORD, FULL_AFTER, FULL_BEFORE, HALF_JOINERS, HALF_WORD,
  ORDER_AFTER, ORDER_BEFORE, ORDER_TRIGGER, ORDER_WORDS, PAIR_TRIGGERS, PERCENT_WORDS, REST_WORDS, SEPARATOR_PUNCT,
  SEPARATOR_WORDS, SPLIT_JOINERS, STRONG_TRIGGERS, WEAK_TRIGGERS, WHOLE_AFTER, WHOLE_WORDS,
} from "./hint-words";
import { MAX_MILESTONES, structureProblem } from "./schedule";

export interface TermsHint {
  readonly milestones: TermsMilestone[] | null;
  readonly ambiguous: boolean;
  readonly question: "DEPOSIT_TRIGGER" | null;
}

const FULL = 10_000;
const HALF = 5_000;
const PERCENT_TO_BPS = 100;
const MAX_PERCENT = 100;

type Trig = { readonly kind: "trigger"; readonly trigger: MilestoneTrigger; readonly strong: boolean };
type Amount = { readonly kind: "amount"; readonly bps: number | "REST"; readonly bad: boolean; readonly explicit: boolean };
type Item = Trig | Amount | { readonly kind: "balance" } | { readonly kind: "sep" } | { readonly kind: "halfpair" };
type Resolved = MilestoneTrigger | "CONFLICT" | "MISSING";
type Part = { readonly bps: number | "REST"; readonly trigger: Resolved };

const none = (): TermsHint => ({ milestones: null, ambiguous: false, question: null });
const ask = (): TermsHint => ({ milestones: null, ambiguous: true, question: "DEPOSIT_TRIGGER" });
const RANK: ReadonlyMap<MilestoneTrigger, number> = new Map(MILESTONE_TRIGGERS.map((t, i) => [t, i]));

const wordAt = (ts: readonly Lexeme[], i: number): string | null => {
  const t = ts[i];
  return t?.kind === "word" ? t.text : null;
};
const textAt = (ts: readonly Lexeme[], i: number): string | null => {
  const t = ts[i];
  return t === undefined || t.kind === "num" ? null : t.text;
};

/** Lexemes after the number at `n` that make it a percentage: 0 (none), 1 ("%", "percent") or 2 ("per cent"). */
function percentMarker(s: string, ts: readonly Lexeme[], n: number): number {
  const num = ts[n];
  const next = ts[n + 1];
  if (num === undefined || next === undefined || !blankBetween(s, num, next)) return 0;
  if (textAt(ts, n + 1) === "%" || PERCENT_WORDS.has(wordAt(ts, n + 1) ?? "")) return 1;
  return wordAt(ts, n + 1) === "per" && wordAt(ts, n + 2) === "cent" ? 2 : 0;
}

/** Lexemes taken by "half half" / "half-half" / "half and half" starting at i (0 if it is not one). */
function halfPair(ts: readonly Lexeme[], i: number): number {
  if (wordAt(ts, i) !== HALF_WORD) return 0;
  if (wordAt(ts, i + 1) === HALF_WORD) return 2;
  return HALF_JOINERS.has(textAt(ts, i + 1) ?? "") && wordAt(ts, i + 2) === HALF_WORD ? 3 : 0;
}

/** One word (with its neighbours for context) → an item and how many lexemes it used, or null. */
function wordItem(ts: readonly Lexeme[], i: number, w: string): [Item, number] | null {
  const prev = wordAt(ts, i - 1) ?? "";
  const next = wordAt(ts, i + 1) ?? "";
  const amount = (bps: number | "REST", used = 1): [Item, number] => [{ kind: "amount", bps, bad: false, explicit: bps !== "REST" }, used];
  if (w === HALF_WORD) return amount(HALF);
  if (w === "full" && (FULL_BEFORE.has(prev) || FULL_AFTER.has(next))) return amount(FULL, FULL_AFTER.has(next) ? 2 : 1);
  if (WHOLE_WORDS.has(w) && WHOLE_AFTER.has(next)) return amount(FULL, 2);
  if (w === EVERYTHING_WORD) return amount(FULL);
  if (REST_WORDS.has(w)) return amount("REST");
  if (w === BALANCE_WORD) return [{ kind: "balance" }, 1];
  if (SEPARATOR_WORDS.has(w)) return [{ kind: "sep" }, 1];
  const pair = PAIR_TRIGGERS.get(`${w} ${textAt(ts, i + 1) === "-" ? (wordAt(ts, i + 2) ?? "") : next}`);
  if (pair) return [{ kind: "trigger", trigger: pair, strong: true }, textAt(ts, i + 1) === "-" ? 3 : 2];
  if (ORDER_WORDS.has(w) && (ORDER_BEFORE.has(prev) || ORDER_AFTER.has(next))) return [{ kind: "trigger", trigger: ORDER_TRIGGER, strong: true }, 1];
  const strong = STRONG_TRIGGERS.get(w);
  if (strong) return [{ kind: "trigger", trigger: strong, strong: true }, 1];
  const weak = WEAK_TRIGGERS.get(w);
  return weak ? [{ kind: "trigger", trigger: weak, strong: false }, 1] : null;
}

/** Lexemes → items (amounts, triggers, "balance", clause breaks, "half half"). */
function itemsOf(s: string, ts: readonly Lexeme[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < ts.length; ) {
    const t = ts[i] as Lexeme;
    if (t.kind === "num") {
      const marker = percentMarker(s, ts, i);
      if (marker > 0) items.push({ kind: "amount", bps: t.value * PERCENT_TO_BPS, bad: t.decimal || t.value > MAX_PERCENT, explicit: true });
      i += 1 + marker;
      continue;
    }
    const pair = halfPair(ts, i);
    if (pair > 0) {
      items.push({ kind: "halfpair" });
      i += pair;
      continue;
    }
    const found = t.kind === "word" ? wordItem(ts, i, t.text) : SEPARATOR_PUNCT.has(t.text) ? ([{ kind: "sep" }, 1] as [Item, number]) : null;
    if (found) items.push(found[0]);
    i += found ? found[1] : 1;
  }
  return items;
}

/**
 * Runs of bare numbers joined by / - : or by spaces only ("30/70", "30 40 30"). A run is readable when every number
 * is a whole 0–100 with at most 3 digits ("30.5/69.5" and "19/10/2026" are not).
 */
function bareRuns(s: string, ts: readonly Lexeme[]): { values: number[]; readable: boolean }[] {
  const runs: { values: number[]; readable: boolean }[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const first = ts[i] as Lexeme;
    if (first.kind !== "num") continue;
    const run: NumLexeme[] = [first];
    for (;;) {
      const last = run[run.length - 1] as NumLexeme;
      const a = ts[i + 1];
      const b = ts[i + 2];
      if (a?.kind === "num" && blankBetween(s, last, a)) {
        run.push(a);
        i += 1;
      } else if (a?.kind === "punct" && SPLIT_JOINERS.has(a.text) && b?.kind === "num" && blankBetween(s, last, a) && blankBetween(s, a, b)) {
        run.push(b);
        i += 2;
      } else break;
    }
    const readable = run.every((x) => !x.decimal && x.digits <= 3 && x.value <= MAX_PERCENT);
    runs.push({ values: run.map((x) => x.value), readable });
  }
  return runs;
}

/** A single strong trigger wins; else a single weak one; two different ones conflict; none is missing. */
function resolve(trigs: readonly Trig[]): Resolved {
  for (const strong of [true, false]) {
    const set = new Set(trigs.filter((t) => t.strong === strong).map((t) => t.trigger));
    if (set.size > 1) return "CONFLICT";
    const [only] = set;
    if (only !== undefined) return only;
  }
  return "MISSING";
}

/** One clause → its parts. A clause that opens with a trigger gives each amount the triggers before it. */
function clauseParts(clause: readonly Item[]): Part[] {
  const hasAmount = clause.some((x) => x.kind === "amount");
  const items: (Trig | Amount)[] = clause.flatMap((x): (Trig | Amount)[] => {
    if (x.kind !== "balance") return x.kind === "amount" || x.kind === "trigger" ? [x] : [];
    const asTrigger: Trig = { kind: "trigger", trigger: BALANCE_TRIGGER, strong: false };
    return hasAmount ? [asTrigger] : [{ kind: "amount", bps: "REST", bad: false, explicit: false }, asTrigger];
  });
  const at = items.flatMap((x, i) => (x.kind === "amount" ? [i] : []));
  const triggerFirst = items[0]?.kind === "trigger";
  const triggersIn = (from: number, to: number) => items.slice(from, to).filter((x): x is Trig => x.kind === "trigger");
  return at.map((p, k) => {
    const before = triggersIn(k === 0 ? 0 : (at[k - 1] as number) + 1, p);
    const after = triggersIn(p + 1, at[k + 1] ?? items.length);
    const last = k === at.length - 1;
    const trigs = triggerFirst ? (last ? [...before, ...after] : before) : after;
    return { bps: (items[p] as Amount).bps, trigger: resolve(trigs) };
  });
}

function splitClauses(items: readonly Item[]): Item[][] {
  const clauses: Item[][] = [[]];
  for (const x of items) {
    if (x.kind === "sep") clauses.push([]);
    else (clauses[clauses.length - 1] as Item[]).push(x);
  }
  return clauses;
}

/** Shared tail: drop 0% parts, ≤ 8 parts, ask on a missing trigger, trigger order, structural check. */
function finish(parts: readonly { bps: number; trigger: Resolved }[]): TermsHint {
  const kept = parts.filter((p) => p.bps > 0);
  if (kept.length < 1 || kept.length > MAX_MILESTONES) return none();
  if (kept.some((p) => p.trigger === "MISSING")) return ask();
  const milestones = kept
    .map((p) => ({ bps: p.bps, trigger: p.trigger as MilestoneTrigger }))
    .sort((a, b) => (RANK.get(a.trigger) as number) - (RANK.get(b.trigger) as number));
  return structureProblem(milestones) ? none() : { milestones, ambiguous: false, question: null };
}

function explicitHint(items: readonly Item[]): TermsHint {
  const amounts = items.filter((x): x is Amount => x.kind === "amount");
  if (amounts.some((a) => a.bad) || amounts.length > MAX_MILESTONES) return none();
  const parts = splitClauses(items).flatMap(clauseParts);
  if (parts.some((p) => p.trigger === "CONFLICT")) return none();
  const rest = parts.filter((p) => p.bps === "REST").length;
  const stated = parts.reduce((sum, p) => sum + (p.bps === "REST" ? 0 : p.bps), 0);
  if (rest > 1 || (rest === 1 ? stated >= FULL : stated !== FULL)) return none();
  return finish(parts.map((p) => ({ bps: p.bps === "REST" ? FULL - stated : p.bps, trigger: p.trigger })));
}

function bareSplitHint(s: string, ts: readonly Lexeme[], items: readonly Item[]): TermsHint {
  if (items.some((x) => x.kind === "amount")) return none();
  const halfPairs = items.filter((x) => x.kind === "halfpair").map(() => [50, 50]);
  const splits = [...bareRuns(s, ts).filter((r) => r.readable && r.values.length >= 2).map((r) => r.values), ...halfPairs]
    .filter((values) => values.reduce((a, b) => a + b, 0) === MAX_PERCENT);
  const [values] = splits;
  const convention = values ? BARE_SPLIT_TRIGGERS.get(values.length) : undefined;
  if (splits.length !== 1 || !values || !convention) return none();
  const named = items.flatMap((x) => (x.kind === "trigger" ? [x.trigger] : x.kind === "balance" ? [BALANCE_TRIGGER] : []));
  if (named.some((t) => !convention.includes(t))) return none();
  return finish(values.map((v, i) => ({ bps: v * PERCENT_TO_BPS, trigger: convention[i] as MilestoneTrigger })));
}

export function parseTermsHint(redactedText: string): TermsHint {
  if (typeof redactedText !== "string") return none();
  const s = normaliseHint(redactedText);
  if (s === null) return none();
  const lexemes = lexHint(s);
  const items = itemsOf(s, lexemes);
  return items.some((x) => x.kind === "amount" && x.explicit) ? explicitHint(items) : bareSplitHint(s, lexemes, items);
}
