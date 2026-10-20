/**
 * Rule-id grammar. The plan's `rules[]` carry the compliance facts as machine-readable ids, so the E2 fields
 * can be derived from a PlanDraft alone (deriveE2Fields) without parsing human text:
 *
 *   entity.<entityType>                          exactly one
 *   entity.override                              when the drafted entity was not open to the founder
 *   registration.<code>.fee.<minor>              one per required registration (code lower-case)
 *   indirect-tax.registered | .not-registered    exactly one
 *   einvoicing.required | .not-required          exactly one
 *   duty.<route>                                 exactly one (form_e | mfn | exempt)
 *   approval.none | approval.<code>.fee.<minor>  exactly one
 *   import-tax.rate, reserve.policy, budget.capped, ads.pacing, stage.gate, landed-cost.*, marketplace.*,
 *   constitution.*, replan.current-state         informational
 *
 * Fees are in facility-currency minor units. Every id matches PlanRule.ruleId (`[a-z0-9][a-z0-9_.-]{0,63}`).
 */
import type { DutyRoute, EntityType, ProductApproval, Registration } from "../schemas/enums";

export const RULE_ID_MAX_LENGTH = 64;

export const RuleIds = {
  entity: (t: EntityType): string => `entity.${t}`,
  entityOverride: "entity.override",
  registration: (code: Registration, feeMinor: bigint): string => `registration.${code.toLowerCase()}.fee.${feeMinor}`,
  indirectTax: (registered: boolean): string => (registered ? "indirect-tax.registered" : "indirect-tax.not-registered"),
  eInvoicing: (required: boolean): string => (required ? "einvoicing.required" : "einvoicing.not-required"),
  duty: (route: DutyRoute): string => `duty.${route.toLowerCase()}`,
  approval: (a: ProductApproval, feeMinor: bigint): string => (a === "NONE" ? "approval.none" : `approval.${a.toLowerCase()}.fee.${feeMinor}`),
  importTax: "import-tax.rate",
  reserve: "reserve.policy",
  budgetCapped: "budget.capped",
  adsPacing: "ads.pacing",
  stageGate: "stage.gate",
  licensingLine: "licensing.line",
  landedCost: "landed-cost.total",
  landedCostShort: "landed-cost.supplier-line-short",
  marketplace: (channel: string): string => `marketplace.${channel}.fees`,
  constitutionCaps: "constitution.caps",
  constitutionEscrow: "constitution.supplier-escrow",
  constitutionStage1: "constitution.stage1",
  constitutionPayees: "constitution.payees",
  replan: "replan.current-state",
} as const;

export const RULE_ID_PATTERNS = {
  entity: /^entity\.([a-z_]+)$/,
  registration: /^registration\.([a-z_]+)\.fee\.(0|[1-9][0-9]*)$/,
  indirectTax: /^indirect-tax\.(registered|not-registered)$/,
  eInvoicing: /^einvoicing\.(required|not-required)$/,
  duty: /^duty\.(form_e|mfn|exempt)$/,
  approval: /^approval\.(?:(none)|([a-z_]+)\.fee\.(0|[1-9][0-9]*))$/,
} as const;
