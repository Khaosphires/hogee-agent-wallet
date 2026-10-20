/**
 * Reads a bundle's files into a ParsedBundle and runs the two structural checks:
 *   "bundle files": every required file is present and matches its schema; nothing unexpected is present; every
 *     explorer link is on the explorer pinned for the bundle's chain (bundle.ts explorerProblems);
 *   "file hashes": hashes.json lists every other file and each keccak256 matches its exact bytes.
 * A bundle with a missing or invalid required file is not verified any further (the other checks need it).
 */
import { keccak256 } from "viem";
import type { z } from "zod";
import {
  BlocksFile,
  BundleManifest,
  BUNDLE_FILES,
  ChainActionsFile,
  ContractsFile,
  COUNTRY_PACK_FILE,
  CountryPackFile,
  EvidenceRows,
  explorerProblems,
  HashesFile,
  LlmCallsFile,
  PaymentsFile,
  PlansFile,
  RationalesFile,
  RawReceipt,
  RECEIPT_PATH_RE,
  SignaturesFile,
  TracesFile,
  type ParsedBundle,
} from "./bundle";
import { fileBytes, fileText, parseJson, Problems, type VerifyCheck } from "./util";

/** Bundle files keyed by path relative to the bundle root, e.g. "evidence.json", "receipts/0x….json". */
export type BundleFiles = Readonly<Record<string, string | Uint8Array>>;

/** A bundle above these limits is refused before parsing (the explorer runs this in a browser tab). */
export const MAX_BUNDLE_FILES = 5_000;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

const REQUIRED = [
  ["manifest", BUNDLE_FILES.manifest, BundleManifest],
  ["rows", BUNDLE_FILES.evidence, EvidenceRows],
  ["contracts", BUNDLE_FILES.contracts, ContractsFile],
  ["plans", BUNDLE_FILES.plans, PlansFile],
  ["signatures", BUNDLE_FILES.signatures, SignaturesFile],
  ["payments", BUNDLE_FILES.payments, PaymentsFile],
  ["chainActions", BUNDLE_FILES.chainActions, ChainActionsFile],
  ["rationales", BUNDLE_FILES.rationales, RationalesFile],
  ["traces", BUNDLE_FILES.traces, TracesFile],
  ["llmCalls", BUNDLE_FILES.llmCalls, LlmCallsFile],
  ["blocks", BUNDLE_FILES.blocks, BlocksFile],
] as const;

const KNOWN = new Set<string>([...Object.values(BUNDLE_FILES), COUNTRY_PACK_FILE]);

function parseFile<T>(files: BundleFiles, path: string, schema: z.ZodType<T>, p: Problems): T | undefined {
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
  const listed = parseFile(files, BUNDLE_FILES.hashes, HashesFile, p);
  if (!listed) return;
  for (const path of Object.keys(files)) {
    if (path === BUNDLE_FILES.hashes) continue;
    const want = listed.files[path];
    if (!want) p.add(`${path} is not listed in hashes.json`);
    else if (keccak256(fileBytes(files[path] as string | Uint8Array)) !== want) p.add(`${path} does not match its stored hash`);
  }
  for (const path of Object.keys(listed.files)) if (!(path in files)) p.add(`${path} is listed in hashes.json but missing`);
}

/** hashes.json for `files` (every path but hashes.json itself, sorted): what the exporter writes last. */
export function hashesFileOf(files: BundleFiles): string {
  const out: Record<string, string> = {};
  for (const path of Object.keys(files).filter((x) => x !== BUNDLE_FILES.hashes).sort()) out[path] = keccak256(fileBytes(files[path] as string | Uint8Array));
  return `${JSON.stringify({ algorithm: "keccak256", files: out }, null, 2)}\n`;
}

export interface Loaded {
  readonly bundle: ParsedBundle | null;
  readonly checks: VerifyCheck[];
}

export function loadBundle(files: BundleFiles): Loaded {
  const structure = new Problems("bundle files");
  const paths = Object.keys(files);
  if (paths.length > MAX_BUNDLE_FILES) {
    structure.add(`${paths.length} files (more than ${MAX_BUNDLE_FILES})`);
    return { bundle: null, checks: [structure.result("")] };
  }
  for (const path of paths) {
    if (fileBytes(files[path] as string | Uint8Array).length > MAX_FILE_BYTES) structure.add(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
    if (!KNOWN.has(path) && !RECEIPT_PATH_RE.test(path)) structure.add(`unexpected file ${path}`);
  }
  if (!(BUNDLE_FILES.summary in files)) structure.add(`${BUNDLE_FILES.summary} is missing`);
  const out: Record<string, unknown> = {};
  for (const [key, path, schema] of REQUIRED) out[key] = parseFile(files, path, schema as z.ZodType<unknown>, structure);
  const countryPack = COUNTRY_PACK_FILE in files ? parseFile(files, COUNTRY_PACK_FILE, CountryPackFile, structure) : null;
  const receipts = new Map<string, z.infer<typeof RawReceipt>>();
  for (const path of paths) {
    const m = RECEIPT_PATH_RE.exec(path);
    if (!m) continue;
    const receipt = parseFile(files, path, RawReceipt, structure);
    if (!receipt) continue;
    if (receipt.transactionHash.toLowerCase() !== m[1]) structure.add(`${path} holds the receipt of another transaction`);
    else receipts.set(m[1] as string, receipt);
  }
  const parsedCore = out.contracts && out.manifest && out.rows;
  if (parsedCore) for (const problem of explorerProblems(out as unknown as Pick<ParsedBundle, "contracts" | "manifest" | "rows">)) structure.add(problem);
  const hashes = new Problems("file hashes");
  checkHashes(files, hashes);
  const checks = [structure.result(`${paths.length} files, ${receipts.size} receipts`), hashes.result(`${paths.length - 1} files match hashes.json`)];
  if (structure.count > 0) return { bundle: null, checks };
  const bundle = { ...out, countryPack: countryPack ?? null, receipts, paths: new Set(paths) } as unknown as ParsedBundle;
  return { bundle, checks };
}
