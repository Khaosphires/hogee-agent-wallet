import { describe, expect, it } from "vitest";
import canaryJson from "../../../data/pii/canary-patterns.json" with { type: "json" };
import recognizersJson from "../../../data/pii/recognizers.json" with { type: "json" };
import { PiiCanaryFile, PiiRecognizersFile, PrivacyConfigError, assertNoIds, compileCanary, compileRecognizers, linearRegexProblem, redact } from "../src/index";

const MB = 1_000_000;
const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);

describe("linear time (no catastrophic backtracking)", () => {
  const adversarial: Record<string, string> = {
    "digit run": fill("1"),
    "digits and spaces": fill("1 "),
    "digits and hyphens": fill("12-"),
    "almost +65 phones": fill("+65 9123 456"),
    "almost MY phones": fill("0123 4567 "),
    "e-mail local part": fill("a."),
    "at signs": fill("a@"),
    "endless domain": `x@${fill("a.").slice(2)}`,
    "almost NRIC": fill("S1234567"),
    "almost hex": `0x${fill("f1").slice(2)}`,
    "context words": fill("call phone tel 9123 4567 "),
    "money words before phones and cards": fill("call budget S$ : $ 9123 4567 fee +65 9123 4567 RM 4111 1111 1111 1111 "),
    "account groups": fill("account 1234 5678 9012 3456 7890 "),
    "full-width digits": fill("９"),
    "zero-width splits": fill("9\u200b"),
    "JSON escapes": fill("\\n9"),
    "valid IDs everywhere": fill("900101-14-5678 "),
  };

  for (const [name, text] of Object.entries(adversarial)) {
    it(`a 1 MB "${name}" string is redacted and canary-checked in under 1 s each`, async () => {
      let t0 = performance.now();
      await redact(text);
      expect(performance.now() - t0).toBeLessThan(1000);
      t0 = performance.now();
      try {
        assertNoIds(text);
      } catch {
        // a hit is fine; only the time matters here
      }
      expect(performance.now() - t0).toBeLessThan(1000);
    });
  }

  it("every regex in data/pii passes the static linear-time check", () => {
    const sources = [
      ...recognizersJson.protected.map((p) => p.regex),
      ...recognizersJson.recognizers.flatMap((r) => r.patterns.map((p) => p.regex)),
      ...canaryJson.patterns.map((p) => p.regex),
    ];
    expect(sources.length).toBeGreaterThan(20);
    for (const s of sources) expect(linearRegexProblem(s), s).toBeNull();
  });

  it("the static check rejects patterns that can backtrack catastrophically", () => {
    for (const bad of [
      String.raw`\d+`,
      "a*",
      String.raw`\d{2,}`,
      String.raw`(?:a|ab){1,20}`,
      String.raw`(?:\d{1,9}){1,9}`,
      String.raw`(a)\1`,
      "(?i)abc",
      String.raw`(?=a){2}`,
      String.raw`[a-z]{1,300}`,
      "{",
      String.raw`(?:[ -]\d{1,63}){1,63}`,
    ]) {
      expect(linearRegexProblem(bad), bad).not.toBeNull();
    }
    for (const good of [String.raw`\d{6}[- ]\d{2}`, String.raw`(?:\.[a-z]{1,63}){1,8}`, String.raw`(?:\+65|0065)?[ -]?\d{4}`, String.raw`(?:[ -]\d{1,8}){0,2}`]) {
      expect(linearRegexProblem(good), good).toBeNull();
    }
  });
});

describe("data/pii files", () => {
  it("validate against the privacy schemas", () => {
    expect(PiiRecognizersFile.safeParse(recognizersJson).success).toBe(true);
    expect(PiiCanaryFile.safeParse(canaryJson).success).toBe(true);
  });

  it("cover every frozen and Singapore entity, plus e-mail and cards", () => {
    const entities = new Set(recognizersJson.recognizers.map((r) => r.supported_entity));
    for (const e of ["MY_NRIC", "ID_NIK", "ID_NPWP", "MY_BANK_ACCOUNT", "MY_PHONE", "ID_PHONE", "SG_NRIC", "SG_PHONE", "EMAIL_ADDRESS", "CREDIT_CARD"]) expect(entities).toContain(e);
  });

  it("every canary pattern is also a context-free recognizer pattern with the same validator (so redact() output never trips it)", () => {
    for (const c of canaryJson.patterns) {
      const twin = recognizersJson.recognizers.flatMap((r) =>
        r.patterns
          .filter((p) => p.regex === c.regex)
          .map((p) => ({ entity: r.supported_entity, validator: ("hogee_validator" in p ? p.hogee_validator : undefined) ?? ("hogee_validator" in r ? r.hogee_validator : undefined), contextRequired: "hogee_context_required" in p && p.hogee_context_required === true, negative: "hogee_negative_context" in r })),
      );
      expect(twin, c.name).toHaveLength(1);
      expect(twin[0], c.name).toEqual({ entity: c.entity, validator: "validator" in c ? c.validator : undefined, contextRequired: false, negative: false });
    }
    expect(canaryJson.protected).toEqual(recognizersJson.protected);
  });
});

