/**
 * The adapter between the Proof page and fisco-anchor's `checkSepoliaAnchor` (@hogee/verify-evidence/fisco, anchor.ts):
 *
 *   checkSepoliaAnchor(files: BundleFiles, sidecar: Uint8Array | string | null, opts?): AnchorResult
 *   AnchorResult = VerifyCheck & { anchored: boolean; anchor: AnchorFacts | null }   // sync, never throws
 *
 * It lands through a hook P1 applies to the verifier's index.ts, so it is looked up by name on the module at run time:
 * until it is there, the anchor reads "not available here" and is never a pass. Whatever it returns is re-checked for
 * shape here (a malformed result is a failure), and only the three facts the page shows are kept; the Etherscan URL
 * is rebuilt from the pinned explorer (fisco-model.ts anchorView), never taken from the result.
 */
import * as fisco from "@hogee/verify-evidence/fisco";
import type { BundleFiles } from "@hogee/verify-evidence";
import type { AnchorCheck } from "./fisco-model";

/** checkSepoliaAnchor as the adapter calls it (sidecar null: no sidecar served). */
export type AnchorChecker = (files: BundleFiles, sidecar: Uint8Array | null) => unknown;

/** The verifier's export name (a string, so the build never resolves a missing export statically). */
const CHECKER = "checkSepoliaAnchor";

/** The verifier's anchor check, or null when this build's verifier has none. */
export function anchorCheckerOf(mod: Readonly<Record<string, unknown>> = fisco as unknown as Readonly<Record<string, unknown>>): AnchorChecker | null {
  const fn = mod[CHECKER];
  return typeof fn === "function" ? (fn as AnchorChecker) : null;
}

const HASH = /^0x[0-9a-f]{64}$/;
const isUint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

const failed = (detail: string): AnchorCheck => ({ available: true, ok: false, anchored: false, anchor: null, detail });

/** Runs the anchor check on the pack's bytes and the sidecar's (null when the API has none). Never throws. */
export function checkAnchor(files: BundleFiles, sidecar: Uint8Array | null, checker: AnchorChecker | null = anchorCheckerOf()): AnchorCheck {
  if (!checker) return { available: false, ok: false, anchored: false, anchor: null, detail: "this build's verifier has no Sepolia timestamp check" };
  let raw: unknown;
  try {
    raw = checker(files, sidecar);
  } catch {
    return failed("the Sepolia timestamp check stopped with an error");
  }
  if (typeof raw !== "object" || raw === null) return failed("the Sepolia timestamp check gave no result");
  const r = raw as { ok?: unknown; anchored?: unknown; anchor?: unknown; detail?: unknown };
  const detail = typeof r.detail === "string" ? r.detail : "";
  if (r.ok !== true) return failed(detail || "the Sepolia timestamp does not check");
  if (r.anchored !== true) return { available: true, ok: true, anchored: false, anchor: null, detail };
  // An anchor needs a sidecar: a result that claims one without it is a checker fault, never a timestamp.
  if (sidecar === null) return failed("the Sepolia timestamp check reported an anchor, but no sidecar was served");
  const a = (r.anchor ?? null) as { txHash?: unknown; blockNumber?: unknown; timestamp?: unknown } | null;
  if (!a || typeof a.txHash !== "string" || !HASH.test(a.txHash) || !isUint(a.blockNumber) || !isUint(a.timestamp)) return failed("the Sepolia timestamp check gave an unreadable result");
  return { available: true, ok: true, anchored: true, anchor: { txHash: a.txHash, blockNumber: a.blockNumber, timestamp: a.timestamp }, detail };
}
