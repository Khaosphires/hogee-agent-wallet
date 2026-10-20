/**
 * Detection over folded text: every recognizer pattern is scanned, matches inside a protected span (UUIDs, 0x hex) are
 * skipped, then the validator, the negative context and the required context decide. Overlapping candidates merge into
 * one span covering all of them (so no digit of a partial match stays visible), labelled by the longest candidate,
 * then the highest score, then file order. Offsets are mapped back to the ORIGINAL text.
 */
import type { CompiledRecognizer, CompiledRecognizers, ContextWindow } from "./config";
import { foldText } from "./fold";
import { hasCountryCode, isStandardLengthCard } from "./validators";

export interface Span {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

interface Candidate extends Span {
  readonly score: number;
  readonly rank: number;
}

/** Sorted, non-overlapping [start, end) ranges with binary-search queries. */
export class Ranges {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];

  /** Matches of `res` over `text`, overlapping ones merged. */
  static scan(text: string, res: readonly RegExp[]): Ranges {
    const all: [number, number][] = [];
    for (const re of res) for (const m of text.matchAll(re)) all.push([m.index, m.index + m[0].length]);
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const r = new Ranges();
    for (const [s, e] of all) {
      const last = r.ends.length - 1;
      if (last >= 0 && s < (r.ends[last] as number)) r.ends[last] = Math.max(r.ends[last] as number, e);
      else {
        r.starts.push(s);
        r.ends.push(e);
      }
    }
    return r;
  }

  /** First range whose end is after `pos`. */
  private firstEndingAfter(pos: number): number {
    let lo = 0;
    let hi = this.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.ends[mid] as number) > pos) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** Some range lies entirely inside [lo, hi). */
  within(lo: number, hi: number): boolean {
    let a = 0;
    let b = this.starts.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if ((this.starts[mid] as number) >= lo) b = mid;
      else a = mid + 1;
    }
    return a < this.starts.length && (this.ends[a] as number) <= hi;
  }

  /** Some single range contains [lo, hi). */
  contains(lo: number, hi: number): boolean {
    const i = this.firstEndingAfter(lo);
    return i < this.starts.length && (this.starts[i] as number) <= lo && (this.ends[i] as number) >= hi;
  }

  /** Some range lies inside [from, hi) and ends at or after `lo`. The last range ending by `hi` is the only one to check. */
  endsIn(from: number, lo: number, hi: number): boolean {
    const i = this.firstEndingAfter(hi) - 1;
    return i >= 0 && (this.ends[i] as number) >= lo && (this.starts[i] as number) >= from;
  }
}

/** ASCII-only lower-casing keeps offsets aligned (String#toLowerCase can change length outside ASCII). */
const lowerAscii = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** The context window around [start, end), cut at the nearest line break when sameLine (scans only the window). */
function contextRange(text: string, start: number, end: number, w: ContextWindow): [number, number] {
  let lo = Math.max(0, start - w.before);
  let hi = Math.min(text.length, end + w.after);
  if (w.sameLine) {
    for (let i = start - 1; i >= lo; i -= 1) {
      if (LINE_BREAK.test(text.charAt(i))) {
        lo = i + 1;
        break;
      }
    }
    for (let i = end; i < hi; i += 1) {
      if (LINE_BREAK.test(text.charAt(i))) {
        hi = i;
        break;
      }
    }
  }
  return [lo, hi];
}

/**
 * Matches no money word may veto (security audit run-8), because none is how an amount is written: a phone with its
 * country code, a MY 01X or ID 08XX mobile and an area code in brackets, "(03)" or "(021)" (an amount never starts
 * with 0 or "(0"; P1, 18 Oct), and a full-length card. Other national landlines and bare SG numbers keep the veto.
 * Keyed by entity because data/pii/recognizers.json has no pattern-level veto switch (core's schema is strict).
 */
