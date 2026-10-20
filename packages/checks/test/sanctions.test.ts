import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hasScreenableText } from "@hogee/core";
import { CheckInputError, CheckUnavailableError, defaultSanctionsPath, nameKeys, screenSanctions } from "../src/index";
import { buildIndex } from "../src/sanctions";
import { REPO } from "./helpers";

const LIST = join(REPO, "data", "sanctions", "un_sc.csv");
const HEADER = "name,aliases,listId,listedOn\n";

function tempList(content: string | Uint8Array): string {
  const path = join(mkdtempSync(join(tmpdir(), "hogee-sanctions-")), "un_sc.csv");
  writeFileSync(path, content);
  return path;
}

describe("screenSanctions on data/sanctions/un_sc.csv", () => {
  it("finds an alias, ignoring case and punctuation", async () => {
    const hit = { hit: true, list: "UN_SC", matchedName: "Allied Democratic Forces" };
    await expect(screenSanctions("Allied Democratic Forces", { csvPath: LIST })).resolves.toEqual(hit);
    await expect(screenSanctions("  allied, democratic   FORCES! ", { csvPath: LIST })).resolves.toEqual(hit);
  });

  it("ignores diacritics and apostrophe styles", async () => {
    const r = await screenSanctions("Forces Democratiques Alliees-Armee Nationale de Liberation de l'Ouganda", { csvPath: LIST });
    expect(r).toEqual({ hit: true, list: "UN_SC", matchedName: "Forces Démocratiques Alliées-Armée Nationale de Libération de l’Ouganda" });
  });

  it("ignores word order", async () => {
    await expect(screenSanctions("Badege, Eric", { csvPath: LIST })).resolves.toEqual({ hit: true, list: "UN_SC", matchedName: "ERIC BADEGE" });
  });

  it("matches names run together or hyphenated", async () => {
    await expect(screenSanctions("AlQaida", { csvPath: LIST })).resolves.toMatchObject({ hit: true, matchedName: "AL-QAIDA" });
  });

  it("matches each part of a listed name that combines two names with ';'", async () => {
    await expect(screenSanctions("Great Lakes Business Company (GLBC)", { csvPath: LIST })).resolves.toMatchObject({
      hit: true,
      matchedName: "GREAT LAKES BUSINESS COMPANY (GLBC)",
    });
  });

  it("reports no hit with null list and matched name", async () => {
    await expect(screenSanctions("Example Drinkware Supplies Pte. Ltd.", { csvPath: LIST })).resolves.toEqual({ hit: false, list: null, matchedName: null });
  });

  it("does not match a listed name inside a longer name (exact normalised match only)", async () => {
    await expect(screenSanctions("Allied Democratic Forces Catering", { csvPath: LIST })).resolves.toMatchObject({ hit: false });
  });

  it("refuses names it cannot screen", async () => {
    await expect(screenSanctions("", { csvPath: LIST })).rejects.toBeInstanceOf(CheckInputError);
    await expect(screenSanctions("!!! ---", { csvPath: LIST })).rejects.toBeInstanceOf(CheckInputError);
    await expect(screenSanctions("x".repeat(301), { csvPath: LIST })).rejects.toBeInstanceOf(CheckInputError);
  });
});

