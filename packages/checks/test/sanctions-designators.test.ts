// Sanctions keys without company designators (VISION-DECISIONS §8): "Co., Ltd." look-alikes of a listed name hit, the
// extra keys only add hits, and no demo catalog name or recorded web seller name hits.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nameKeys, screenSanctions } from "../src/index";
import { REPO } from "./helpers";

const LIST = join(REPO, "data", "sanctions", "un_sc.csv");
const screen = (name: string, csvPath = LIST) => screenSanctions(name, { csvPath });

function tempList(rows: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "hogee-sanctions-")), "un_sc.csv");
  writeFileSync(path, `name,aliases,listId,listedOn\n${rows}`);
  return path;
}

describe("designator-free keys hit look-alike company names", () => {
  it.each([
    ["Korea Ryonbong General Co., Ltd.", "KOREA RYONBONG GENERAL CORPORATION"],
    ["Korea Ryonbong General Pte. Ltd.", "KOREA RYONBONG GENERAL CORPORATION"],
    ["KОRЕА RYONBONG GENERAL CO., LTD.", "KOREA RYONBONG GENERAL CORPORATION"], // Cyrillic О and Е
    ["Korea Ryonbong General", "KOREA RYONBONG GENERAL CORPORATION"],
    ["Green Pine Associated Co Ltd", "GREEN PINE ASSOCIATED CORPORATION"],
    ["Kingly Won International", "KINGLY WON INTERNATIONAL CO., LTD"],
    ["Kingly Won International Inc.", "KINGLY WON INTERNATIONAL CO., LTD"],
    ["Kingly Won International Sdn. Bhd.", "KINGLY WON INTERNATIONAL CO., LTD"],
    ["Chongchongang Shipping Corp.", "Chongchongang Shipping Co LTD"],
    ["Ｓｈａｎｇｈａｉ Ｄｏｎｇｆｅｎｇ Ｓｈｉｐｐｉｎｇ Limited", "SHANGHAI DONGFENG SHIPPING CO LTD"],
    ["華信船務(香港)", "華信船務(香港)有限公司"],
    ["長安海連技術", "長安海連技術有限公司"],
  ])("%s → %s", async (name, matchedName) => {
    await expect(screen(name)).resolves.toEqual({ hit: true, list: "UN_SC", matchedName });
  });

  it("still reports the exact listed string for an exact match", async () => {
    await expect(screen("KINGLY WON INTERNATIONAL CO., LTD")).resolves.toMatchObject({ matchedName: "KINGLY WON INTERNATIONAL CO., LTD" });
    await expect(screen("Chong Chon Gang Shipping Co. Ltd.")).resolves.toMatchObject({ matchedName: "Chong Chon Gang Shipping Co. Ltd." });
  });

  it("strips 有限公司 from a Chinese name, both in the list and in the query", async () => {
    const list = tempList("示例船务有限公司,,TEST.1,2026-01-01\n样本工业,,TEST.2,2026-01-01\n");
    await expect(screen("示例船务", list)).resolves.toMatchObject({ hit: true, matchedName: "示例船务有限公司" });
    await expect(screen("样本工业有限公司", list)).resolves.toMatchObject({ hit: true, matchedName: "样本工业" });
    await expect(screen("示例船务集团", list)).resolves.toMatchObject({ hit: false });
  });

  it("only adds keys: exact keys first, and none for a name made only of designators", () => {
    expect(nameKeys("Foo Trading Co., Ltd.")).toEqual(["w:co foo ltd trading", "c:footradingcoltd", "w:foo trading", "c:footrading"]);
    expect(nameKeys("Allied Democratic Forces")).toEqual(["w:allied democratic forces", "c:allieddemocraticforces"]);
    expect(nameKeys("Co., Ltd.")).toEqual(["w:co ltd", "c:coltd"]);
    // Whole tokens only: "Cooper", "Incline" and "Limitedly" keep their letters; a lone "Bhd" is not "Sdn Bhd".
    expect(nameKeys("Cooper Incline Limitedly Bhd")).toEqual(["w:bhd cooper incline limitedly", "c:cooperinclinelimitedlybhd"]);
  });

  it("does not match a listed name inside a longer one", async () => {
    await expect(screen("Korea Ryonbong General Trading Co., Ltd.")).resolves.toMatchObject({ hit: false });
  });
});

describe("no false positives on our own names", () => {
  const demoDir = join(REPO, "data", "suppliers", "demo");
  const demo = readdirSync(demoDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const json = JSON.parse(readFileSync(join(demoDir, f), "utf8")) as { supplier?: Record<string, unknown> } & Record<string, unknown>;
      return (json.supplier ?? json) as { supplierId: string; displayName: string; xenditTest?: { holderName: string } };
    });
  /** Supplier F is the deliberate sanctions test row: its listed display name must keep hitting. */
  const isSanctionsTestRow = (s: (typeof demo)[number]) => s.xenditTest?.holderName.startsWith("SANCTIONS SCREENING TEST ROW") ?? false;

  it("finds the nine demo suppliers", () => {
    expect(demo).toHaveLength(9);
    expect(demo.filter(isSanctionsTestRow).map((s) => s.supplierId)).toEqual(["supplier-f"]);
  });

  it.each(demo.flatMap((s) => [s.displayName, s.xenditTest?.holderName ?? ""].filter(Boolean).map((name) => [s.supplierId, name, isSanctionsTestRow(s) && name === s.displayName] as const)))(
    "%s: %s",
    async (_id, name, listed) => {
      await expect(screen(name)).resolves.toMatchObject({ hit: listed });
    },
  );

  const readerDir = join(REPO, "data", "suppliers", "search", "reader");
  const sellers = readdirSync(readerDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => (JSON.parse(readFileSync(join(readerDir, f), "utf8")) as { fields: { sellerName: { value: string } | null } }).fields.sellerName?.value ?? "");

  it.each(sellers)("recorded web seller %s", async (name) => {
    expect(name).not.toBe("");
    await expect(screen(name)).resolves.toMatchObject({ hit: false });
  });
});
