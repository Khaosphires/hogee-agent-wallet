/**
 * Storage-layout equality check for Treasury and its delegate-only TreasuryGovernance module (audit run-3).
 *
 * Treasury runs ownerSpend, releaseStage and the loosening queue in TreasuryGovernance by delegatecall, in Treasury's
 * own storage. That is only safe while both contracts lay out storage identically (both inherit TreasuryState and
 * declare no state of their own). This script reads both layouts from `forge inspect <C> storageLayout --json` and
 * compares the ordered (label, slot, offset, type) entries, ignoring astId and contract.
 *
 *   node scripts/check-storage-layout.ts      from the repo root, Node >= 22.18 (type stripping), forge on PATH
 *   pnpm contracts:storage-layout             the same, through the root package.json
 *
 * Exit 0 when the layouts match; 1 with every differing entry otherwise (or when forge output is unreadable).
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts");
const HOST = "Treasury";
const MODULE = "TreasuryGovernance";

interface Entry {
  readonly label: string;
  readonly slot: string;
  readonly offset: number;
  readonly type: string;
}

function isEntry(v: unknown): v is Entry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.label === "string" && typeof e.slot === "string" && typeof e.offset === "number" && typeof e.type === "string";
}

/** The contract's storage entries in slot order, reduced to the compared fields. Throws on unreadable output. */
function layout(contract: string): readonly Entry[] {
  const out = execFileSync("forge", ["inspect", contract, "storageLayout", "--json"], {
    cwd: CONTRACTS_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const parsed: unknown = JSON.parse(out);
  const storage = typeof parsed === "object" && parsed !== null ? (parsed as { storage?: unknown }).storage : undefined;
  if (!Array.isArray(storage) || !storage.every(isEntry)) {
    throw new Error(`forge inspect ${contract} storageLayout: unexpected output shape`);
  }
  return storage.map(({ label, slot, offset, type }) => ({ label, slot, offset, type }));
}

const show = (e: Entry | undefined): string => (e ? `${e.label} slot ${e.slot} offset ${e.offset} ${e.type}` : "(none)");

/** One line per index where the two layouts differ (a missing entry counts as a difference). */
function diffLayouts(host: readonly Entry[], module: readonly Entry[]): readonly string[] {
  const n = Math.max(host.length, module.length);
  const diffs: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = host[i];
    const b = module[i];
    const same = a !== undefined && b !== undefined && a.label === b.label && a.slot === b.slot && a.offset === b.offset && a.type === b.type;
    if (!same) diffs.push(`#${i}: ${HOST} ${show(a)} | ${MODULE} ${show(b)}`);
  }
  return diffs;
}

function main(): number {
  let host: readonly Entry[];
  let module: readonly Entry[];
  try {
    host = layout(HOST);
    module = layout(MODULE);
  } catch (err) {
    console.error(`storage layout check: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (host.length === 0) {
    console.error(`storage layout check: ${HOST} reports no storage; refusing to pass an empty comparison`);
    return 1;
  }
  const diffs = diffLayouts(host, module);
  if (diffs.length > 0) {
    console.error(`storage layout check FAILED: ${HOST} and ${MODULE} differ (${diffs.length} entries)`);
    for (const d of diffs) console.error(`  ${d}`);
    return 1;
  }
  console.log(`storage layout check OK: ${HOST} and ${MODULE} share ${host.length} entries (label, slot, offset, type)`);
  return 0;
}

process.exitCode = main();
