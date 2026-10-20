/**
 * The final-2 Sepolia run the mirror replays (evidence/ev-74756ea61a72ae7c), read from disk and checked before use:
 * every raw signed tx must hash to its row's txHash and be a Sepolia (11155111) tx to a final-2 contract. The replay
 * takes its arguments from these bytes (the plan manifest, the SupplierApproval, the milestone amounts, the settlement
 * ids) so the mirror cannot drift from what Sepolia ran. Fail closed on anything unexpected.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { hashObject, PlanManifest } from "@hogee/core";
import { getAddress, keccak256, parseTransaction, type Hex } from "viem";
import type { SepoliaMirror } from "../../../../tools/verify-evidence/src/fisco/catalogue";
import { FINAL_2 } from "../../../../tools/verify-evidence/src/fisco/pack";

export class SourceError extends Error {
  override readonly name = "SourceError";
}

export interface SepoliaTx {
  /** chain-actions kind (`Treasury.bindPayee`) or payments kind (`FUND_MILESTONE`). */
  readonly kind: string;
  readonly milestoneIdx: number | null;
  readonly hash: Hex;
  readonly raw: Hex;
  readonly to: Hex;
  readonly data: Hex;
}

export const SEPOLIA_CONTRACT_NAMES = ["PlanRegistry", "Treasury", "MilestoneEscrow", "SalesOracle"] as const;

export interface SepoliaSource {
  /** Every file of the bundle by its path relative to the bundle folder ("/" separators), as read. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly manifest: PlanManifest;
  readonly planHash: Hex;
  readonly contracts: Readonly<Record<(typeof SEPOLIA_CONTRACT_NAMES)[number], Hex>>;
  /** signatures.json entries, verbatim (parsed JSON). */
  readonly signatures: readonly Record<string, unknown>[];
  readonly actions: readonly SepoliaTx[];
  readonly payments: readonly SepoliaTx[];
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function json(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
  if (!bytes) throw new SourceError(`the source bundle has no ${path}`);
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new SourceError(`${path} is not JSON`);
  }
}

const HASH_RE = /^0x[0-9a-f]{64}$/;
const RAW_RE = /^0x([0-9a-f]{2})+$/;

/** A row's raw signed tx, checked: keccak256(raw) = txHash, Sepolia chain id, sent to one of `addresses`. */
function signedTx(kind: string, milestoneIdx: number | null, hash: unknown, raw: unknown, addresses: ReadonlySet<string>): SepoliaTx {
  if (typeof hash !== "string" || !HASH_RE.test(hash) || typeof raw !== "string" || !RAW_RE.test(raw)) throw new SourceError(`${kind}: the row has no tx hash or raw signed tx`);
  if (keccak256(raw as Hex) !== hash) throw new SourceError(`${kind} ${hash}: keccak256(rawSignedTx) is not the tx hash`);
  const tx = parseTransaction(raw as Hex);
  if (tx.chainId !== FINAL_2.chainId) throw new SourceError(`${kind} ${hash}: not a Sepolia tx`);
  const to = tx.to?.toLowerCase();
  if (!to || !addresses.has(to)) throw new SourceError(`${kind} ${hash}: not sent to a final-2 contract`);
  return { kind, milestoneIdx, hash: hash as Hex, raw: raw as Hex, to: to as Hex, data: (tx.data ?? "0x") as Hex };
}

function readContracts(files: ReadonlyMap<string, Uint8Array>): SepoliaSource["contracts"] {
  const c = json(files, "contracts.json");
  if (!isRecord(c) || c.runId !== FINAL_2.runId || c.deploymentId !== FINAL_2.deploymentId || c.chainId !== FINAL_2.chainId || c.chainTag !== FINAL_2.chainTag || !isRecord(c.contracts)) {
    throw new SourceError(`contracts.json is not the ${FINAL_2.runId} ${FINAL_2.deploymentId} Sepolia bundle`);
  }
  const contracts = c.contracts;
  const entries = SEPOLIA_CONTRACT_NAMES.map((name) => {
    const e = contracts[name];
    const address = isRecord(e) ? e.address : undefined;
    if (typeof address !== "string") throw new SourceError(`contracts.json has no ${name}`);
    return [name, getAddress(address).toLowerCase() as Hex] as const;
  });
  return Object.fromEntries(entries) as unknown as SepoliaSource["contracts"];
}

