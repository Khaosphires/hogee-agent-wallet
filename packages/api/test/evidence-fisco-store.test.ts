/**
 * FISCO BCOS mirror pack reads (evidence/fisco-store.ts; REG-BRIEF fisco-proof) on packs written to disk: a pack is
 * listed and served only when this tenant may read its source Sepolia bundle today, with the bundle reader's guards
 * (no link followed, one link per file, a FIFO never opened, the caps of a pack and of its anchor sidecar).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, linkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_PACK_FILE_BYTES, MAX_PACK_FILES } from "@hogee/verify-evidence/fisco";
import { listFiscoPacks, MAX_ANCHOR_BYTES, MAX_LISTED_PACKS, MAX_PACK_JSON_BYTES, MAX_SCANNED_PACKS, readFiscoAnchor, readFiscoFile, type OwnsSource } from "../src/evidence/fisco-store";
import { ownsRun, type Tenant } from "../src/evidence/store";
import { buildFixture, CHAIN_ID, DEPLOYMENT_ID } from "../../../tools/verify-evidence/test/fixture";

const RUN = "run-test-1";
const PACK = "fm-0123456789abcdef";
const OLDER = "fm-fedcba9876543210";
const TEST: Tenant = { facilityId: "fac-test", deploymentId: DEPLOYMENT_ID, chainId: CHAIN_ID };
const OTHER: Tenant = { ...TEST, facilityId: "fac-other" };
const TX = `0x${"ab".repeat(32)}`;

let root: string;
const ownsFor =
  (tenant: Tenant): OwnsSource =>
  (runId) =>
    ownsRun(root, runId, tenant);
const owns = (runId: string) => ownsFor(TEST)(runId);
const nobody: OwnsSource = async () => false;

/** pack.json as the replay writes it (only what the store reads matters here). */
const packJson = (packId: string, createdAt: string, runId = RUN, format = "hogee.fisco-mirror/2") =>
  JSON.stringify({ format, packId, createdAt, gitCommit: "abcdef1", sourceBundle: { runId, files: {} } });

