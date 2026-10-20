/**
 * The "Sepolia timestamp" line(s) of `verify-fisco` (./cli.ts calls these through a few hook lines):
 *   - `anchorLine`: the sidecar is read from <pack>/../anchors/<packId>.sepolia.json (./anchor-file.ts, no link
 *     followed) and checked offline; no sidecar is "not anchored", which passes unless `--require-anchor` is given;
 *   - `onlineAnchorLines`: with `--anchor-rpc <url>` (or HOGEE_ANCHOR_RPC), one more line confirms the tx and block on
 *     a Sepolia node (./anchor-online.ts); asking for it with no sidecar fails (nothing to confirm). It runs before
 *     the synchronous `main` (the CLI entry awaits it and passes the lines in), so `main` stays synchronous.
 * The sidecar is read once per command line: the online line keeps what it read under that argv array (the one the
 * entry then passes to `main`), and the offline line checks exactly those bytes, so a file swapped between the two
 * reads cannot have one sidecar confirmed online and another checked offline. The URL is never printed.
 */
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { BundleFiles } from "../load";
import type { VerifyCheck } from "../util";
import { ANCHOR_CHECK, checkSepoliaAnchor } from "./anchor";
import { anchorPathOf, readAnchorFile, type AnchorRead } from "./anchor-file";
import { ANCHOR_ONLINE_CHECK, ANCHOR_RPC_ENV, confirmSepoliaAnchor, type AnchorFetch } from "./anchor-online";
import { PACK_DIR_RE } from "./pack";

export const ANCHOR_VALUE_FLAGS = ["--anchor-rpc"] as const;
export const ANCHOR_BOOL_FLAGS: readonly string[] = ["--require-anchor"];
export const ANCHOR_USAGE = "[--require-anchor] [--anchor-rpc <url>]";

export interface AnchorCliOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: AnchorFetch;
  /** The test suite only (no flag or env var sets it): the signer to require instead of ANCHOR_SIGNER. */
  readonly signer?: string;
}

const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v === undefined || v.startsWith("--") ? undefined : v;
};

/** The packId to find the sidecar by: pack.json's, else the folder's name (the folder must be named after it). */
const idOf = (dir: string, packId: string | null): string | null => {
  const id = packId ?? basename(dir);
  return PACK_DIR_RE.test(id) ? id : null;
};

/** What onlineAnchorLines read, by the command line (argv array) it read it for. */
const readFor = new WeakMap<readonly string[], AnchorRead>();

/** The sidecar at `path`: the bytes this command line's online line already read, else a fresh read. */
const sidecarAt = (argv: readonly string[], path: string): AnchorRead => {
  const earlier = readFor.get(argv);
  return earlier !== undefined && earlier.path === path ? earlier : readAnchorFile(path);
};

/** The offline line (synchronous): not anchored, anchored and checked, or a refused sidecar. */
export function anchorLine(dir: string, files: BundleFiles, packId: string | null, argv: readonly string[], o: AnchorCliOptions = {}): VerifyCheck {
  const id = idOf(dir, packId);
  if (id === null) return { name: ANCHOR_CHECK, ok: false, detail: "not run: no packId to find the sidecar by" };
  const read = sidecarAt(argv, anchorPathOf(dir, id));
  if (read.kind === "refused") return { name: ANCHOR_CHECK, ok: false, detail: `${id}.sepolia.json: ${read.reason}` };
  const r = checkSepoliaAnchor(files, read.kind === "bytes" ? read.bytes : null, { required: argv.includes("--require-anchor"), ...(o.signer ? { signer: o.signer } : {}) });
  return { name: r.name, ok: r.ok, ...(r.detail === undefined ? {} : { detail: r.detail }) };
}

/**
 * The online line, when asked for (else none). The pack folder is argv's one positional argument (not a value of
 * `valueFlags`); a bad command line yields no line here (main refuses it).
 */
export async function onlineAnchorLines(argv: readonly string[], valueFlags: ReadonlySet<string>, o: AnchorCliOptions = {}): Promise<VerifyCheck[]> {
  const env = o.env ?? process.env;
  const fromEnv = env[ANCHOR_RPC_ENV];
  const rpc = flag(argv, "--anchor-rpc") ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined);
  if (rpc === undefined) return [];
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.has(argv[i - 1] ?? ""));
  if (positional.length !== 1 || !existsSync(resolve(positional[0] as string))) return [];
  const dir = resolve(positional[0] as string);
  const line = (detail: string): VerifyCheck[] => [{ name: ANCHOR_ONLINE_CHECK, ok: false, detail }];
  const id = idOf(dir, null);
  if (id === null) return line("not run: the pack folder is not named after a packId");
  const read = readAnchorFile(anchorPathOf(dir, id));
  readFor.set(argv, read);
  if (read.kind === "missing") return line("nothing to confirm: the pack is not anchored");
  if (read.kind === "refused") return line(`not run: ${read.reason}`);
  return [await confirmSepoliaAnchor(read.bytes, rpc, o.fetch ? { fetch: o.fetch } : {})];
}