/** Reads and checks the source bundle folder. */
export function readSepoliaBundle(dir: string): SepoliaSource {
  const files = new Map(listFiles(dir).map((p) => [relative(dir, p).split(sep).join("/"), new Uint8Array(readFileSync(p))]));
  const contracts = readContracts(files);
  const addresses = new Set(Object.values(contracts));
  const plans = json(files, "plans.json");
  const committed = Array.isArray(plans) ? plans.filter((p) => isRecord(p) && p.status === "COMMITTED" && p.version === 1) : [];
  const plan = committed[0];
  if (committed.length !== 1 || !isRecord(plan)) throw new SourceError("plans.json must hold exactly one committed v1 plan");
  const manifest = PlanManifest.parse(plan.manifest);
  const planHash = hashObject(manifest) as Hex;
  if (planHash !== plan.planHash) throw new SourceError("plans.json: planHash is not keccak256(JCS(manifest))");
  const signatures = json(files, "signatures.json");
  if (!Array.isArray(signatures) || !signatures.every(isRecord)) throw new SourceError("signatures.json is not a list");
  const actionRows = json(files, "chain-actions.json");
  const paymentRows = json(files, "payments.json");
  if (!Array.isArray(actionRows) || !Array.isArray(paymentRows)) throw new SourceError("chain-actions.json / payments.json are not lists");
  const actions = actionRows.filter(isRecord).map((r) => signedTx(String(r.kind), null, r.txHash, r.rawSignedTx, addresses));
  const payments = paymentRows.filter(isRecord).map((r) => {
    const p = isRecord(r.payment) ? r.payment : {};
    const idx = typeof r.milestoneIdx === "number" ? r.milestoneIdx : null;
    return signedTx(String(p.kind), idx, p.txHash, r.rawSignedTx, addresses);
  });
  return { files, manifest, planHash, contracts, signatures: signatures as Record<string, unknown>[], actions, payments };
}

/** The final-2 tx a catalogue step mirrors (catalogue `sepolia` spec). */
export function findSepoliaTx(src: SepoliaSource, spec: SepoliaMirror): SepoliaTx {
  const rows = spec.source === "action" ? src.actions.filter((a) => a.kind === spec.kind) : src.payments.filter((p) => p.kind === spec.kind && p.milestoneIdx === spec.milestoneIdx);
  const row = rows[spec.nth ?? 0];
  if (!row) throw new SourceError(`the source bundle has no ${spec.source} ${spec.kind}${spec.milestoneIdx === undefined ? "" : ` #${spec.milestoneIdx}`}${spec.nth === undefined ? "" : ` (nth ${spec.nth})`}`);
  if (spec.nth === undefined && rows.length !== 1) throw new SourceError(`the source bundle has ${rows.length} ${spec.kind} rows; the spec needs exactly one`);
  return row;
}

/** The final-2 MilestoneRelease signature entry (verbatim), the one T28a's calldata carries. */
export function milestoneReleaseSignature(src: SepoliaSource): Record<string, unknown> {
  const all = src.signatures.filter((s) => s.kind === "MilestoneRelease");
  const entry = all[0];
  if (all.length !== 1 || !entry) throw new SourceError(`signatures.json holds ${all.length} MilestoneRelease entries; T28 needs exactly one`);
  return entry;
}

/** keccak256 of every bundle file, for pack.json sourceBundle.files. */
export function bundleFileHashes(src: SepoliaSource): Record<string, Hex> {
  return Object.fromEntries([...src.files.keys()].sort().map((p) => [p, keccak256(src.files.get(p) as Uint8Array)]));
}