describe("a bad configuration fails closed", () => {
  const withPattern = (regex: string, extra: Record<string, unknown> = {}) => ({
    ...recognizersJson,
    recognizers: [{ name: "X", supported_language: "en", supported_entity: "MY_NRIC", patterns: [{ name: "x", regex, score: 0.5, ...extra }], context: [] }],
  });

  it("an unbounded or invalid regex, an unknown validator or a malformed file throws PrivacyConfigError", () => {
    expect(() => compileRecognizers(withPattern(String.raw`\d+`))).toThrow(PrivacyConfigError);
    expect(() => compileRecognizers(withPattern("(?<!a"))).toThrow(PrivacyConfigError);
    expect(() => compileRecognizers(withPattern(String.raw`\d{12}`, { hogee_validator: "NO_SUCH_CHECK" }))).toThrow(PrivacyConfigError);
    expect(() => compileRecognizers({ ...recognizersJson, version: 2 })).toThrow(PrivacyConfigError);
    expect(() => compileRecognizers(null)).toThrow(PrivacyConfigError);
    expect(() => compileCanary({ ...canaryJson, patterns: [{ name: "x", entity: "MY_NRIC", regex: ".*" }] })).toThrow(PrivacyConfigError);
    expect(() => compileCanary({ ...canaryJson, extra: true })).toThrow(PrivacyConfigError);
  });

  // Security audit run-8 hunter note: such a pattern used to compile and then silently never fire.
  it("hogee_context_required on a recognizer with no context words throws, naming the pattern", () => {
    expect(() => compileRecognizers(withPattern(String.raw`\d{12}`, { hogee_context_required: true }))).toThrow(PrivacyConfigError);
    expect(() => compileRecognizers(withPattern(String.raw`\d{12}`, { hogee_context_required: true }))).toThrow(/X \/ x/);
    expect(() => compileRecognizers(withPattern(String.raw`\d{12}`, { hogee_context_required: false }))).not.toThrow();
    expect(() => compileRecognizers(withPattern(String.raw`\d{12}`))).not.toThrow();
  });

  it("the bundled files compile", () => {
    expect(compileRecognizers(recognizersJson).recognizers.length).toBe(recognizersJson.recognizers.length);
    expect(compileCanary(canaryJson).patterns.length).toBe(canaryJson.patterns.length);
  });
});

describe("redact() output never trips the canary (seeded fuzz)", () => {
  const IDS = ["900101-14-5678", "900101145678", "880229 10 1234", "3171010101900001", "317101 010190 0001", "01.234.567.4-901.000", "S1234567D", "t1234567j", "F1234567N", "M1234567K", "９００１０１－１４－５６７８"];
  const NOISE = ["", " ", "-", ".", ",", "\n", "IC ", "NIK ", "NRIC ", "Company No. ", "SSM ", "RM ", "account ", "call ", "x", "0x", "01a14202-2800-7000-8000-", "\"", "\\", "\u200b", "(", "): "];
  let seed = 20261020;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = <T>(xs: readonly T[]): T => xs[next(xs.length)] as T;

  it("for 2,000 generated texts, assertNoIds(JSON.stringify(redact(text))) passes", async () => {
    for (let i = 0; i < 2000; i += 1) {
      const parts: string[] = [];
      const n = 1 + next(6);
      for (let k = 0; k < n; k += 1) parts.push(pick(NOISE), next(3) === 0 ? pick(IDS) : String(next(1e9)), pick(NOISE));
      const text = parts.join("");
      const r = await redact(text);
      expect(() => assertNoIds(JSON.stringify({ prompt: [{ role: "user", content: r.text }] })), text).not.toThrow();
    }
    expect(() => assertNoIds(`IC ${pick(IDS)} ok`)).toThrow();
  });
});