describe("screenSanctions fails closed when the list cannot be read", () => {
  it.each([
    ["missing", join(tmpdir(), "hogee-no-such-dir", "un_sc.csv")],
    ["empty", tempList("")],
    ["header only", tempList(HEADER)],
    ["a different header", tempList("name,aliases\nA,\n")],
    ["a short row", tempList(`${HEADER}A,,X1\n`)],
    ["a bad date", tempList(`${HEADER}A,,X1,2020-13-01\n`)],
    ["an unterminated quote", tempList(`${HEADER}"A,,X1,\n`)],
    ["invalid UTF-8", tempList(Buffer.concat([Buffer.from(`${HEADER}A`), Buffer.from([0xff]), Buffer.from(",,X1,\n")]))],
  ])("%s list", async (_label, csvPath) => {
    await expect(screenSanctions("Anything Ltd", { csvPath })).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  it("reads quoted fields and a BOM", () => {
    const index = buildIndex(`\uFEFF${HEADER}"Smith, ""Red"" Co",Red Co;Rouge SARL,X1,\n`);
    expect([...index.values()]).toEqual(expect.arrayContaining(['Smith, "Red" Co', "Red Co", "Rouge SARL"]));
  });
});

describe("defaultSanctionsPath", () => {
  it("uses HOGEE_DATA_DIR when set", () => {
    expect(defaultSanctionsPath({ HOGEE_DATA_DIR: "/srv/hogee-data" }, "/")).toBe(join("/srv/hogee-data", "sanctions", "un_sc.csv"));
  });

  it("finds the repo's data directory from inside the repo", () => {
    expect(defaultSanctionsPath({}, join(REPO, "packages", "checks"))).toBe(LIST);
  });

  it("throws when no data directory is found", () => {
    expect(() => defaultSanctionsPath({}, "/")).toThrow(CheckUnavailableError);
  });
});

describe("nameKeys", () => {
  it("folds case, diacritics, special letters and punctuation", () => {
    expect(nameKeys("Ørsted–Müller & Søn")).toEqual(nameKeys("orsted muller son"));
    expect(nameKeys("Straße")).toEqual(nameKeys("STRASSE"));
    expect(nameKeys("Abd al-Ra\u1E25m\u0101n \u02BFAl\u012B")).toEqual(nameKeys("Abd al-Rahman Ali"));
    expect(nameKeys("Ka\u00ADlashnikov")).toEqual(nameKeys("Kalashnikov"));
    expect(nameKeys("\u0645\u0640\u062D\u0645\u062F")).toEqual(nameKeys("\u0645\u062D\u0645\u062F"));
  });

  /**
   * Audit run-9 lead 1: core's isSellerName (web search) must accept only names this screen can screen, so one listing
   * never reaches screenSanctions with nothing to screen. core hasScreenableText is its twin of `nameKeys(n).length > 0`
   * (core cannot import checks); this keeps the two equal over every code point the screen drops and their neighbours.
   */
  it("agrees with core hasScreenableText on what has letters or digits to screen", async () => {
    const odd = ["\u02B9", "\u02BA", "\u02BB", "\u02BC", "\u02BD", "\u02BE", "\u02BF", "\u02C8", "\u02C0", "\u02C1", "\u02C9", "\u0640", "\u115F", "\u1160", "\u3164", "\uFFA0", "\u200B", "\u00AD", "\u034F", "\uFE0F", "\u2032", "\u2018", "\u00B4", "`", "'"];
    const plain = [" ", ".", ",", "&", "(", ")", "-", "/", "\u0301", "\u0308", "a", "Z", "7", "\u00DF", "\u0130", "\u0391", "\u0410", "\u91D1", "\u0645", "\uFF21", "\u2163", "\u00B2"];
    const alphabet = [...odd, ...plain];
    let seed = 0x9e3779b9;
    const next = (n: number): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
      return seed % n;
    };
    const names = [...odd.map((c) => c + c), ...alphabet, ...Array.from({ length: 4000 }, () => Array.from({ length: 1 + next(5) }, () => alphabet[next(alphabet.length)]).join(""))];
    for (const n of names) expect(hasScreenableText(n), JSON.stringify(n)).toBe(nameKeys(n).length > 0);
    await expect(screenSanctions("\u02B9\u02B9", { csvPath: LIST })).rejects.toBeInstanceOf(CheckInputError);
  });
});

interface Builder {
  parseConsolidatedList(xml: string): { rows: { name: string; aliases: string; listId: string; listedOn: string }[]; dateGenerated: string };
  toCsv(rows: unknown[]): string;
}

const builder = (await import(pathToFileURL(join(REPO, "scripts", "build-sanctions.mjs")).href)) as Builder;

describe("scripts/build-sanctions.mjs", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST dateGenerated="2026-10-17T23:00:01.054Z"><INDIVIDUALS><INDIVIDUAL><FIRST_NAME>JOHN</FIRST_NAME><SECOND_NAME>EXAMPLE</SECOND_NAME><THIRD_NAME/>
<REFERENCE_NUMBER>XXi.002</REFERENCE_NUMBER><LISTED_ON>2001-01-25</LISTED_ON><NAME_ORIGINAL_SCRIPT>جون</NAME_ORIGINAL_SCRIPT>
<INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Jon Example; J. Example</ALIAS_NAME></INDIVIDUAL_ALIAS>
<INDIVIDUAL_ALIAS><QUALITY/><ALIAS_NAME/></INDIVIDUAL_ALIAS></INDIVIDUAL></INDIVIDUALS>
<ENTITIES><ENTITY><FIRST_NAME>SMITH &amp; SONS, "LTD"</FIRST_NAME><REFERENCE_NUMBER>XXe.001</REFERENCE_NUMBER><LISTED_ON>not a date</LISTED_ON>
<ENTITY_ALIAS><QUALITY>a.k.a.</QUALITY><ALIAS_NAME>Smith and Sons</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES></CONSOLIDATED_LIST>`;

  it("keeps individuals and entities with their aliases, sorted by reference number", () => {
    const { rows, dateGenerated } = builder.parseConsolidatedList(xml);
    expect(dateGenerated).toBe("2026-10-17T23:00:01.054Z");
    expect(rows).toEqual([
      { name: 'SMITH & SONS, "LTD"', aliases: "Smith and Sons", listId: "XXe.001", listedOn: "" },
      { name: "JOHN EXAMPLE", aliases: "Jon Example;J. Example;جون", listId: "XXi.002", listedOn: "2001-01-25" },
    ]);
  });

  it("writes CSV that screenSanctions reads back", async () => {
    const csvPath = tempList(builder.toCsv(builder.parseConsolidatedList(xml).rows));
    await expect(screenSanctions("Smith & Sons LTD", { csvPath })).resolves.toMatchObject({ hit: true, matchedName: 'SMITH & SONS, "LTD"' });
    await expect(screenSanctions("example jon", { csvPath })).resolves.toMatchObject({ hit: true, matchedName: "Jon Example" });
  });

  it("refuses DTDs, unknown entities and lists without entries", () => {
    expect(() => builder.parseConsolidatedList(`<!DOCTYPE x [<!ENTITY a "b">]>${xml}`)).toThrow(/DOCTYPE/);
    expect(() => builder.parseConsolidatedList(xml.replace("&amp;", "&bogus;"))).toThrow(/unknown XML entity/);
    expect(() => builder.parseConsolidatedList(xml.replace("&amp;", "& "))).toThrow(/bare '&'/);
    expect(() => builder.parseConsolidatedList(xml.replace("&amp;", "&#x110000;"))).toThrow(/invalid character reference/);
    expect(() => builder.parseConsolidatedList(xml.replace("<ENTITIES>", "<ENTITIES><!-- note -->"))).toThrow(/comment/);
    expect(() => builder.parseConsolidatedList(xml.replace("<ALIAS_NAME>Smith", '<ALIAS_NAME xml:lang="en">Smith'))).toThrow(/attributes/);
    expect(() => builder.parseConsolidatedList(xml.replace("</ENTITY>", ""))).toThrow(/unclosed/);
    expect(() => builder.parseConsolidatedList('<CONSOLIDATED_LIST dateGenerated="2026-10-17T23:00:01Z"></CONSOLIDATED_LIST>')).toThrow(/no individuals/);
  });
});
