/**
 * What the WEB world's cases share: the ports the red team controls (run-web.ts builds them before the world's API
 * exists), the labelled recorded sample, and the journey state one case leaves for the next (the search, the order).
 */
import type { ChatAction, OrderTerms, SupplierSearch } from "@hogee/core";
import type { RecordedFixture } from "./fixtures";
import type { Egress, RecordingPort, WebChecksControl } from "./ports";

export interface WebRun {
  /** deps.webSearch of the world: the recorded provider, every query recorded. */
  readonly port: RecordingPort;
  /** deps.checks' sanctions screening: a list the case can extend, and an "unavailable" switch. */
  readonly checks: WebChecksControl;
  readonly fixture: RecordedFixture;
  /** fetch() hosts since the world started (only the RPC host is allowed). */
  readonly egress: Egress;
  /** host:port of the Anvil RPC (viem's own fetches). */
  readonly rpcHost: string;
  /** The READY search the founder picks from (S3). */
  search?: SupplierSearch;
  /** The founder's web order (S3): its confirmed terms, then the order once bound. */
  order?: OrderTerms;
  /** The SupplierApproval request of the order (T16 replays it). */
  orderRequestId?: string;
  /** Chat session of the founder's journey (S2, S3). */
  readonly sessionId: string;
  /** Actions already answered in that session (T7 replays them with the same actionId). */
  readonly answered: ChatAction[];
}