function write(path: string, body: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

/** evidence/fisco/<packId>/ with pack.json, steps.json and one tx file. */
function pack(packId: string, createdAt: string, opts: { runId?: string; format?: string; folder?: string } = {}): string {
  const dir = join(root, "fisco", opts.folder ?? packId);
  write(join(dir, "pack.json"), packJson(packId, createdAt, opts.runId, opts.format));
  write(join(dir, "steps.json"), "{}");
  write(join(dir, "txs", `${TX}.json`), "{}");
  return dir;
}

const sidecar = (packId: string, body = '{"format":"hogee.fisco-anchor/1"}') => write(join(root, "fisco", "anchors", `${packId}.sepolia.json`), body);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hogee-fisco-store-"));
  const { files } = await buildFixture();
  for (const [path, body] of Object.entries(files)) write(join(root, RUN, path), body);
  pack(PACK, "2026-10-20T08:00:00.000Z");
  pack(OLDER, "2026-10-19T21:03:15.402Z");
  sidecar(PACK);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("FISCO mirror packs: listing", () => {
  it("lists the packs of the tenant's own source bundle, newest first, with every file and the anchor flag", async () => {
    const packs = await listFiscoPacks(root, owns);
    expect(packs.map((p) => p.packId)).toEqual([PACK, OLDER]);
    expect(packs[0]).toEqual({ packId: PACK, createdAt: "2026-10-20T08:00:00.000Z", files: ["pack.json", "steps.json", `txs/${TX}.json`], anchored: true });
    expect(packs[1]?.anchored).toBe(false);
  });

  it("lists nothing for another tenant, or when the tenant may not read the source bundle", async () => {
    expect(await listFiscoPacks(root, ownsFor(OTHER))).toEqual([]);
    expect(await listFiscoPacks(root, nobody)).toEqual([]);
  });

  it("lists nothing when there is no evidence folder or no fisco folder", async () => {
    expect(await listFiscoPacks(join(root, "missing"), owns)).toEqual([]);
    const empty = mkdtempSync(join(tmpdir(), "hogee-fisco-empty-"));
    try {
      expect(await listFiscoPacks(empty, owns)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("leaves out a folder that is not a pack: a wrong name, a packId that isn't the folder's, another format, a source run of no one", async () => {
    pack("fm-1111111111111111", "2026-10-20T09:00:00.000Z", { folder: "fm-not-a-pack" });
    pack("fm-2222222222222222", "2026-10-20T09:00:00.000Z", { folder: "fm-3333333333333333" });
    pack("fm-4444444444444444", "2026-10-20T09:00:00.000Z", { format: "hogee.evidence/1" });
    pack("fm-5555555555555555", "2026-10-20T09:00:00.000Z", { runId: "run-of-someone-else" });
    expect((await listFiscoPacks(root, owns)).map((p) => p.packId)).toEqual([PACK, OLDER]);
  });

  it("never lists a linked pack folder, nor a pack whose pack.json is a link", async () => {
    symlinkSync(join(root, "fisco", PACK), join(root, "fisco", "fm-6666666666666666"));
    const dir = join(root, "fisco", "fm-7777777777777777");
    mkdirSync(dir);
    symlinkSync(join(root, "fisco", PACK, "pack.json"), join(dir, "pack.json"));
    expect((await listFiscoPacks(root, owns)).map((p) => p.packId)).toEqual([PACK, OLDER]);
    expect(await readFiscoFile(root, "fm-6666666666666666", "pack.json", owns)).toBeNull();
  });

  it("reads pack.json under its own 64 KiB cap (a real one is about 3 KB), not the 4 MiB per-file cap (post-fix re-check)", async () => {
    const id = "fm-dddddddddddddddd";
    const dir = pack(id, "2026-10-20T12:30:00.000Z");
    sidecar(id);
    const padded = (size: number): string => {
      const body = packJson(id, "2026-10-20T12:30:00.000Z");
      return `${body}${" ".repeat(size - Buffer.byteLength(body))}`;
    };
    expect(MAX_PACK_JSON_BYTES).toBe(64 * 1024);
    write(join(dir, "pack.json"), padded(MAX_PACK_JSON_BYTES));
    expect((await listFiscoPacks(root, owns)).map((p) => p.packId)).toContain(id);
    write(join(dir, "pack.json"), padded(MAX_PACK_JSON_BYTES + 1));
    expect((await listFiscoPacks(root, owns)).map((p) => p.packId)).not.toContain(id);
    expect(await readFiscoFile(root, id, "steps.json", owns)).toBeNull();
    expect(await readFiscoAnchor(root, id, owns)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(root, "fisco", "anchors", `${id}.sepolia.json`));
  });

  it("refuses a pack with more entries than a pack may hold (the verifier's cap), instead of listing part of it", async () => {
    const dir = pack("fm-8888888888888888", "2026-10-20T10:00:00.000Z");
    for (let i = 0; i < MAX_PACK_FILES; i += 1) write(join(dir, "txs", `${i}.json`), "{}");
    const listed = await listFiscoPacks(root, owns);
    expect(listed.map((p) => p.packId)).not.toContain("fm-8888888888888888");
    expect(await readFiscoFile(root, "fm-8888888888888888", "pack.json", owns)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("FISCO mirror packs: files", () => {
  it("serves a file inert (nosniff, sandbox CSP, no-store), as its exact bytes", async () => {
    const res = await readFiscoFile(root, PACK, "pack.json", owns);
    expect(res?.headers.get("content-type")).toBe("application/json");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res?.headers.get("cache-control")).toBe("no-store");
    expect(await res?.text()).toBe(packJson(PACK, "2026-10-20T08:00:00.000Z"));
  });

  it("serves nothing to another tenant, for an unknown pack, or outside the pack", async () => {
    expect(await readFiscoFile(root, PACK, "pack.json", ownsFor(OTHER))).toBeNull();
    expect(await readFiscoFile(root, "fm-9999999999999999", "pack.json", owns)).toBeNull();
    expect(await readFiscoFile(root, PACK, "../../run-test-1/manifest.json", owns)).toBeNull();
    expect(await readFiscoFile(root, PACK, `../${OLDER}/pack.json`, owns)).toBeNull();
    expect(await readFiscoFile(root, "anchors", `${PACK}.sepolia.json`, owns)).toBeNull();
    expect(await readFiscoFile(root, "../run-test-1", "manifest.json", owns)).toBeNull();
  });

  it("lists a link, a hard link and a FIFO (so the browser's check fails, as make verify-fisco does) but never serves them", async () => {
    // Names a pack may hold (pack.ts isPackPath), so only the link and file-type guards refuse them.
    const dir = pack("fm-aaaaaaaaaaaaaaaa", "2026-10-20T11:00:00.000Z");
    const outside = join(mkdtempSync(join(tmpdir(), "hogee-fisco-out-")), "secret.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(dir, "plan.json"));
    linkSync(outside, join(dir, "t28.json"));
    execFileSync("mkfifo", [join(dir, "ledger.json")]);
    const listed = (await listFiscoPacks(root, owns)).find((p) => p.packId === "fm-aaaaaaaaaaaaaaaa");
    expect(listed?.files).toEqual(expect.arrayContaining(["plan.json", "t28.json", "ledger.json"]));
    for (const path of ["plan.json", "t28.json", "ledger.json"]) expect(await readFiscoFile(root, "fm-aaaaaaaaaaaaaaaa", path, owns), path).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists a file no pack may hold, but serves only the paths the verifier allows (pack.ts isPackPath)", async () => {
    const dir = pack("fm-cccccccccccccccc", "2026-10-20T11:30:00.000Z");
    write(join(dir, "notes.txt"), "a stray file");
    write(join(dir, "txs", "readme.json"), "{}");
    write(join(dir, "code", "Unknown.hex"), "0x00");
    write(join(dir, "code", "Treasury.hex"), "0x00");
    const listed = (await listFiscoPacks(root, owns)).find((p) => p.packId === "fm-cccccccccccccccc");
    expect(listed?.files).toEqual(expect.arrayContaining(["notes.txt", "txs/readme.json", "code/Unknown.hex"]));
    for (const path of ["notes.txt", "txs/readme.json", "code/Unknown.hex"]) expect(await readFiscoFile(root, "fm-cccccccccccccccc", path, owns), path).toBeNull();
    for (const path of ["pack.json", "steps.json", `txs/${TX}.json`, "code/Treasury.hex"]) expect(await readFiscoFile(root, "fm-cccccccccccccccc", path, owns), path).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("never serves a file over the pack's per-file cap", async () => {
    const dir = pack("fm-bbbbbbbbbbbbbbbb", "2026-10-20T12:00:00.000Z");
    write(join(dir, "artifacts.json"), new Uint8Array(MAX_PACK_FILE_BYTES + 1));
    expect(await readFiscoFile(root, "fm-bbbbbbbbbbbbbbbb", "artifacts.json", owns)).toBeNull();
    expect(await readFiscoFile(root, "fm-bbbbbbbbbbbbbbbb", "steps.json", owns)).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("FISCO mirror packs: the Sepolia anchor sidecar", () => {
  it("serves the pack's sidecar inert, to its tenant only", async () => {
    const res = await readFiscoAnchor(root, PACK, owns);
    expect(res?.headers.get("content-type")).toBe("application/json");
    expect(res?.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res?.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await res?.text()).toBe('{"format":"hogee.fisco-anchor/1"}');
    expect(await readFiscoAnchor(root, PACK, ownsFor(OTHER))).toBeNull();
    expect(await readFiscoAnchor(root, OLDER, owns)).toBeNull();
  });

  it("is absent (not anchored) when it is too large, a link, or its folder is a link", async () => {
    sidecar(OLDER, "x".repeat(MAX_ANCHOR_BYTES + 1));
    expect(await readFiscoAnchor(root, OLDER, owns)).toBeNull();
    expect((await listFiscoPacks(root, owns)).find((p) => p.packId === OLDER)?.anchored).toBe(false);
    rmSync(join(root, "fisco", "anchors", `${OLDER}.sepolia.json`));
    symlinkSync(join(root, "fisco", "anchors", `${PACK}.sepolia.json`), join(root, "fisco", "anchors", `${OLDER}.sepolia.json`));
    expect(await readFiscoAnchor(root, OLDER, owns)).toBeNull();
    rmSync(join(root, "fisco", "anchors", `${OLDER}.sepolia.json`));

    const linked = mkdtempSync(join(tmpdir(), "hogee-fisco-linked-"));
    try {
      write(join(linked, "fisco", PACK, "pack.json"), packJson(PACK, "2026-10-20T08:00:00.000Z"));
      write(join(linked, "elsewhere", `${PACK}.sepolia.json`), "{}");
      symlinkSync(join(linked, "elsewhere"), join(linked, "fisco", "anchors"));
      const any: OwnsSource = async () => true;
      expect(await readFiscoAnchor(linked, PACK, any)).toBeNull();
      expect((await listFiscoPacks(linked, any))[0]?.anchored).toBe(false);
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });
});

describe("FISCO mirror packs: tenancy before the listing cap", () => {
  const MINE = "run-mine";
  const hex16 = (n: number) => n.toString(16).padStart(16, "0");
  let other: string;

  /** A pack in `base`/fisco mirroring `runId`, its folder dated `age` seconds before now. */
  function dated(base: string, n: number, runId: string, age: number): string {
    const packId = `fm-${hex16(n)}`;
    const dir = join(base, "fisco", packId);
    write(join(dir, "pack.json"), packJson(packId, "2026-10-20T08:00:00.000Z", runId));
    const t = Date.now() / 1000 - age;
    utimesSync(dir, t, t);
    return packId;
  }

  beforeAll(() => {
    other = mkdtempSync(join(tmpdir(), "hogee-fisco-cap-"));
  });
  afterAll(() => rmSync(other, { recursive: true, force: true }));

  it("another tenant's newer packs never push this tenant's pack out of the list", async () => {
    for (let i = 0; i <= MAX_LISTED_PACKS; i += 1) dated(other, 0x100 + i, "run-of-someone-else", 10 + i);
    const mine = dated(other, 0x1, MINE, 3600);
    const ownsMine: OwnsSource = async (runId) => runId === MINE;
    expect((await listFiscoPacks(other, ownsMine)).map((p) => p.packId)).toEqual([mine]);
  });

  it("asks the tenancy question once per source run in a listing, however many packs mirror it", async () => {
    const asked: string[] = [];
    const counting: OwnsSource = async (runId) => (asked.push(runId), runId === MINE);
    await listFiscoPacks(other, counting);
    expect(asked.sort()).toEqual([MINE, "run-of-someone-else"]);
  });

  it("still lists at most MAX_LISTED_PACKS of the tenant's packs, the newest by folder date", async () => {
    const mine = Array.from({ length: MAX_LISTED_PACKS + 1 }, (_, i) => dated(other, 0x200 + i, MINE, 100 + i));
    const listed = await listFiscoPacks(other, async (runId) => runId === MINE);
    expect(listed).toHaveLength(MAX_LISTED_PACKS);
    expect(listed.map((p) => p.packId).sort()).toEqual(mine.slice(0, MAX_LISTED_PACKS).sort());
  });

  it("reads at most MAX_SCANNED_PACKS pack folders per listing, so its cost does not grow with the folder", async () => {
    const crowded = mkdtempSync(join(tmpdir(), "hogee-fisco-scan-"));
    try {
      for (let i = 0; i < MAX_SCANNED_PACKS; i += 1) dated(crowded, 0x1000 + i, "run-of-someone-else", 10 + i);
      dated(crowded, 0x2, MINE, 7200);
      const asked: string[] = [];
      expect(await listFiscoPacks(crowded, async (runId) => (asked.push(runId), runId === MINE))).toEqual([]);
      expect(asked).toEqual(["run-of-someone-else"]);
    } finally {
      rmSync(crowded, { recursive: true, force: true });
    }
  });
});
