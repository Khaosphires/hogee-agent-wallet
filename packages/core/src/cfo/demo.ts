/**
 * Mei's CFO inputs right after commitPlan (demo/mei.ts numbers): every line full, nothing paid or sold, stage 1
 * released, stage 2 gated on 200,000 minor of sales by day 30. Synthetic demo data for tests and the mock; callers add
 * their own payments and sales on top.
 */
import { MEI_FACILITY, MEI_IDS, MEI_LINES, MEI_PLAN, MEI_STAGES } from "../demo/mei";
import type { CfoInputs, CfoLineIn } from "./types";

const meiLines = (): CfoLineIn[] =>
  MEI_LINES.map((l) => ({
    lineKey: l.lineKey,
    allocatedMinor: BigInt(l.amountMinor),
    spentMinor: 0n,
    escrowedMinor: 0n,
    availableMinor: BigInt(l.amountMinor),
    perTxCapMinor: BigInt(l.perTxCapMinor),
    windowCapMinor: BigInt(l.windowCapMinor),
    committedPerTxCapMinor: BigInt(l.perTxCapMinor),
    committedWindowCapMinor: BigInt(l.windowCapMinor),
    windowSpentMinor: 0n,
    validUntil: BigInt(MEI_PLAN.validUntil),
    ...(l.pacingPerDayMinor ? { pacingMinor: BigInt(l.pacingPerDayMinor) } : {}),
    windowSeconds: BigInt(MEI_PLAN.windowSeconds),
  }));

export function meiCfoInputs(now: Date): CfoInputs {
  const stage1 = MEI_STAGES[0];
  const gate = MEI_STAGES[1]?.gate;
  return {
    currency: MEI_FACILITY.currency,
    now,
    facilityId: MEI_IDS.facilityId,
    lines: meiLines(),
    payments: [],
    sales: [],
    reserve: { rateBps: MEI_PLAN.reserveBps, skimmedMinor: 0n, withdrawnMinor: 0n, taxPayeeId: MEI_IDS.taxPayeeId },
    stage: gate ? { stageId: MEI_IDS.stage2Id, targetMinor: BigInt(gate.target), deadline: new Date(Number(gate.deadline) * 1000) } : null,
    reserveBps: MEI_PLAN.reserveBps,
    agentActions: [],
    releasedMinor: BigInt(stage1?.releaseMinor ?? "0"),
  };
}
