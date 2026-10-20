/**
 * Writes a mirror pack: every file is checked against the pack schema (pack.ts), written into
 * <out>/.fm-tmp-<random>/, the written folder is scanned for secrets (each role key and the soft passkey's private key
 * in every form, the RPC URL; hex forms compared case-insensitively), hashes.json is written last (hashesFileOf over
 * every other file), and only then is the folder renamed to <out>/fm-<16 hex> (packIdOf the pack.json core). A failure
 * removes the temporary folder.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  CODE_FILE_RE,
  codePathOf,
  FIXED_SCHEMAS,
  hashesFileOf,
  isPackPath,
  MAX_CODE_FILE_BYTES,
  MAX_PACK_FILE_BYTES,
  MAX_PACK_FILES,
  PACK_FILES,
  PackFile,
  packIdOf,
  TX_PATH_RE,
  TxFile,
} from "../../../../tools/verify-evidence/src/fisco/pack";

export class PackWriteError extends Error {
  override readonly name = "PackWriteError";
}

const HEX_FORM = /^(0x)?[0-9a-f]+$/i;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return filesUnder(p);
    if (e.isFile()) return [p];
    throw new PackWriteError(`${relative(dir, p)} is neither a file nor a folder`);
  });
}

/**
 * Paths (relative to `dir`) of written files holding any of `secrets`. A hex secret (a key) matches in any letter case;
 * every other form (base64, URL parts) matches exactly.
 */
export function packSecretHits(dir: string, secrets: readonly string[]): string[] {
  const hex = [...new Set(secrets.filter((x) => HEX_FORM.test(x)).map((x) => x.toLowerCase()))];
  const exact = secrets.filter((x) => !HEX_FORM.test(x));
  if (hex.length === 0 && exact.length === 0) return [];
  return filesUnder(dir)
    .filter((f) => {
      const text = readFileSync(f, "utf8");
      const lower = text.toLowerCase();
      return hex.some((x) => lower.includes(x)) || exact.some((x) => text.includes(x));
    })
    .map((f) => relative(dir, f));
}

/** Pretty JSON with a trailing newline (what every pack JSON file holds). */
export const jsonFile = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** Schema-checks one pack file's text; throws PackWriteError naming the path. */
export function checkPackFile(path: string, text: string): void {
  if (!isPackPath(path) || path === PACK_FILES.hashes) throw new PackWriteError(`${path} is not a pack file the writer may write`);
  const size = Buffer.byteLength(text);
  if (size > (codePathOf(path) ? MAX_CODE_FILE_BYTES : MAX_PACK_FILE_BYTES)) throw new PackWriteError(`${path}: ${size} bytes is over the cap`);
  if (codePathOf(path)) {
    if (!CODE_FILE_RE.test(text)) throw new PackWriteError(`${path} is not lowercase 0x code`);
    return;
  }
  const schema = TX_PATH_RE.test(path) ? TxFile : (FIXED_SCHEMAS as Record<string, { safeParse(v: unknown): { success: boolean; error?: { message: string } } }>)[path];
  if (!schema) throw new PackWriteError(`${path} has no schema`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PackWriteError(`${path} is not JSON`);
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new PackWriteError(`${path} fails the pack schema: ${(r.error?.message ?? "").slice(0, 400)}`);
}

export interface WrittenPack {
  readonly packId: string;
  readonly dir: string;
}

/**
 * `files`: every pack file but pack.json and hashes.json (path → text). `secrets`: values that must not appear in any
 * written file. Returns the final folder.
 */
export function writePack(outDir: string, core: Omit<PackFile, "packId">, files: ReadonlyMap<string, string>, secrets: readonly string[]): WrittenPack {
  const packId = packIdOf(core);
  const pack = PackFile.parse({ format: core.format, packId, createdAt: core.createdAt, gitCommit: core.gitCommit, sourceBundle: core.sourceBundle });
  const all = new Map<string, string>([[PACK_FILES.pack, jsonFile(pack)], ...files]);
  if (all.size + 1 > MAX_PACK_FILES) throw new PackWriteError(`${all.size + 1} files is over the ${MAX_PACK_FILES} cap`);
  for (const [path, text] of all) checkPackFile(path, text);
  const final = join(outDir, packId);
  if (existsSync(final)) throw new PackWriteError(`${final} already exists`);
  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, `.fm-tmp-${randomBytes(6).toString("hex")}`);
  try {
    for (const [path, text] of all) {
      const p = join(tmp, path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    const hits = packSecretHits(tmp, secrets);
    if (hits.length > 0) throw new PackWriteError(`secret scan: a key or URL appears in ${hits.join(", ")}; pack not written`);
    writeFileSync(join(tmp, PACK_FILES.hashes), hashesFileOf(Object.fromEntries(all)));
    if (packSecretHits(tmp, secrets).length > 0) throw new PackWriteError("secret scan: hashes.json carries a secret; pack not written");
    renameSync(tmp, final);
  } catch (error: unknown) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  return { packId, dir: final };
}
