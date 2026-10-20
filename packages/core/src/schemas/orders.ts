/**
 * Supplier terms the founder reports in chat and confirms in a REST form (VISION-DECISIONS §3, §9). The payout account
 * arrives ONLY through POST /api/orders/terms (never from chat, listing text or a model); the server fixes its channel
 * (MOCK_ONLY, "simulated payout"), hashes it, and the founder signs the schedule in SupplierApproval.
 */
import { z } from "zod";
import {
  MilestoneTrigger,
  PayeeType,
  SupplierOrigin,
  TermsErrorCode,
  TermsPreset,
  TermsStatus,
  type MilestoneTrigger as MilestoneTriggerT,
  type TermsPreset as TermsPresetT,
} from "./enums";
import { Bps, CurrencyCode, Hex32, Id, IsoDateTime, Minor, OrderId, PosInt, SupplierId, Uint8 } from "./primitives";
import { isWebSupplierId } from "./supplier";

/** Founder-facing label of each trigger (core-terms imports these; web shows them). */
export const MILESTONE_LABELS: { readonly [T in MilestoneTriggerT]: string } = Object.freeze({
  ON_ORDER: "Deposit on order",
  ON_SAMPLE_OK: "After sample approval",
  ON_SHIPMENT: "On shipment",
  ON_DELIVERY_INSPECTED: "Balance after delivery check",
});

/** The milestones of each preset, in basis points of the total (each sums to 10000). */
const presetMilestone = (bps: number, trigger: MilestoneTriggerT) => Object.freeze({ bps, trigger });
export const TERMS_PRESET_MILESTONES: { readonly [P in TermsPresetT]: readonly { readonly bps: number; readonly trigger: MilestoneTriggerT }[] } = Object.freeze({
  P30_70: Object.freeze([presetMilestone(3000, "ON_ORDER"), presetMilestone(7000, "ON_DELIVERY_INSPECTED")]),
  P50_50: Object.freeze([presetMilestone(5000, "ON_ORDER"), presetMilestone(5000, "ON_DELIVERY_INSPECTED")]),
  P0_100: Object.freeze([presetMilestone(10_000, "ON_DELIVERY_INSPECTED")]),
  P30_40_30: Object.freeze([
    presetMilestone(3000, "ON_ORDER"),
    presetMilestone(4000, "ON_SHIPMENT"),
    presetMilestone(3000, "ON_DELIVERY_INSPECTED"),
  ]),
});

export const MilestoneInput = z.strictObject({ bps: Bps.min(1), trigger: MilestoneTrigger });
export type MilestoneInput = z.infer<typeof MilestoneInput>;

/** Printable text without surrounding whitespace (names typed into the terms form). */
const FormText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/, "must not contain control characters")
    .regex(/^\S(?:[\s\S]*\S)?$/, "must not start or end with whitespace");

/**
 * What a name the founder signs over must not contain (run-9): controls (C0 and C1), format characters (bidi, zero-width),
 * other default-ignorable code points, line and paragraph separators, lone surrogates (\p{Cs} in a /u pattern matches
 * only an unpaired half: RFC 8785 JCS cannot encode one, so a confirm would fail with a 500, not a 422) and letters that
 * render blank (the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 and the Braille blank U+2800). Listed numerically on
 * purpose (no invisible characters in source).
 */
const UNPLAIN_NAME_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}ᅟᅠㅤﾠ⠀]/u;

/** True for a name that renders as what it says: see UNPLAIN_NAME_RE. */
export const isPlainName = (name: string): boolean => !UNPLAIN_NAME_RE.test(name);

/** FormText that is also a plain name (the holder and bank shown in the signing panel). */
const PlainName = (min: number, max: number) =>
  FormText(min, max).refine(isPlainName, "must not contain control, format, line-break or blank-filler characters");

/** Typed by the founder in the terms form. A personal payee is refused by the API (TERMS_PAYEE_PERSONAL). */
export const PayoutAccountInput = z.strictObject({
  holderName: PlainName(2, 120),
  bankName: PlainName(2, 80),
  accountNumber: z.string().regex(/^[0-9]{6,20}$/, "must be 6-20 digits"),
  payeeType: PayeeType,
});
export type PayoutAccountInput = z.infer<typeof PayoutAccountInput>;

