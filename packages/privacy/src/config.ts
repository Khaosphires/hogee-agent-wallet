/**
 * data/pii/recognizers.json and data/pii/canary-patterns.json: zod schemas, and compilation into RegExps. The files are
 * bundled as JSON imports (no runtime file system or cwd lookup), validated on first use and cached. A bad file
 * throws PrivacyConfigError on every call, so redaction fails closed instead of running with fewer recognizers.
 */
import { z } from "zod";
import canaryJson from "../../../data/pii/canary-patterns.json" with { type: "json" };
import recognizersJson from "../../../data/pii/recognizers.json" with { type: "json" };
import { PrivacyConfigError } from "./errors";
import { linearRegexProblem } from "./safe-regex";
import { VALIDATOR_NAMES, VALIDATORS, type ValidatorName } from "./validators";

const Comment = z.union([z.string(), z.array(z.string())]).optional();
const Name = z.string().min(1).max(80);
const Regex = z.string().min(1).max(512);
const EntityName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/);
const Word = z.string().min(1).max(40).refine((w) => w === w.toLowerCase() && w === w.trim(), "lower case, no outer spaces");
const Validator = z.enum(VALIDATOR_NAMES);
const Int = (max: number) => z.number().int().min(0).max(max);

const Protected = z.strictObject({ name: Name, regex: Regex });

export const PiiRecognizersFile = z.strictObject({
  $comment: Comment,
  version: z.literal(1),
  context_window: z.strictObject({ before: Int(256), after: Int(256), negative_before: Int(64), boost: z.number().min(0).max(1) }),
  protected: z.array(Protected).max(16),
  recognizers: z
    .array(
      z.strictObject({
        name: Name,
        supported_language: z.literal("en"),
        supported_entity: EntityName,
        patterns: z
          .array(
            z.strictObject({
              name: Name,
              regex: Regex,
              score: z.number().min(0).max(1),
              hogee_context_required: z.boolean().optional(),
              hogee_validator: Validator.optional(),
            }),
          )
          .min(1)
          .max(8),
        context: z.array(Word).max(48),
        hogee_validator: Validator.optional(),
        hogee_negative_context: z.array(Word).max(48).optional(),
        hogee_context_window: z.strictObject({ before: Int(256), after: Int(256), same_line: z.boolean() }).optional(),
      }),
    )
    .min(1)
    .max(32),
});
export type PiiRecognizersFile = z.infer<typeof PiiRecognizersFile>;

export const PiiCanaryFile = z.strictObject({
  $comment: Comment,
  version: z.literal(1),
  protected: z.array(Protected).max(16),
  patterns: z.array(z.strictObject({ name: Name, entity: EntityName, regex: Regex, validator: Validator.optional() })).min(1).max(32),
});
export type PiiCanaryFile = z.infer<typeof PiiCanaryFile>;

type Check = (text: string) => boolean;

export interface CompiledPattern {
  readonly re: RegExp;
  readonly score: number;
  readonly contextRequired: boolean;
  readonly validator: Check | null;
  /** Tie-break order: file order of recognizer, then pattern. */
  readonly rank: number;
}

/** Where a context word must lie: [start - before, end + after), cut at line breaks when sameLine. */
export interface ContextWindow {
  readonly before: number;
  readonly after: number;
  readonly sameLine: boolean;
}

export interface CompiledRecognizer {
  readonly entity: string;
  readonly patterns: readonly CompiledPattern[];
  readonly context: RegExp | null;
  readonly negative: RegExp | null;
  readonly window: ContextWindow;
}

export interface CompiledRecognizers {
  readonly window: { readonly negativeBefore: number; readonly boost: number };
  readonly protected: readonly RegExp[];
  readonly recognizers: readonly CompiledRecognizer[];
}

export interface CompiledCanary {
  readonly protected: readonly RegExp[];
  readonly patterns: readonly { readonly entity: string; readonly re: RegExp; readonly validator: Check | null }[];
}