const NEVER_VETOED: Readonly<Record<string, (match: string) => boolean>> = {
  SG_PHONE: hasCountryCode,
  MY_PHONE: (m) => hasCountryCode(m) || m.startsWith("01") || m.startsWith("(0"),
  ID_PHONE: (m) => hasCountryCode(m) || m.startsWith("08") || m.startsWith("(0"),
  CREDIT_CARD: isStandardLengthCard,
};

/** All that may separate a money word from the number it vetoes: whitespace, a colon, a currency symbol. */
const VETO_GAP = /[\s:\p{Sc}]/u;

/**
 * A hogee_negative_context word vetoes the match at `start` only when it lies inside the negative_before window AND
 * nothing but VETO_GAP separates it from the match ("budget 91234567", "S$ 9123 4567", "total: $4222…"). One further
 * back ("S$12 phone 91234567") does not count. The gap walk is bounded by the window.
 */
function vetoed(text: string, start: number, neg: Ranges, before: number): boolean {
  const from = Math.max(0, start - before);
  let gap = start;
  while (gap > from && VETO_GAP.test(text.charAt(gap - 1))) gap -= 1;
  return neg.endsIn(from, gap, start);
}

function candidatesOf(r: CompiledRecognizer, text: string, lower: () => string, prot: Ranges, cfg: CompiledRecognizers): Candidate[] {
  const out: Candidate[] = [];
  let ctx: Ranges | undefined;
  let neg: Ranges | undefined;
  const w = cfg.window;
  const neverVetoed = NEVER_VETOED[r.entity];
  for (const p of r.patterns) {
    for (const m of text.matchAll(p.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start || prot.contains(start, end)) continue;
      if (p.validator && !p.validator(m[0])) continue;
      if (r.negative && !neverVetoed?.(m[0])) {
        neg ??= Ranges.scan(lower(), [r.negative]);
        if (vetoed(text, start, neg, w.negativeBefore)) continue;
      }
      let hasContext = false;
      if (r.context) {
        ctx ??= Ranges.scan(lower(), [r.context]);
        hasContext = ctx.within(...contextRange(text, start, end, r.window));
      }
      if (p.contextRequired && !hasContext) continue;
      out.push({ type: r.entity, start, end, score: Math.min(1, p.score + (hasContext ? w.boost : 0)), rank: p.rank });
    }
  }
  return out;
}

const better = (a: Candidate, b: Candidate): boolean =>
  a.end - a.start !== b.end - b.start ? a.end - a.start > b.end - b.start : a.score !== b.score ? a.score > b.score : a.rank !== b.rank ? a.rank < b.rank : a.start < b.start;

/** Merge overlapping candidates (already in ORIGINAL offsets) into sorted, non-overlapping spans. */
function resolve(cands: Candidate[]): Span[] {
  cands.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  const spans: Span[] = [];
  let i = 0;
  while (i < cands.length) {
    let best = cands[i] as Candidate;
    const start = best.start;
    let end = best.end;
    i += 1;
    while (i < cands.length && (cands[i] as Candidate).start < end) {
      const c = cands[i] as Candidate;
      end = Math.max(end, c.end);
      if (better(c, best)) best = c;
      i += 1;
    }
    spans.push({ type: best.type, start, end });
  }
  return spans;
}

/** All PII spans in `input`, in ORIGINAL offsets (end exclusive), sorted and non-overlapping. */
export function detect(input: string, cfg: CompiledRecognizers): Span[] {
  const folded = foldText(input);
  const text = folded.text;
  let lowered: string | undefined;
  const lower = () => (lowered ??= lowerAscii(text));
  const prot = Ranges.scan(text, cfg.protected);
  const cands: Candidate[] = [];
  for (const r of cfg.recognizers) {
    for (const c of candidatesOf(r, text, lower, prot, cfg)) {
      const o = folded.toOriginal(c.start, c.end);
      cands.push({ ...c, start: o.start, end: o.end });
    }
  }
  return resolve(cands);
}
