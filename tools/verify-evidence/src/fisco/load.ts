/**
 * Check 1, "pack files": the allow-list (pack.ts isPackPath), size caps before parsing, every file strictly against
 * its schema, pack.json's packId recomputed, and hashes.json listing every other file with its keccak256 (the same
 * index format as a bundle's, load.ts hashesFileOf). A pack with any problem here is not verified further.
 */
import { keccak256 } from "viem";
import type { z } from "zod";
import { HashesFile } from "../bundle";
import type { BundleFiles } from "../load";
import { fileBytes, fileText, parseJson, Problems, type VerifyCheck } from "../util";
import {
  CODE_FILE_RE,
  CODE_NAMES,
  codePath,
  codePathOf,
  FIXED_SCHEMAS,
  isPackPath,
  MAX_CODE_FILE_BYTES,
  MAX_PACK_FILE_BYTES,
  MAX_PACK_FILES,
  PACK_FILES,
  packIdOf,
  TX_PATH_RE,
  TxFile,
  type CodeName,
  type ParsedPack,
} from "./pack";

export const FILES_CHECK = "pack files";

function parse<T>(files: BundleFiles, path: string, schema: z.ZodType<T>, p: Problems): T | undefined {
  const raw = files[path];
  if (raw === undefined) {
    p.add(`${path} is missing`);
    return undefined;
  }
  const text = fileText(raw);
  const json = text === null ? undefined : parseJson(text);
  if (json === undefined) {
    p.add(`${path} is not UTF-8 JSON`);
    return undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    p.add(`${path} does not match its schema at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "invalid"}`);
    return undefined;
  }
  return parsed.data;
}

function checkHashes(files: BundleFiles, p: Problems): void {
  const listed = parse(files, PACK_FILES.hashes, HashesFile, p);
  if (!listed) return;
  for (const path of Object.keys(files)) {
    if (path === PACK_FILES.hashes) continue;
    const want = Object.hasOwn(listed.files, path) ? listed.files[path] : undefined;
    if (!want) p.add(`${path} is not listed in hashes.json`);
    else if (keccak256(fileBytes(files[path] as string | Uint8Array)) !== want) p.add(`${path} does not match its stored hash`);
  }
  // Own keys only: `in` would count an inherited name (toString, constructor) as a file the pack holds.
  for (const path of Object.keys(listed.files)) if (!Object.hasOwn(files, path)) p.add(`${path} is listed in hashes.json but missing`);
}

function readCode(files: BundleFiles, sepolia: boolean, p: Problems): Map<CodeName, string> {
  const out = new Map<CodeName, string>();
  for (const name of CODE_NAMES) {
    const path = codePath(name, sepolia);
    const raw = files[path];
    const text = raw === undefined ? null : fileText(raw);
    if (text === null || !CODE_FILE_RE.test(text)) p.add(`${path} is ${raw === undefined ? "missing" : "not lowercase 0x-hex runtime code"}`);
    else out.set(name, text.trim());
  }
  return out;
}

export interface LoadedPack {
  readonly pack: ParsedPack | null;
  readonly check: VerifyCheck;
}

/** Structure, schemas and hashes of a pack; `pack` is null when any of them fails. */
export function loadPack(files: BundleFiles): LoadedPack {
  const p = new Problems(FILES_CHECK);
  const paths = Object.keys(files);
  if (paths.length > MAX_PACK_FILES) {
    p.add(`${paths.length} files (more than ${MAX_PACK_FILES})`);
    return { pack: null, check: p.result("") };
  }
  for (const path of paths) {
    const size = fileBytes(files[path] as string | Uint8Array).length;
    if (!isPackPath(path)) p.add(`unexpected file ${path}`);
    else if (size > (codePathOf(path) ? MAX_CODE_FILE_BYTES : MAX_PACK_FILE_BYTES)) p.add(`${path} is larger than its cap`);
  }
  if (p.count > 0) return { pack: null, check: p.result("") };
  const fixed: Record<string, unknown> = {};
  for (const [path, schema] of Object.entries(FIXED_SCHEMAS)) fixed[path] = parse(files, path, schema as z.ZodType<unknown>, p);
  const txs = new Map<string, z.infer<typeof TxFile>>();
  for (const path of paths) {
    const m = TX_PATH_RE.exec(path);
    if (!m) continue;
    const tx = parse(files, path, TxFile, p);
    if (tx && tx.hash !== m[1]) p.add(`${path} holds another tx (${tx.hash})`);
    else if (tx) txs.set(m[1] as string, tx);
  }
  const codeHex = readCode(files, false, p);
  const sepoliaCodeHex = readCode(files, true, p);
  checkHashes(files, p);
  const packFile = fixed[PACK_FILES.pack] as ParsedPack["pack"] | undefined;
  if (packFile && packIdOf(packFile) !== packFile.packId) p.add(`pack.json: packId is not ${packIdOf(packFile)} (keccak256 of the pack.json core)`);
  if (p.count > 0) return { pack: null, check: p.result("") };
  const pack: ParsedPack = {
    pack: fixed[PACK_FILES.pack] as ParsedPack["pack"],
    chain: fixed[PACK_FILES.chain] as ParsedPack["chain"],
    deployment: fixed[PACK_FILES.deployment] as ParsedPack["deployment"],
    steps: fixed[PACK_FILES.steps] as ParsedPack["steps"],
    artifacts: fixed[PACK_FILES.artifacts] as ParsedPack["artifacts"],
    plan: fixed[PACK_FILES.plan] as ParsedPack["plan"],
    t28: fixed[PACK_FILES.t28] as ParsedPack["t28"],
    sepoliaBroadcast: fixed[PACK_FILES.sepoliaBroadcast] as ParsedPack["sepoliaBroadcast"],
    code: fixed[PACK_FILES.codeMeta] as ParsedPack["code"],
    sepoliaCode: fixed[PACK_FILES.sepoliaCodeMeta] as ParsedPack["sepoliaCode"],
    ledger: fixed[PACK_FILES.ledger] as ParsedPack["ledger"],
    codeHex,
    sepoliaCodeHex,
    txs,
  };
  return { pack, check: p.result(`${paths.length} files on the allow-list, schemas strict, ${paths.length - 1} match hashes.json, ${txs.size} txs`) };
}
