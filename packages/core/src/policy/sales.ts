/**
 * `SalesOracle.recordSale`, as the ORACLE sends it (the agent key gets NotOracle: DIRECT_CALL_REVERT.recordSale).
 * Rows after the caller check, in order: the sale is not recorded yet (DuplicateSale, T23), then Treasury.creditRevenue
 * needs a committed plan (StalePlan: before the first plan there is no reserveBps to skim). A zero-amount bucket is
 * recorded (it counts as an order for METRIC_ORDERS and skims 0), and recording is allowed while paused.
 */
import type { Hex32 } from "../schemas/primitives";
import { allow, deny } from "./state";
import type { PolicyDecision } from "./types";

export interface RecordSaleState {
  /** PlanRegistry.planVersion(): 0 = no plan committed yet. */
  readonly planVersion: number;
  /** saleIdHashes already recorded (SalesOracle.isSaleRecorded), lowercase. */
  readonly recordedSales: ReadonlySet<string>;
}

/** AUTO when the oracle's recordSale(saleIdHash, bucket) would succeed; else DENY with the revert it would get. */
export function evaluateRecordSale(saleIdHash: Hex32, state: RecordSaleState): PolicyDecision {
  if (state.recordedSales.has(saleIdHash.toLowerCase())) return deny("DuplicateSale");
  if (state.planVersion === 0) return deny("StalePlan");
  return allow("SALE_RECORDABLE");
}
