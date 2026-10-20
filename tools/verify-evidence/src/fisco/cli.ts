/**
 * `make verify-fisco PACK=evidence/fisco/fm-<16hex>` / `pnpm --filter @hogee/verify-evidence verify:fisco <pack dir>
 * --sepolia-bundle <dir> [--artifacts <contracts/out>] [--json]`: verifies a FISCO mirror pack offline (no network)
 * and exits 0 when every check passes, 1 on any mismatch, 2 when there is nothing to verify or an argument is bad.
 * Directories are read without following links (read-dir.ts), the pack under its own caps. With --artifacts, the
 * pack's artifacts.json must equal the local forge build. The repo's tracked copy of the source broadcast, at the path
 * the source identity pins (never one the pack names), must exist, carry the pinned keccak256 and equal the pack's
 * copy; the pack folder must be named after its packId.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";
import { readBundleDir, type ReadCaps } from "../read-dir";
import { parseJson, sameHex, type VerifyCheck } from "../util";
import { ANCHOR_BOOL_FLAGS, ANCHOR_USAGE, ANCHOR_VALUE_FLAGS, anchorLine, onlineAnchorLines } from "./anchor-cli";
import { verifyFiscoPack, type FiscoOptions } from "./index";
import { ArtifactEntry, CODE_NAMES, codePathOf, FINAL_2, MAX_CODE_FILE_BYTES, MAX_PACK_FILE_BYTES, MAX_PACK_FILES, PACK_FILES, type CodeName, type SourceIdentity } from "./pack";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALUE_FLAGS = new Set<string>(["--sepolia-bundle", "--artifacts", ...ANCHOR_VALUE_FLAGS]);
/** forge artifacts are larger than pack files (ABI, source maps, metadata). */
const MAX_FORGE_ARTIFACT_BYTES = 16 * 1024 * 1024;
/** The pack caps of loadPack, applied while walking the folder (nothing larger is read into memory). */
export const PACK_READ_CAPS: ReadCaps = { maxEntries: MAX_PACK_FILES, maxBytes: (rel) => (codePathOf(rel) ? MAX_CODE_FILE_BYTES : MAX_PACK_FILE_BYTES) };

export const FISCO_MEANING =
  "VERIFIED means the pack is internally consistent and consistent with the pinned Sepolia bundle: the same code (immutables explained), " +
  "constructor inputs, signed plan and calls ran on the local FISCO BCOS chain with the recorded outcomes, and every refusal is explained offline. " +
  "The FISCO chain is local and not publicly reachable: its block headers are taken as served, not recomputed.";

type Print = (line: string) => void;

/**
 * Pack-controlled text (file and folder names, JSON keys, a node's messages) reaches the printed details. In text mode
 * every control character (C0, DEL, C1), line or paragraph separator, bidi control (including U+061C, the Arabic
 * letter mark) and invisible format character (soft hyphen U+00AD, zero-width U+200B-U+200D, word joiner and invisible
 * operators U+2060-U+2064, BOM U+FEFF) is printed escaped (\n, \r, \t, else \xNN or \uNNNN; a backslash as \\), so a
 * pack can neither hide nor forge an "ok", FAIL or NOT VERIFIED line, nor make two different names print alike.
 */
