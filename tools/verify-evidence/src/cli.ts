/**
 * `make verify` / `pnpm --filter @hogee/verify-evidence verify [<bundle dir>] [--root <evidence dir>] [--json]
 * [--rpc <url>]`: verifies one bundle offline (no network) and exits 0 when every check passes, 1 on any mismatch, 2
 * when there is no bundle to verify or the RPC URL is refused. Without a directory it picks the latest finished bundle
 * under the evidence root (default: evidence/ at the repo root): the run whose contracts.json says it was exported last.
 * It prints the anchor (contracts, newest block, tx hashes) and says plainly that VERIFIED means internally
 * consistent: chain truth comes from comparing the anchor with Sepolia Etherscan, or from an RPC node, which
 * re-fetches every receipt and block and compares them. Give the node in the environment, `HOGEE_VERIFY_RPC=<url>`
 * (recommended: argv is visible to every local user in `ps`), or with `--rpc <url>`, which wins when both are set.
 * The URL is parsed before anything else and never printed (run-6 re-check L3).
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anchorLines } from "./anchor";
import { verifyBundle } from "./index";
import { parseRpcUrl, RPC_URL_REFUSAL, verifyOnline } from "./online";
import { readBundleDir } from "./read-dir";
import type { VerifyCheck } from "./util";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VALUE_FLAGS = new Set(["--root", "--rpc"]);
/** What the online comparison does not prove (run-6 re-check L4): a forger's own contracts on Sepolia have code too. */
export const ONLINE_LIMIT = "It does not prove these contracts are Hogee's deployment: compare the contract addresses above with the announced deployment.";
/** The RPC node for the online comparison, read from the environment (argv is visible in `ps`). */
export const RPC_ENV = "HOGEE_VERIFY_RPC";

export const MEANING =
  "VERIFIED means the bundle is internally consistent (files, digests, signatures, commitments, calldata, events and plan rules agree). " +
  `It does not prove the chain holds it: compare the anchor above with Sepolia Etherscan, or run again with an RPC node (${RPC_ENV}=<url> make verify; --rpc <url> also works).`;

function exportedAt(dir: string): string {
  try {
    const st = lstatSync(join(dir, "contracts.json"));
    if (!st.isFile() || st.size > 64 * 1024) return "";
    const json = JSON.parse(readFileSync(join(dir, "contracts.json"), "utf8")) as { exportedAt?: unknown };
    return typeof json.exportedAt === "string" ? json.exportedAt : "";
  } catch {
    return "";
  }
}

/** The newest finished bundle under `root` (temporary `.export-*` folders are skipped). */
export function latestBundle(root: string): string | null {
  if (!existsSync(root)) return null;
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && RUN_ID_RE.test(e.name))
    .map((e) => ({ dir: join(root, e.name), at: exportedAt(join(root, e.name)) }))
    .filter((r) => r.at !== "")
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return runs[0]?.dir ?? null;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

type Print = (line: string) => void;

function report(print: Print, json: boolean, dir: string, checks: readonly VerifyCheck[], anchor: ReturnType<typeof verifyBundle>["anchor"], ok: boolean, online: boolean): number {
  if (json) {
    print(JSON.stringify({ bundle: dir, ok, online, checks, anchor, meaning: MEANING }, null, 2));
    return ok ? 0 : 1;
  }
  print(`verify-evidence ${dir}`);
  for (const c of checks) print(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (anchor) for (const line of anchorLines(anchor)) print(line);
  if (!ok) print("NOT VERIFIED: at least one check failed");
  else if (online) print(`VERIFIED: every check passed, and the RPC node serves the same receipts and blocks. ${ONLINE_LIMIT}`);
  else print(`VERIFIED: every check passed. ${MEANING}`);
  return ok ? 0 : 1;
}

/** Exit code; a Promise only with an RPC node (the online comparison needs the network). */
export function main(
  argv: readonly string[],
  print: Print = (l) => process.stdout.write(`${l}\n`),
  fetchImpl?: Parameters<typeof verifyOnline>[2],
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | Promise<number> {
  const json = argv.includes("--json");
  const rootArg = flag(argv, "root");
  if (argv.includes("--rpc") && !flag(argv, "rpc")) {
    print("verify-evidence: --rpc needs a URL");
    return 2;
  }
  const rpc = flag(argv, "rpc") ?? (env[RPC_ENV] || undefined);
  // Parsed before any bundle is read; refused with fixed text, so the URL is never echoed.
  if (rpc !== undefined && !parseRpcUrl(rpc)) {
    print(`verify-evidence: ${RPC_URL_REFUSAL}`);
    return 2;
  }
  const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));
  const dir = positional[0] ? resolve(positional[0]) : latestBundle(resolve(rootArg ?? join(REPO_ROOT, "evidence")));
  if (!dir) {
    print("verify-evidence: no evidence bundle found (run `make evidence` first)");
    return 2;
  }
  const { files, refused } = readBundleDir(dir);
  const result = verifyBundle(files);
  const checks = [...result.checks, ...(refused.length > 0 ? [{ name: "bundle files on disk", ok: false, detail: refused.slice(0, 4).join("; ") }] : [])];
  const ok = result.ok && refused.length === 0;
  if (rpc === undefined) return report(print, json, dir, checks, result.anchor, ok, false);
  return verifyOnline(files, rpc, fetchImpl).then((online) => report(print, json, dir, [...checks, online], result.anchor, ok && online.ok, true));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main(process.argv.slice(2));
  process.exitCode = typeof code === "number" ? code : await code;
}
