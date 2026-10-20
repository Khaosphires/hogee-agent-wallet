// Security audit run-8 (sanctions.ts:nameTokens:no-confusable-or-invisible-letter-fold): a UN-listed name spelled
// with Cyrillic or Greek look-alikes, invisible Hangul fillers or other default-ignorable code points must still hit,
// on the query side and on the list side alike, without new false positives.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { CheckInputError, nameKeys, screenSanctions } from "../src/index";
import { REPO } from "./helpers";

const LIST = join(REPO, "data", "sanctions", "un_sc.csv");
const LISTED = "KOREA MINING DEVELOPMENT TRADING CORPORATION";
const HIT = { hit: true, list: "UN_SC", matchedName: LISTED };
const HEADER = "name,aliases,listId,listedOn\n";

/** Each listed ASCII letter replaced through `map` (letters without an entry stay Latin). */
const swap = (text: string, map: Readonly<Record<string, string>>): string => Array.from(text, (ch) => map[ch] ?? ch).join("");

const CYRILLIC_CAPS = { A: "А", B: "В", C: "С", E: "Е", H: "Н", I: "І", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
const CYRILLIC_SMALL = { a: "а", c: "с", e: "е", i: "і", j: "ј", o: "о", p: "р", s: "ѕ", x: "х", y: "у", d: "ԁ" };
const GREEK_CAPS = { A: "Α", B: "Β", E: "Ε", H: "Η", I: "Ι", K: "Κ", M: "Μ", N: "Ν", O: "Ο", P: "Ρ", T: "Τ", X: "Χ", Y: "Υ", Z: "Ζ" };
const fullWidth = (text: string): string => Array.from(text, (ch) => (ch >= "!" && ch <= "~" ? String.fromCodePoint(ch.codePointAt(0)! + 0xfee0) : ch)).join("");
const HANGUL_FILLERS = ["ㅤ", "ﾠ", "ᅟ", "ᅠ"];

function tempList(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "hogee-sanctions-")), "un_sc.csv");
  writeFileSync(path, content);
  return path;
}

describe("screenSanctions: look-alike and invisible letters in a listed name", () => {
  it("(a) hits with Cyrillic look-alike capitals", async () => {
    const name = swap(LISTED, CYRILLIC_CAPS);
    expect(name).not.toMatch(/[A-Z]{3}/);
    await expect(screenSanctions(name, { csvPath: LIST })).resolves.toEqual(HIT);
    await expect(screenSanctions(LISTED.replace("CORPORATION", "CОRPORATION"), { csvPath: LIST })).resolves.toEqual(HIT);
  });

  it("(a) hits with Cyrillic look-alike small letters in a mixed-case spelling", async () => {
    const name = swap("Korea Mining Development Trading Corporation", CYRILLIC_SMALL);
    expect(name).not.toBe("Korea Mining Development Trading Corporation");
    await expect(screenSanctions(name, { csvPath: LIST })).resolves.toEqual(HIT);
  });

  it("(a) hits with Greek look-alike capitals, including those whose small letter looks different (Η, Μ, Ν)", async () => {
    await expect(screenSanctions(swap(LISTED, GREEK_CAPS), { csvPath: LIST })).resolves.toEqual(HIT);
    await expect(screenSanctions("CΗANGGWANG SINYONG CORPORATION", { csvPath: LIST })).resolves.toEqual({
      hit: true,
      list: "UN_SC",
      matchedName: "CHANGGWANG SINYONG CORPORATION",
    });
  });

  it.each(HANGUL_FILLERS.map((f) => [`U+${f.codePointAt(0)!.toString(16).toUpperCase()}`, f]))("(b) hits with the Hangul filler %s inside a word", async (_label, filler) => {
    await expect(screenSanctions(LISTED.replace("CORPORATION", `CORPO${filler}RATION`), { csvPath: LIST })).resolves.toEqual(HIT);
    await expect(screenSanctions(LISTED.replace("KOREA", `K${filler}OREA`).replace("MINING", `MIN${filler}${filler}ING`), { csvPath: LIST })).resolves.toEqual(HIT);
  });

  it("(c) hits with full-width letters", async () => {
    await expect(screenSanctions(fullWidth(LISTED), { csvPath: LIST })).resolves.toEqual(HIT);
  });

  it.each([
    ["zero-width joiner", "‍"],
    ["zero-width non-joiner", "‌"],
    ["word joiner", "⁠"],
    ["variation selector 16", "️"],
    ["variation selector 17", "\u{E0100}"],
    ["combining grapheme joiner", "͏"],
    ["Mongolian free variation selector", "᠋"],
  ])("(d) hits with a %s inside every word", async (_label, invisible) => {
    const name = LISTED.split(" ").map((w) => `${w.slice(0, 2)}${invisible}${w.slice(2)}`).join(" ");
    await expect(screenSanctions(name, { csvPath: LIST })).resolves.toEqual(HIT);
  });

  it("(e) hits with every trick at once, in another word order and case", async () => {
    const name = [
      swap("Trading", CYRILLIC_SMALL),
      `${swap("KO", GREEK_CAPS)}ㅤR‍EA`,
      fullWidth("Mining"),
      `Dévélоpmеnt️`,
      `СΟRPﾠORАTIОN`,
    ].join("  ");
    await expect(screenSanctions(name, { csvPath: LIST })).resolves.toEqual(HIT);
  });

  it("refuses a name made only of invisible letters instead of screening it as clean", async () => {
    await expect(screenSanctions("ㅤㅤ ﾠ", { csvPath: LIST })).rejects.toBeInstanceOf(CheckInputError);
    await expect(screenSanctions("ᅟ‍️", { csvPath: LIST })).rejects.toBeInstanceOf(CheckInputError);
  });
});