const UNSAFE_TEXT = /[\\\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/** In JSON, JSON.stringify already escapes C0, `"` and `\`; the rest of the set becomes \uNNNN (the same value). */
const UNSAFE_JSON = /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const u4 = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
const SHORT: Readonly<Record<string, string>> = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
export const printable = (s: string): string =>
  s.replace(UNSAFE_TEXT, (c) => SHORT[c] ?? (c.charCodeAt(0) < 0x100 ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}` : u4(c)));

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** A regular file of at most `max` bytes (no link followed), or null. */
function readRegular(path: string, max: number): Uint8Array | null {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= max ? new Uint8Array(readFileSync(path)) : null;
  } catch {
    return null;
  }
}

/** contracts/out/<Name>.sol/<Name>.json → ArtifactEntry, per contract (an unreadable one is left out: code identity fails). */
export function readForgeArtifacts(dir: string): Partial<Record<CodeName, ArtifactEntry>> {
  const out: Partial<Record<CodeName, ArtifactEntry>> = {};
  for (const name of CODE_NAMES) {
    const bytes = readRegular(join(dir, `${name}.sol`, `${name}.json`), MAX_FORGE_ARTIFACT_BYTES);
    const j = bytes ? (parseJson(new TextDecoder().decode(bytes)) as { bytecode?: { object?: unknown }; deployedBytecode?: { object?: unknown; immutableReferences?: unknown } } | undefined) : undefined;
    const entry = ArtifactEntry.safeParse({ bytecode: j?.bytecode?.object, deployedBytecode: j?.deployedBytecode?.object, immutableReferences: j?.deployedBytecode?.immutableReferences ?? {} });
    if (entry.success) out[name] = entry.data;
  }
  return out;
}

/**
 * The pack's copy of the source broadcast vs the repo's tracked file at the PINNED path (the source identity's, never
 * the pack's): a missing, unreadable or different file is a failing line, never a skipped one.
 */
function broadcastOnDisk(files: Readonly<Record<string, Uint8Array>>, id: SourceIdentity, root: string): VerifyCheck {
  const name = "source broadcast (repo copy)";
  const rel = id.broadcastFile;
  const path = resolve(root, rel);
  const disk = path.startsWith(`${root}${sep}`) ? readRegular(path, MAX_PACK_FILE_BYTES) : null;
  if (disk === null) return { name, ok: false, detail: `the tracked ${rel} is missing or not a regular file` };
  if (!sameHex(keccak256(disk), id.broadcastKeccak)) return { name, ok: false, detail: `the tracked ${rel} is not the pinned file (keccak256 differs)` };
  const packed = files[PACK_FILES.sepoliaBroadcast];
  const same = packed !== undefined && disk.length === packed.length && disk.every((b, i) => b === packed[i]);
  return same ? { name, ok: true, detail: `equals the tracked ${rel} (keccak256 pinned)` } : { name, ok: false, detail: `the pack's sepolia-broadcast.json is not the tracked ${rel}` };
}

/** The docs cite a pack by its folder: the folder must be named after the packId pack.json commits to. */
function folderCheck(dir: string, packId: string | null): VerifyCheck {
  const name = "pack folder";
  const folder = basename(dir);
  if (packId === null) return { name, ok: false, detail: `${folder}: no packId to compare (pack.json did not load)` };
  return folder === packId ? { name, ok: true, detail: `named after its packId ${packId}` } : { name, ok: false, detail: `the folder ${folder} is not the packId ${packId}` };
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function report(print: Print, json: boolean, dir: string, packId: string | null, checks: readonly VerifyCheck[], ok: boolean): number {
  if (json) {
    print(JSON.stringify({ pack: dir, packId, ok, checks, meaning: FISCO_MEANING }, null, 2).replace(UNSAFE_JSON, u4));
    return ok ? 0 : 1;
  }
  print(`verify-fisco ${printable(dir)}`);
  for (const c of checks) print(`  ${c.ok ? "ok  " : "FAIL"} ${printable(c.name)}${c.detail ? ` — ${printable(c.detail)}` : ""}`);
  print(ok ? `VERIFIED: every check passed. ${FISCO_MEANING}` : "NOT VERIFIED: at least one check failed");
  return ok ? 0 : 1;
}

/**
 * Exit code: 0 verified, 1 a check failed, 2 nothing to verify or a bad argument. `source` and `repoRoot` are for the
 * test suite only (no flag or env var sets them): the command line always verifies against final-2 and this repo.
 */
export function main(argv: readonly string[], print: Print = (l) => process.stdout.write(`${l}\n`), source?: FiscoOptions["source"], repoRoot: string = REPO_ROOT, online: readonly VerifyCheck[] = []): number {
  for (const f of VALUE_FLAGS) {
    if (argv.includes(f) && !flag(argv, f.slice(2))) {
      print(`verify-fisco: ${f} needs a ${f === "--anchor-rpc" ? "URL" : "directory"}`);
      return 2;
    }
  }
  const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));
  const unknown = argv.filter((a) => a.startsWith("--") && !VALUE_FLAGS.has(a) && a !== "--json" && !ANCHOR_BOOL_FLAGS.includes(a));
  if (positional.length !== 1 || unknown.length > 0) {
    print(`usage: verify-fisco <pack dir> --sepolia-bundle <bundle dir> [--artifacts <contracts/out>] ${ANCHOR_USAGE} [--json]`);
    return 2;
  }
  const dir = resolve(positional[0] as string);
  const bundleArg = flag(argv, "sepolia-bundle");
  const artifactsArg = flag(argv, "artifacts");
  if (!isDir(dir)) {
    print(`verify-fisco: ${printable(positional[0] as string)} is not a directory (no pack to verify)`);
    return 2;
  }
  if (!bundleArg || !isDir(resolve(bundleArg))) {
    print("verify-fisco: --sepolia-bundle <dir> is required (the source evidence bundle the pack mirrors)");
    return 2;
  }
  if (artifactsArg !== undefined && !isDir(resolve(artifactsArg))) {
    print(`verify-fisco: --artifacts ${printable(artifactsArg)} is not a directory`);
    return 2;
  }
  const pack = readBundleDir(dir, PACK_READ_CAPS);
  const bundle = readBundleDir(resolve(bundleArg));
  const artifacts = artifactsArg === undefined ? undefined : readForgeArtifacts(resolve(artifactsArg));
  const id = source ?? FINAL_2;
  const result = verifyFiscoPack(pack.files, { sepoliaBundle: bundle.files, ...(artifacts ? { artifacts } : {}), source: id });
  const extra: VerifyCheck[] = [broadcastOnDisk(pack.files as Readonly<Record<string, Uint8Array>>, id, resolve(repoRoot)), folderCheck(dir, result.packId)];
  if (pack.refused.length > 0) extra.push({ name: "pack files on disk", ok: false, detail: pack.refused.slice(0, 4).join("; ") });
  if (bundle.refused.length > 0) extra.push({ name: "source bundle files on disk", ok: false, detail: bundle.refused.slice(0, 4).join("; ") });
  extra.push(anchorLine(dir, pack.files, result.packId, argv), ...online);
  const checks = [...result.checks, ...extra];
  return report(print, argv.includes("--json"), dir, result.packId, checks, result.ok && extra.every((c) => c.ok));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  onlineAnchorLines(argv, VALUE_FLAGS).then(
    (online) => (process.exitCode = main(argv, undefined, undefined, undefined, online)),
    () => ((process.exitCode = 1), process.stdout.write("verify-fisco: the online anchor confirmation failed (NOT VERIFIED)\n")),
  );
}
