/**
 * The chat journey (VISION-DECISIONS §3). Buttons send a ChatAction (structured, single-use `actionId`, no free text):
 * actions skip the model and redaction but not the rate limit. Free text is classified into one SkillCall. Live and
 * mock build the same JourneyFacts; core deriveJourney turns them into a stage.
 */
import { z } from "zod";
import { CfoView, JourneyStage, Persona, PlanStatus, SearchStatus, SignatureKind, Skill, SupplierOrigin, TermsPreset, TermsStatus } from "./enums";
import { Id, IsoDateTime, OrderId, PosInt, SupplierId, UuidV7 } from "./primitives";

/** Single use per chat session: a replay is answered "already done, here is where you are". */
export const ActionId = UuidV7.describe("Chat action id (UUIDv7, single use per session)");
export type ActionId = z.infer<typeof ActionId>;

const SupplierIds = z
  .array(SupplierId)
  .min(1)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, "supplier ids must be unique");

export const ChatAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start_search"), actionId: ActionId, quantity: PosInt.max(100_000).optional() }),
  // The fallback when a web search fails: the labelled catalog list.
  z.strictObject({ type: z.literal("use_catalog"), actionId: ActionId }),
  z.strictObject({ type: z.literal("show_candidates"), actionId: ActionId, searchId: Id }),
  z.strictObject({ type: z.literal("pick"), actionId: ActionId, searchId: Id, supplierIds: SupplierIds }),
  z.strictObject({ type: z.literal("start_terms"), actionId: ActionId, supplierId: SupplierId, preset: TermsPreset.optional() }),
  // Sent after the REST terms form succeeded.
  z.strictObject({ type: z.literal("terms_saved"), actionId: ActionId, termsId: Id }),
  // A hint only: the server re-derives what was signed from its own records.
  z.strictObject({ type: z.literal("signed"), actionId: ActionId, kind: SignatureKind, refId: Id }),
  z.strictObject({ type: z.literal("show_cfo"), actionId: ActionId, view: CfoView }),
]);
export type ChatAction = z.infer<typeof ChatAction>;
export type ChatActionType = ChatAction["type"];

/** The router's one terminal tool call for a founder's free text. */
export const SkillCall = z.strictObject({
  skill: Skill,
  candidateRanks: z.array(z.number().int().min(1).max(8)).max(5).nullable(),
  cfoView: CfoView.nullable(),
});
export type SkillCall = z.infer<typeof SkillCall>;

/** What live and mock know about one founder's journey; core deriveJourney maps it to a stage. */
export const JourneyFacts = z.strictObject({
  facilityId: Id,
  persona: Persona,
  draftId: Id.nullable(),
  planStatus: PlanStatus.nullable(),
  founderKeyActive: z.boolean(),
  search: z.strictObject({ searchId: Id, status: SearchStatus, origin: SupplierOrigin }).nullable(),
  /** From the latest pick action in this session. */
  pickedSupplierIds: z.array(SupplierId).max(5),
  /**
   * v-chat-server (additive): each picked supplier's rank in the latest search, aligned with pickedSupplierIds (null when
   * the search no longer ranks it). Absent: treated as unknown.
   */
  pickedRanks: z.array(z.number().int().min(1).max(8).nullable()).max(5).optional(),
  /**
   * v-chat-server (additive): the supplier of the newest terms pre-fill this session showed after the last saved terms
   * (a start_terms button or terms the founder typed): the terms form is open (TERMS_DRAFT). Absent or null: none open.
   */
  termsDraft: z.strictObject({ supplierId: SupplierId }).nullable().optional(),
  terms: z.strictObject({ termsId: Id, supplierId: SupplierId, status: TermsStatus }).nullable(),
  order: z
    .strictObject({
      orderId: OrderId,
      supplierId: SupplierId,
      bound: z.boolean(),
      coolingEndsAt: IsoDateTime.nullable(),
      firstPaid: z.boolean(),
      /**
       * fix9-worker (additive, audit run-9 critic gap 1): the order's bindPayee never landed, so the worker cancelled its
       * payee; nothing was paid and the order holds no budget. Absent: false.
       */
      bindFailed: z.boolean().optional(),
      /**
       * ux-chat (additive, UX-PLAN D35, P1 19 Oct): every milestone of the order is released (the balance is paid), so
       * every later reply says the order is complete. Absent: false.
       */
      balancePaid: z.boolean().optional(),
      /**
       * rcfix-journey (additive, run-10 A-6): the server holds the founder's release of the order's held milestone
       * (live: a RELEASE_MILESTONE payment row for the first held milestone not released yet, not failed; mock: a
       * submitted MilestoneRelease signature the store applied), so "Signed. The balance is paid once it's saved." has
       * a fact behind it. Absent: false.
       */
      releaseSigned: z.boolean().optional(),
    })
    .nullable(),
  /**
   * rcfix-journey (additive, run-10 A-7): Treasury.paused() (live: the chain; mock: its balances), what GET /api/balances
   * shows. After a committed plan, the Next step is "paused" whatever the stage, as the web bar. Absent: false.
   */
  paused: z.boolean().optional(),
  now: IsoDateTime,
});
export type JourneyFacts = z.infer<typeof JourneyFacts>;

export const JourneyState = z.strictObject({ stage: JourneyStage, facts: JourneyFacts });
export type JourneyState = z.infer<typeof JourneyState>;