function compileRegex(where: string, source: string): RegExp {
  const problem = linearRegexProblem(source);
  if (problem) throw new PrivacyConfigError(`${where}: ${problem}`);
  try {
    return new RegExp(source, "g");
  } catch (cause) {
    throw new PrivacyConfigError(`${where}: not a valid regular expression`, { cause });
  }
}

const escapeWord = (w: string) => w.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * One scan regex for a word list. No letter or digit may come before a word; a word ending in a letter or digit must
 * also end there ("bu" is not inside "Buddy", "cap" not inside "Capital"), while one ending in a symbol ("$", "s$")
 * may run straight into digits ("$4111…").
 */
function wordRegex(words: readonly string[] | undefined): RegExp | null {
  if (!words || words.length === 0) return null;
  const alts = [...words].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map((w) => `${escapeWord(w)}${/[a-z0-9]$/.test(w) ? "(?![a-z0-9])" : ""}`);
  return new RegExp(`(?<![a-z0-9])(?:${alts.join("|")})`, "g");
}

const validatorFor = (name: ValidatorName | undefined): Check | null => (name ? VALIDATORS[name] : null);

function parse<T>(schema: z.ZodType<T>, file: string, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new PrivacyConfigError(`${file}: ${first ? `${first.path.join(".") || "(root)"}: ${first.message}` : "invalid"}`);
}

/** A pattern that needs a context word on a recognizer without any would silently never fire: refuse the file. */
function checkContextRequired(r: PiiRecognizersFile["recognizers"][number]): void {
  if (r.context.length > 0) return;
  const p = r.patterns.find((x) => x.hogee_context_required === true);
  if (p) throw new PrivacyConfigError(`${r.name} / ${p.name}: hogee_context_required needs a non-empty context list`);
}

export function compileRecognizers(raw: unknown): CompiledRecognizers {
  const file = parse(PiiRecognizersFile, "recognizers.json", raw);
  const w = file.context_window;
  file.recognizers.forEach(checkContextRequired);
  return {
    window: { negativeBefore: w.negative_before, boost: w.boost },
    protected: file.protected.map((p) => compileRegex(`protected ${p.name}`, p.regex)),
    recognizers: file.recognizers.map((r, ri) => ({
      entity: r.supported_entity,
      context: wordRegex(r.context),
      negative: wordRegex(r.hogee_negative_context),
      window: r.hogee_context_window
        ? { before: r.hogee_context_window.before, after: r.hogee_context_window.after, sameLine: r.hogee_context_window.same_line }
        : { before: w.before, after: w.after, sameLine: false },
      patterns: r.patterns.map((p, pi) => ({
        re: compileRegex(`${r.name} / ${p.name}`, p.regex),
        score: p.score,
        contextRequired: p.hogee_context_required ?? false,
        validator: validatorFor(p.hogee_validator ?? r.hogee_validator),
        rank: ri * 16 + pi,
      })),
    })),
  };
}

export function compileCanary(raw: unknown): CompiledCanary {
  const file = parse(PiiCanaryFile, "canary-patterns.json", raw);
  return {
    protected: file.protected.map((p) => compileRegex(`protected ${p.name}`, p.regex)),
    patterns: file.patterns.map((p) => ({ entity: p.entity, re: compileRegex(`canary ${p.name}`, p.regex), validator: validatorFor(p.validator) })),
  };
}

let recognizers: CompiledRecognizers | undefined;
let canary: CompiledCanary | undefined;

/** The bundled recognizers, compiled on first use (a failure is not cached: every call throws until fixed). */
export function loadRecognizers(): CompiledRecognizers {
  recognizers ??= compileRecognizers(recognizersJson);
  return recognizers;
}

export function loadCanary(): CompiledCanary {
  canary ??= compileCanary(canaryJson);
  return canary;
}