/** POST /api/orders/terms. */
export const OrderTermsInput = z.strictObject({
  supplierId: SupplierId,
  searchId: Id,
  quantity: PosInt,
  totalMinor: Minor,
  milestones: z.array(MilestoneInput).min(1).max(8),
  payout: PayoutAccountInput,
});
export type OrderTermsInput = z.infer<typeof OrderTermsInput>;

/** One row of the computed schedule (amounts by core termsToSchedule; release state mirrored from the chain). */
export const ScheduleRow = z.strictObject({
  idx: Uint8,
  trigger: MilestoneTrigger,
  label: z.string().min(1).max(60),
  amountMinor: Minor,
  autoRelease: z.boolean(),
  released: z.boolean(),
  txHash: Hex32.nullable(),
});
export type ScheduleRow = z.infer<typeof ScheduleRow>;

/** POST /api/orders/terms and GET /api/orders/terms/:id. `orderId` is set exactly when the terms are USED. */
export const OrderTerms = z
  .strictObject({
    termsId: Id,
    status: TermsStatus,
    supplierId: SupplierId,
    displayName: z.string().min(1).max(120),
    origin: SupplierOrigin,
    currency: CurrencyCode,
    totalMinor: Minor,
    quantity: PosInt,
    milestones: z.array(MilestoneInput).min(1).max(8),
    schedule: z.array(ScheduleRow).min(1).max(8),
    payoutAccountHash: Hex32,
    holderName: z.string().min(2).max(120),
    orderId: OrderId.nullable(),
    coolingEndsAt: IsoDateTime.nullable(),
    // The Treasury.bindPayee transaction the founder's SupplierApproval sent, once it has landed: the order card's seal.
    bindTxHash: Hex32.nullable(),
    createdAt: IsoDateTime,
  })
  .refine((t) => (t.status === "USED") === (t.orderId !== null), { message: "orderId is set exactly when the terms are USED", path: ["orderId"] })
  .refine((t) => t.bindTxHash === null || t.status === "USED", { message: "only USED terms have a bindPayee transaction", path: ["bindTxHash"] })
  .refine((t) => t.schedule.length === t.milestones.length, { message: "one schedule row per milestone", path: ["schedule"] });
export type OrderTerms = z.infer<typeof OrderTerms>;

/** The data-terms chat part: what the terms card pre-fills. A preset that breaks a cap is shown greyed with its code. */
export const TermsPrefill = z
  .strictObject({
    supplierId: SupplierId,
    // The READY web search the supplier was picked from (submitOrderTerms needs it); null only for a catalog supplier.
    searchId: Id.nullable(),
    milestones: z.array(MilestoneInput).min(1).max(8).nullable(),
    preset: TermsPreset.nullable(),
    source: z.enum(["preset", "founder_text", "none"]),
    question: z.literal("DEPOSIT_TRIGGER").nullable(),
    presetAvailability: z
      .array(
        z
          .strictObject({ preset: TermsPreset, ok: z.boolean(), code: TermsErrorCode.nullable() })
          .refine((p) => p.ok === (p.code === null), { message: "code is set exactly when the preset is not ok", path: ["code"] }),
      )
      .max(4),
  })
  // founder_text may leave milestones null while it asks the one clarifying question.
  .refine((p) => p.source !== "none" || (p.milestones === null && p.preset === null), { message: "nothing is pre-filled when source is none", path: ["milestones"] })
  .refine((p) => p.source !== "preset" || (p.preset !== null && p.milestones !== null), { message: "a preset pre-fill names its preset and milestones", path: ["preset"] })
  .refine((p) => p.searchId !== null || !isWebSupplierId(p.supplierId), { message: "a web supplier's pre-fill names its search", path: ["searchId"] });
export type TermsPrefill = z.infer<typeof TermsPrefill>;
