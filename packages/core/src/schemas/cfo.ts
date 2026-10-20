/**
 * The AI CFO report (VISION-DECISIONS §3): cash-basis spending, sales, P&L, forecast and tax reserve, computed by core
 * buildCfoReport from the facility's own records. Forecasts state their method and sample size; nothing is invented
 * (null where the sample is too small). The CFO acts only by tightening through the existing evaluateTighten path.
 */
import { z } from "zod";
import { CfoInsightKind, LineKey } from "./enums";
import { Bps, CurrencyCode, DigitString, Hex32, Id, IsoDate, IsoDateTime, Minor, NonNegInt, PayeeId, SignedMinor, StageId } from "./primitives";
import { TIGHTEN_ACTIONS } from "../policy/types";

export const CFO_DISCLAIMER = "Estimates from your own records. Not financial advice." as const;

/** An in-app link (a path on this site), never an absolute or protocol URL. */
const AppHref = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[A-Za-z0-9/_.?=&%-]*(#[A-Za-z0-9_-]+)?$/, "must be an in-app path starting with a single / (an optional #fragment)");

export const CfoInsight = z.strictObject({
  insightId: Id,
  kind: CfoInsightKind,
  severity: z.enum(["info", "warn"]),
  title: z.string().min(1).max(80),
  detail: z.string().min(1).max(280),
  lineKey: LineKey.nullable(),
  suggestion: z
    .strictObject({
      kind: z.enum(["TIGHTEN", "REQUEST_MOVE", "REQUEST_STAGE_RELEASE"]),
      href: AppHref.nullable(),
    })
    .nullable(),
});
export type CfoInsight = z.infer<typeof CfoInsight>;

/** A tightening the agent made on its own (core policy TIGHTEN_ACTIONS), with its trace reason and tx. */
export const CfoAgentAction = z.strictObject({
  at: IsoDateTime,
  action: z.enum(TIGHTEN_ACTIONS),
  lineKey: LineKey.nullable(),
  newValue: DigitString.describe("The new cap (minor units) or reserve rate (bps); 0 where the action has no value"),
  reason: z.string().min(1).max(200),
  txHash: Hex32.nullable(),
});
export type CfoAgentAction = z.infer<typeof CfoAgentAction>;

const DailySpent = z.strictObject({ date: IsoDate, spentMinor: Minor });
const DailyRevenue = z.strictObject({ date: IsoDate, revenueMinor: Minor, count: NonNegInt });

export const CfoReport = z.strictObject({
  asOf: IsoDateTime,
  currency: CurrencyCode,
  facilityId: Id,
  overview: z.strictObject({
    cashAvailableMinor: Minor,
    spentMinor: Minor,
    revenueMinor: Minor,
    reserveMinor: Minor,
    netMinor: SignedMinor,
  }),
  spending: z.strictObject({
    byLine: z.array(
      z.strictObject({ lineKey: LineKey, allocatedMinor: Minor, spentMinor: Minor, escrowedMinor: Minor, availableMinor: Minor }),
    ),
    daily: z.array(DailySpent).max(30),
  }),
  sales: z.strictObject({
    count: NonNegInt,
    revenueMinor: Minor,
    averageMinor: Minor,
    daily: z.array(DailyRevenue).max(30),
    recent: z.array(z.strictObject({ saleId: Id, amountMinor: Minor, at: IsoDateTime, txHash: Hex32.nullable() })).max(20),
    stageGate: z
      .strictObject({ stageId: StageId, targetMinor: Minor, soFarMinor: Minor, deadline: IsoDate, projectedDate: IsoDate.nullable() })
      .nullable(),
  }),
  pnl: z.strictObject({
    from: IsoDate,
    to: IsoDate,
    revenueMinor: Minor,
    supplierCostMinor: Minor,
    operatingByLine: z.array(z.strictObject({ lineKey: LineKey, amountMinor: Minor })),
    operatingMinor: Minor,
    netMinor: SignedMinor,
    reserveSetAsideMinor: Minor,
    basis: z.literal("cash"),
  }),
  forecast: z.strictObject({
    method: z.literal("MA7_LINEAR"),
    sampleDays: NonNegInt,
    dailyBurnMinor: Minor,
    dailyRevenueMinor: Minor,
    runwayDays: NonNegInt.nullable(),
    stage2Date: IsoDate.nullable(),
    reserveIn30dMinor: Minor,
    points: z.array(z.strictObject({ date: IsoDate, cashMinor: SignedMinor })).max(30),
  }),
  reserve: z.strictObject({
    rateBps: Bps,
    skimmedMinor: Minor,
    withdrawnMinor: Minor,
    balanceMinor: Minor,
    taxPayeeId: PayeeId,
    salesCount: NonNegInt,
  }),
  insights: z.array(CfoInsight).max(8),
  agentActions: z.array(CfoAgentAction).max(10),
  disclaimer: z.literal(CFO_DISCLAIMER),
});
export type CfoReport = z.infer<typeof CfoReport>;
