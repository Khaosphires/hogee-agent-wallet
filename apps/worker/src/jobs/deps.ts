/** What every job needs. The process entry builds one from env; tests and the loop harness build their own. */
import type { DeploymentManifest, HogeePublicClient } from '@hogee/chain';
import type { Db } from '@hogee/db';
import type { WorkerConfig } from '../config/env';
import type { WorkerSigners } from '../config/keys';
import type { PayoutRail } from '../rail/rail';
import type { PayoutRouter } from '../rail/route';
import type { Logger } from '../runtime/log';

/** A checkpoint inside the tick, after the step has been made durable. */
export type TickStep = 'inserted' | 'signed' | 'broadcast';

export interface JobDeps {
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly signers: WorkerSigners;
  readonly deployment: DeploymentManifest;
  /** `maxSafetyFeeWei` absent = 10 × maxFeeWei (config/env.ts SAFETY_FEE_MULTIPLIER). */
  readonly config: Pick<WorkerConfig, 'maxFeeWei' | 'lowBalanceWei' | 'stuckPendingPasses' | 'payoutMaxAttempts'> & Partial<Pick<WorkerConfig, 'maxSafetyFeeWei'>>;
  readonly log: Logger;
  /**
   * settle-spend's payouts: a PayoutRouter (the process entry: SG_PAYNOW on MockRail, MY_DUITNOW on Xendit test mode
   * when PAYOUT_RAIL=xendit), or one rail the router wraps (rail/route.ts payoutRouterOf). Absent: MockRail.
   */
  readonly rail?: PayoutRail | PayoutRouter;
  /** decisionId source (UUIDv7); injectable for deterministic tests. */
  readonly newDecisionId?: () => string;
  /** Observes durable checkpoints (metrics; the crash tests kill the process here). */
  readonly onStep?: (step: TickStep, paymentId: string) => void | Promise<void>;
}
