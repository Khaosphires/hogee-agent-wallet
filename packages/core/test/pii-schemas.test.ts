/**
 * data/pii/recognizers.json and data/pii/canary-patterns.json (docs/decisions/privacy.md §4): core holds their schemas so
 * validate:data and gen:schemas cover them. The files as committed must parse unchanged; bad ones must not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PII_VALIDATOR_NAMES, PiiCanaryFile, PiiRecognizersFile } from "../src/index";
import { REPO_ROOT } from "../scripts/lib/paths";

const load = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(REPO_ROOT, "data", "pii", name), "utf8")) as Record<string, unknown>;
const recognizers = load("recognizers.json") as { recognizers: { name: string; patterns: { name: string; regex: string }[] }[] };
const canary = load("canary-patterns.json") as { patterns: { name: string; regex: string; validator?: string }[] };
const issuePaths = (r: { error?: { issues: { path: PropertyKey[] }[] } }) => r.error?.issues.map((i) => i.path.join(".")) ?? [];

describe("PII config file schemas", () => {
  it("accept the committed files exactly as they are", () => {
    expect(PiiRecognizersFile.safeParse(recognizers).success).toBe(true);
    expect(PiiCanaryFile.safeParse(canary).success).toBe(true);
  });

  it("name every validator the files use", () => {
    const used = [
      ...recognizers.recognizers.flatMap((r) => [(r as { hogee_validator?: string }).hogee_validator, ...r.patterns.map((p) => (p as { hogee_validator?: string }).hogee_validator)]),
      ...canary.patterns.map((p) => p.validator),
    ].filter((v): v is string => v !== undefined);
    expect(used.length).toBeGreaterThan(0);
    for (const v of used) expect(PII_VALIDATOR_NAMES).toContain(v);
  });

  it("refuse an unknown validator, a regex that does not compile, a duplicate name, an extra key and another version", () => {
    const [r0, r1] = recognizers.recognizers;
    const p0 = r0?.patterns[0];
    const badValidator = { ...canary, patterns: [{ ...canary.patterns[0], validator: "SG_UEN" }] };
    expect(issuePaths(PiiCanaryFile.safeParse(badValidator))).toEqual(["patterns.0.validator"]);
    const badRegex = { ...recognizers, recognizers: [{ ...r0, patterns: [{ ...p0, regex: "(\\d{3}" }] }] };
    expect(issuePaths(PiiRecognizersFile.safeParse(badRegex))).toEqual(["recognizers.0.patterns.0.regex"]);
    const dupRecognizer = { ...recognizers, recognizers: [r0, { ...r1, name: r0?.name }] };
    expect(issuePaths(PiiRecognizersFile.safeParse(dupRecognizer))).toEqual(["recognizers.1.name"]);
    const dupPattern = { ...canary, patterns: [canary.patterns[0], { ...canary.patterns[1], name: canary.patterns[0]?.name }] };
    expect(issuePaths(PiiCanaryFile.safeParse(dupPattern))).toEqual(["patterns.1.name"]);
    expect(PiiCanaryFile.safeParse({ ...canary, extra: true }).success).toBe(false);
    expect(PiiRecognizersFile.safeParse({ ...recognizers, version: 2 }).success).toBe(false);
  });
});
