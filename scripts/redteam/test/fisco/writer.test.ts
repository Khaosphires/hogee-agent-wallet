import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";
import { FISCO_FORMAT, hashesFileOf, packIdOf, type PackFile } from "../../../../tools/verify-evidence/src/fisco/pack";
import { keySecretForms } from "../../src/fisco/sign";
import { PackWriteError, writePack } from "../../src/fisco/writer";

const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "fisco-pack-"));
  temps.push(d);
  return d;
};
const K1 = `0x${"11".repeat(32)}`;
const K2 = `0x${"22".repeat(32)}`;
const core = (createdAt = "2026-10-20T03:00:00.000Z", files: Record<string, string> = { "plans.json": K1, "payments.json": K2 }): Omit<PackFile, "packId"> => ({
  format: FISCO_FORMAT,
  createdAt,
  gitCommit: "3420445",
  sourceBundle: { runId: "ev-74756ea61a72ae7c", files },
});
const code = new Map([["code/PlanRegistry.hex", "0x6080604052\n"]]);

describe("writePack", () => {
  it("writes pack.json, the files and hashes.json (last) into fm-<packId>", () => {
    const out = tmp();
    const { packId, dir } = writePack(out, core(), code, []);
    expect(dir).toBe(join(out, packId));
    expect(readdirSync(out)).toEqual([packId]);
    const pack = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")) as PackFile;
    expect(pack.packId).toBe(packId);
    const files = { "pack.json": readFileSync(join(dir, "pack.json"), "utf8"), "code/PlanRegistry.hex": "0x6080604052\n" };
    expect(readFileSync(join(dir, "hashes.json"), "utf8")).toBe(hashesFileOf(files));
  });

  it("gives a stable pack id: the same core in another key order, the same id; another time, another id", () => {
    const a = packIdOf(core());
    expect(packIdOf(core(undefined, { "payments.json": K2, "plans.json": K1 }))).toBe(a);
    expect(packIdOf(core("2026-10-20T03:00:01.000Z"))).not.toBe(a);
    expect(a).toMatch(/^fm-[0-9a-f]{16}$/);
  });

  it("refuses to write a pack holding a key (secret scan), leaving no folder behind", () => {
    const out = tmp();
    const key = generatePrivateKey();
    const leaky = new Map([["code/Treasury.hex", `0x6080${key.slice(2)}\n`]]);
    expect(() => writePack(out, core(), leaky, keySecretForms([key]))).toThrow(/secret scan/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("finds a key in any letter case: the hex scan is case-insensitive (run-11 H-replay)", () => {
    const key = generatePrivateKey();
    const mixed = [...key.slice(2)].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join("");
    for (const leak of [mixed, `0X${key.slice(2).toUpperCase()}`]) {
      const out = tmp();
      expect(() => writePack(out, core(undefined, { "plans.json": K1, [`notes-${leak}`]: K2 }), code, keySecretForms([key]))).toThrow(/secret scan/);
      expect(readdirSync(out)).toEqual([]);
    }
  });

  it("keeps the base64 form exact (a different-case base64 string is another value)", () => {
    const key = generatePrivateKey();
    const b64 = Buffer.from(key.slice(2), "hex").toString("base64");
    expect(() => writePack(tmp(), core(undefined, { "plans.json": K1, [`notes-${b64}`]: K2 }), code, keySecretForms([key]))).toThrow(/secret scan/);
  });

  it("finds a key written as base64url or as unpadded base64 (run-11b INFO)", () => {
    // A key whose base64 needs the URL-safe swap (+ and / present) and ends in padding, so each form is distinct.
    let key = generatePrivateKey();
    while (!/[+/]/.test(Buffer.from(key.slice(2), "hex").toString("base64"))) key = generatePrivateKey();
    const bytes = Buffer.from(key.slice(2), "hex");
    for (const leak of [bytes.toString("base64url"), `${bytes.toString("base64url")}=`, bytes.toString("base64").replace(/=+$/, "")]) {
      const out = tmp();
      expect(() => writePack(out, core(undefined, { "plans.json": K1, [`notes-${leak}`]: K2 }), code, keySecretForms([key]))).toThrow(/secret scan/);
      expect(readdirSync(out)).toEqual([]);
    }
  });

  it("refuses a file outside the pack layout or failing its schema", () => {
    expect(() => writePack(tmp(), core(), new Map([["notes.txt", "x"]]), [])).toThrow(PackWriteError);
    expect(() => writePack(tmp(), core(), new Map([[`txs/0x${"ab".repeat(32)}.json`, "{}"]]), [])).toThrow(/fails the pack schema/);
    expect(() => writePack(tmp(), core(), new Map([["code/Treasury.hex", "0xABCD\n"]]), [])).toThrow(/lowercase/);
  });

  it("refuses to overwrite an existing pack", () => {
    const out = tmp();
    writePack(out, core(), code, []);
    expect(() => writePack(out, core(), code, [])).toThrow(/already exists/);
  });
});