describe("screenSanctions: the fold is symmetric (list side and query side)", () => {
  it("hits a listed name written with look-alikes and fillers from its plain Latin spelling, and back", async () => {
    const csvPath = tempList(`${HEADER}${swap("ACME EXPORT", CYRILLIC_CAPS)} COㅤMPANY,${swap("Kappa", GREEK_CAPS)} Trаding,XXe.001,\n`);
    await expect(screenSanctions("Acme Export Company", { csvPath })).resolves.toMatchObject({ hit: true });
    await expect(screenSanctions("KAPPA TRADING", { csvPath })).resolves.toMatchObject({ hit: true });
    await expect(screenSanctions(swap("ACME EXPORT COMPANY", GREEK_CAPS), { csvPath })).resolves.toMatchObject({ hit: true });
  });

  it("keeps original-script names case-insensitive (Cyrillic П/п, Ь/ь; Greek Η/η, Μ/μ, Ν/ν)", async () => {
    const csvPath = tempList(`${HEADER}PETROV,Попов Игорь;Μανης Νικου,XXi.001,\n`);
    await expect(screenSanctions("ПОПОВ ИГОРЬ", { csvPath })).resolves.toMatchObject({ hit: true });
    await expect(screenSanctions("попов игорь", { csvPath })).resolves.toMatchObject({ hit: true });
    await expect(screenSanctions("ΜΑΝΗΣ ΝΙΚΟΥ", { csvPath })).resolves.toMatchObject({ hit: true });
    await expect(screenSanctions("μανης νικου", { csvPath })).resolves.toMatchObject({ hit: true });
    // Upper case plus Latin O and B for Cyrillic О and В: П must fold like п (n) for the skeletons to meet.
    await expect(screenSanctions("ПOПOB ИГOPЬ", { csvPath })).resolves.toMatchObject({ hit: true });
  });

  it("still hits the list's Cyrillic original-script aliases in either case", async () => {
    const alias = "Умаров Доку Хаматович";
    await expect(screenSanctions(alias, { csvPath: LIST })).resolves.toMatchObject({ hit: true, matchedName: alias });
    await expect(screenSanctions(alias.toUpperCase(), { csvPath: LIST })).resolves.toMatchObject({ hit: true, matchedName: alias });
  });
});

describe("screenSanctions: no new false positives", () => {
  const demoDir = join(REPO, "data", "suppliers", "demo");
  const demo = readdirSync(demoDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => (JSON.parse(readFileSync(join(demoDir, f), "utf8")) as { supplier: { supplierId: string; displayName: string } }).supplier);

  it("hits only the demo supplier that carries the listed name", async () => {
    expect(demo.length).toBeGreaterThanOrEqual(9);
    const hits = [];
    for (const s of demo) if ((await screenSanctions(s.displayName, { csvPath: LIST })).hit) hits.push(s.supplierId);
    expect(hits).toEqual(["supplier-f"]);
  });

  it.each([
    "Example Drinkware Supplies Pte. Ltd.",
    "Mei Tan Trading",
    "Korea Mining Development Trading Company",
    "Kopea Mining Development Trading Corporation",
    "Hong Kong Vacuum Cup Co., Ltd.",
    "Nong Fu Spring",
    "ООО Ромашка",
    "Иванов Иван Иванович",
    "Αθηναϊκή Ζυθοποιία",
    "浙江永康保温杯有限公司",
    "한국무역 주식회사",
    "Syarikat Perniagaan Rina Sdn. Bhd.",
  ])("does not hit %s", async (name) => {
    await expect(screenSanctions(name, { csvPath: LIST })).resolves.toEqual({ hit: false, list: null, matchedName: null });
  });
});

describe("nameKeys", () => {
  it("gives a plain Latin name the same two keys as before", () => {
    expect(nameKeys("Korea Mining")).toEqual(["w:korea mining", "c:koreamining"]);
  });

  it("normalises 100 KB of adversarial input in linear time", () => {
    const unit = `${swap("Korea", CYRILLIC_SMALL)}ㅤ${fullWidth("MINING")}‍️́${swap("CORP", GREEK_CAPS)}ᅟ, `;
    const input = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
    const started = performance.now();
    const keys = nameKeys(input);
    const elapsed = performance.now() - started;
    expect(keys.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1_000);
  });
});
