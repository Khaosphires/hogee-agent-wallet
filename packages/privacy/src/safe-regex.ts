/**
 * Static check that a data/pii regex cannot backtrack catastrophically. JavaScript's engine backtracks, so the files
 * only get a subset whose work per start position is bounded by a small constant:
 * - no unbounded quantifier (`*`, `+`, `{n,}`) and no bound above MAX_REPEAT;
 * - a repeated group (bound > 1) has no alternation, and if it holds quantifiers it starts with a punctuation
 *   delimiter (`\.`, `[ -]`) so the way it splits a run of input is forced; nested bounds multiply to ≤ MAX_NESTED;
 * - no backreferences, no inline flags, no quantified lookaround.
 * Combined with the anchoring lookbehinds every pattern starts with, a scan is O(n · bound). The 1 MB adversarial
 * tests in privacy.test.ts check that empirically.
 */

const MAX_SOURCE = 512;
const MAX_REPEAT = 256;
const MAX_NESTED = 1024;

interface Frame {
  hasAlt: boolean;
  /** Largest product of quantifier bounds seen inside this group. */
  inner: number;
  firstAtom: string | null;
  readonly lookaround: boolean;
}

type Last = { readonly kind: "atom" } | { readonly kind: "group"; readonly frame: Frame } | null;

/** A character class or escape made only of literal punctuation/space (no ranges, no \d \w \s). */
function isDelimiterAtom(atom: string | null): boolean {
  if (atom === null) return false;
  if (atom.startsWith("\\")) return /^\\[^A-Za-z0-9]$/.test(atom);
  if (!atom.startsWith("[")) return /^[^A-Za-z0-9\\[(]$/.test(atom);
  const body = atom.slice(1, -1);
  if (body.startsWith("^") || body.length === 0) return false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charAt(i);
    if (c === "\\") {
      if (/[A-Za-z0-9]/.test(body.charAt(i + 1))) return false;
      i += 1;
    } else if (/[A-Za-z0-9]/.test(c) || (c === "-" && i > 0 && i < body.length - 1)) {
      return false;
    }
  }
  return true;
}

/** End index (inclusive) of the character class starting at `i`, or -1. */
function classEnd(source: string, i: number): number {
  let j = i + 1;
  if (source.charAt(j) === "^") j += 1;
  if (source.charAt(j) === "]") j += 1;
  while (j < source.length && source.charAt(j) !== "]") j += source.charAt(j) === "\\" ? 2 : 1;
  return j < source.length ? j : -1;
}

const GROUP_OPENERS: readonly { readonly prefix: string; readonly lookaround: boolean }[] = [
  { prefix: "(?:", lookaround: false },
  { prefix: "(?=", lookaround: true },
  { prefix: "(?!", lookaround: true },
  { prefix: "(?<=", lookaround: true },
  { prefix: "(?<!", lookaround: true },
];

/** Returns null if `source` is in the linear-time subset, else a short reason. */
export function linearRegexProblem(source: string): string | null {
  if (source.length > MAX_SOURCE) return `longer than ${MAX_SOURCE} characters`;
  const stack: Frame[] = [{ hasAlt: false, inner: 1, firstAtom: null, lookaround: false }];
  let last: Last = null;
  let i = 0;
  const top = (): Frame => stack[stack.length - 1] as Frame;
  const atom = (text: string, next: number) => {
    top().firstAtom ??= text;
    last = { kind: "atom" };
    i = next;
  };
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === "\\") {
      const n = source.charAt(i + 1);
      if (n === "") return "dangling escape";
      if (/[1-9k]/.test(n)) return "backreferences are not allowed";
      atom(source.slice(i, i + 2), i + 2);
    } else if (c === "[") {
      const end = classEnd(source, i);
      if (end < 0) return "unterminated character class";
      atom(source.slice(i, end + 1), end + 1);
    } else if (c === "(") {
      const opener = GROUP_OPENERS.find((g) => source.startsWith(g.prefix, i));
      if (!opener && source.charAt(i + 1) === "?") return "inline flags and named groups are not allowed";
      top().firstAtom ??= "(";
      stack.push({ hasAlt: false, inner: 1, firstAtom: null, lookaround: opener?.lookaround ?? false });
      last = null;
      i += opener ? opener.prefix.length : 1;
    } else if (c === ")") {
      if (stack.length === 1) return "unbalanced parentheses";
      last = { kind: "group", frame: stack.pop() as Frame };
      i += 1;
    } else if (c === "|") {
      top().hasAlt = true;
      last = null;
      i += 1;
    } else if (c === "*" || c === "+") {
      return "unbounded quantifier";
    } else if (c === "?" || c === "{") {
      const m = c === "?" ? null : /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(source.slice(i));
      if (c === "{" && !m) return "a literal { must be escaped";
      if (m && m[2] !== undefined && m[3] === "") return "unbounded quantifier";
      const max = m ? Number(m[3] ?? m[1]) : 1;
      if (last === null) return "quantifier without an atom";
      if (max > MAX_REPEAT) return `quantifier bound above ${MAX_REPEAT}`;
      let product = max;
      const quantified: Last = last;
      if (quantified.kind === "group") {
        const g = quantified.frame;
        if (g.lookaround) return "quantified lookaround";
        if (max > 1 && g.hasAlt) return "alternation inside a repeated group";
        if (max > 1 && g.inner > 1 && !isDelimiterAtom(g.firstAtom)) return "a repeated group with inner quantifiers must start with a punctuation delimiter";
        product = max * g.inner;
      }
      if (product > MAX_NESTED) return `nested quantifier bounds above ${MAX_NESTED}`;
      top().inner = Math.max(top().inner, product);
      last = null;
      i += m ? m[0].length : 1;
      if (source.charAt(i) === "?") i += 1;
    } else {
      atom(c, i + 1);
    }
  }
  return stack.length === 1 ? null : "unbalanced parentheses";
}
