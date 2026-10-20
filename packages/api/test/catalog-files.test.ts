/**
 * File containment for P3's supplier data (security audit run-5 item 2): a listing's rawTextRef must resolve, after
 * realpath, to a regular file under data/suppliers and below the size cap; a read that fails is logged and reads as
 * no text; a load that fails is not cached, so one bad moment does not break every later shortlist.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileCatalog } from "../src/runtime/catalog";
import { MAX_DATASET_FILE_BYTES, MAX_LISTING_BYTES } from "../src/runtime/files";
import { exampleE2PromptRow } from "@hogee/core";
import { TEST_PACK_MY, TEST_PACK_SG, TEST_SUPPLIERS } from "./support/catalog";

const logged: string[] = [];
const log = { info: () => undefined, warn: (e: string) => void logged.push(e), error: (e: string) => void logged.push(e) };

function repo() {
  const root = mkdtempSync(join(tmpdir(), "hogee-files-"));
  const data = join(root, "data");
  mkdirSync(join(data, "schemas"), { recursive: true });
  mkdirSync(join(data, "suppliers", "demo"), { recursive: true });
  mkdirSync(join(data, "suppliers", "raw"), { recursive: true });
  return { root, data };
}

const base = TEST_SUPPLIERS[0]!.supplier;
function supplierFile(data: string, name: string, supplierId: string, rawTextRef: string): void {
  writeFileSync(join(data, "suppliers", "demo", `${name}.json`), JSON.stringify({ ...base, supplierId, listing: { ...base.listing, rawTextRef } }));
}

const chmodded: string[] = [];
afterEach(() => {
  for (const p of chmodded.splice(0)) chmodSync(p, 0o755);
});

describe("listing text containment", () => {
  it("reads a regular file under data/suppliers only; anything else is logged and reads as unreadable (null)", async () => {
    const { root, data } = repo();
    writeFileSync(join(data, "suppliers", "raw", "ok.txt"), "Insulated tumbler listing");
    mkdirSync(join(data, "country-packs"));
    writeFileSync(join(data, "country-packs", "secret.txt"), "not a listing");
    writeFileSync(join(root, "outside.txt"), "outside the data dir");
    symlinkSync(join(root, "outside.txt"), join(data, "suppliers", "raw", "link.txt"));
    mkdirSync(join(data, "suppliers", "raw", "adir"));
    writeFileSync(join(data, "suppliers", "raw", "big.txt"), "x".repeat(MAX_LISTING_BYTES + 1));
    supplierFile(data, "a", "supplier-a", "data/suppliers/raw/ok.txt");
    supplierFile(data, "b", "supplier-b", "data/country-packs/secret.txt"); // inside the repo, outside data/suppliers
    supplierFile(data, "c", "supplier-c", "data/suppliers/raw/link.txt"); // symlink escaping data/suppliers
    supplierFile(data, "d", "supplier-d", "data/suppliers/raw/adir"); // a directory (EISDIR)
    supplierFile(data, "e", "supplier-e", "data/suppliers/raw/big.txt"); // over the size cap
    logged.length = 0;
    const s = await fileCatalog(data, log).suppliers();
    expect(s.map((x) => [x.supplier.supplierId, x.listingText])).toEqual([
      ["supplier-a", "Insulated tumbler listing"],
      ["supplier-b", null],
      ["supplier-c", null],
      ["supplier-d", null],
      ["supplier-e", null],
    ]);
    expect(logged.filter((e) => e === "listing_text_unreadable")).toHaveLength(4);
  });
});

describe("failed loads are not cached", () => {
  it("a supplier directory that cannot be read now is read again on the next call", async () => {
    const { data } = repo();
    writeFileSync(join(data, "suppliers", "raw", "ok.txt"), "listing");
    supplierFile(data, "a", "supplier-a", "data/suppliers/raw/ok.txt");
    const demo = join(data, "suppliers", "demo");
    chmodSync(demo, 0o000);
    chmodded.push(demo);
    const cat = fileCatalog(data, log);
    await expect(cat.suppliers()).rejects.toThrow();
    chmodSync(demo, 0o755);
    expect((await cat.suppliers()).map((x) => x.supplier.supplierId)).toEqual(["supplier-a"]);
  });

  it("a country pack that is not JSON reads as absent (logged), not as a cached failure", async () => {
    const { data } = repo();
    mkdirSync(join(data, "country-packs"));
    writeFileSync(join(data, "country-packs", "MY.json"), "{ not json");
    logged.length = 0;
    expect(await fileCatalog(data, log).countryPack("MY")).toBeNull();
    expect(logged).toContain("country_pack_invalid");
  });

  it("a valid pack under another country's file name reads as absent (logged), and is read again once fixed (run-8)", async () => {
    const { data } = repo();
    mkdirSync(join(data, "country-packs"));
    writeFileSync(join(data, "country-packs", "MY.json"), JSON.stringify(TEST_PACK_SG));
    writeFileSync(join(data, "country-packs", "SG.json"), JSON.stringify(TEST_PACK_MY));
    logged.length = 0;
    const cat = fileCatalog(data, log);
    expect(await cat.countryPack("MY")).toBeNull();
    expect(await cat.countryPack("SG")).toBeNull();
    expect(logged.filter((e) => e === "country_pack_mismatch")).toHaveLength(2);
    writeFileSync(join(data, "country-packs", "MY.json"), JSON.stringify(TEST_PACK_MY));
    expect((await cat.countryPack("MY"))?.countryCode).toBe("MY");
  });
});

describe("incomplete results are not cached either (skills re-check of run-5)", () => {
  it("unreadable listing text, an absent pack, absent E2 prompts and an incomplete E3 set are read again next time", async () => {
    const { root, data } = repo();
    supplierFile(data, "a", "supplier-a", "data/suppliers/raw/late.txt");
    const set = join(data, "suppliers", "eval", "set-01");
    mkdirSync(join(set, "listings"), { recursive: true });
    writeFileSync(join(set, "listings", "a.json"), JSON.stringify({ ...base, listing: { ...base.listing, rawTextRef: "data/suppliers/eval/set-01/late.txt" } }));
    const cat = fileCatalog(data, log);
    expect((await cat.suppliers())[0]?.listingText).toBeNull();
    expect(await cat.countryPack("MY")).toBeNull();
    expect(await cat.e2Prompt(exampleE2PromptRow.promptId)).toBeNull();
    expect((await cat.supplierEvalSet("set-01"))?.listings[0]?.listingText).toBeNull();
    // The files arrive (or a transient EACCES clears): the same catalog instance now sees them.
    writeFileSync(join(data, "suppliers", "raw", "late.txt"), "late listing");
    writeFileSync(join(set, "late.txt"), "late set listing");
    mkdirSync(join(data, "country-packs"));
    writeFileSync(join(data, "country-packs", "MY.json"), JSON.stringify(TEST_PACK_MY));
    mkdirSync(join(root, "evals", "datasets", "e2"), { recursive: true });
    writeFileSync(join(root, "evals", "datasets", "e2", "prompts.jsonl"), JSON.stringify(exampleE2PromptRow));
    expect((await cat.suppliers())[0]?.listingText).toBe("late listing");
    expect((await cat.countryPack("MY"))?.countryCode).toBe("MY");
    expect((await cat.e2Prompt(exampleE2PromptRow.promptId))?.row).toEqual(exampleE2PromptRow);
    expect((await cat.supplierEvalSet("set-01"))?.listings[0]?.listingText).toBe("late set listing");
  });

  it("a complete result is cached", async () => {
    const { data } = repo();
    writeFileSync(join(data, "suppliers", "raw", "ok.txt"), "listing");
    supplierFile(data, "a", "supplier-a", "data/suppliers/raw/ok.txt");
    const cat = fileCatalog(data, log);
    const first = await cat.suppliers();
    supplierFile(data, "b", "supplier-b", "data/suppliers/raw/ok.txt");
    expect(await cat.suppliers()).toBe(first);
  });
});

describe("every dataset file goes through the contained reader (skills re-check of run-5)", () => {
  it("a device or FIFO behind a supplier file, pack, spec.json or jsonl is refused without blocking", async () => {
    const { root, data } = repo();
    writeFileSync(join(data, "suppliers", "raw", "ok.txt"), "listing");
    supplierFile(data, "a", "supplier-a", "data/suppliers/raw/ok.txt");
    symlinkSync("/dev/zero", join(data, "suppliers", "demo", "zero.json"));
    execFileSync("mkfifo", [join(data, "suppliers", "demo", "fifo.json")]);
    mkdirSync(join(data, "country-packs"));
    symlinkSync("/dev/zero", join(data, "country-packs", "MY.json"));
    const set = join(data, "suppliers", "eval", "set-01");
    mkdirSync(join(set, "listings"), { recursive: true });
    writeFileSync(join(set, "listings", "a.json"), JSON.stringify({ ...base, listing: { ...base.listing, rawTextRef: "data/suppliers/raw/ok.txt" } }));
    symlinkSync("/dev/zero", join(set, "spec.json"));
    const e2 = join(root, "evals", "datasets", "e2");
    mkdirSync(e2, { recursive: true });
    symlinkSync("/dev/zero", join(e2, "prompts.jsonl"));
    logged.length = 0;
    const cat = fileCatalog(data, log);
    expect((await cat.suppliers()).map((s) => s.supplier.supplierId)).toEqual(["supplier-a"]);
    expect(await cat.countryPack("MY")).toBeNull();
    expect((await cat.supplierEvalSet("set-01"))?.spec).toBeNull();
    expect(await cat.e2Prompt(exampleE2PromptRow.promptId)).toBeNull();
    expect(logged.filter((e) => e === "dataset_file_refused").length).toBeGreaterThanOrEqual(5);
  }, 5_000);

  it("a dataset file over its size cap is refused", async () => {
    const { data } = repo();
    mkdirSync(join(data, "country-packs"));
    writeFileSync(join(data, "country-packs", "MY.json"), " ".repeat(MAX_DATASET_FILE_BYTES + 1));
    logged.length = 0;
    expect(await fileCatalog(data, log).countryPack("MY")).toBeNull();
    expect(logged).toContain("dataset_file_refused");
  });
});
