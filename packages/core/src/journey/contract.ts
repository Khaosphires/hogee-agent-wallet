/**
 * The journey contract (v-chat-server brief 7): one button script that the mock (api-mock test/journey-contract) and
 * the live API on Anvil (api test/live/journey-contract.live) both play from the same starting point: a committed plan
 * and a READY web search with one candidate (the contract example search) and the contract example terms CONFIRMED once
 * saved. Both must answer every step with exactly `expect`, the same sequence of part types.
 */
import type { ChatAction } from "../schemas/journey";

export interface ContractStep {
  readonly label: string;
  /** Builds the action from the step's ids (a fresh actionId each time unless `replayOf` names an earlier step). */
  readonly action: (ids: ContractIds) => ChatAction;
  readonly replayOf?: number;
  /** The reply's part types ("text" for a text part). */
  readonly expect: readonly string[];
}

export interface ContractIds {
  readonly actionId: string;
  readonly searchId: string;
  readonly supplierId: string;
  readonly termsId: string;
}

export const JOURNEY_CONTRACT_STEPS: readonly ContractStep[] = [
  { label: "show the candidates", action: (x) => ({ type: "show_candidates", actionId: x.actionId, searchId: x.searchId }), expect: ["text", "data-candidates"] },
  { label: "pick one", action: (x) => ({ type: "pick", actionId: x.actionId, searchId: x.searchId, supplierIds: [x.supplierId] }), expect: ["text", "data-enquiry", "data-next"] },
  { label: "open the terms form", action: (x) => ({ type: "start_terms", actionId: x.actionId, supplierId: x.supplierId, preset: "P30_70" }), expect: ["text", "data-terms"] },
  { label: "terms saved", action: (x) => ({ type: "terms_saved", actionId: x.actionId, termsId: x.termsId }), expect: ["text", "data-sign"] },
  { label: "a forged terms id", action: (x) => ({ type: "terms_saved", actionId: x.actionId, termsId: "terms-forged" }), expect: ["text", "text", "data-sign"] },
  { label: "the CFO overview", action: (x) => ({ type: "show_cfo", actionId: x.actionId, view: "overview" }), expect: ["text", "data-cfo", "data-next"] },
  { label: "a replayed press", action: (x) => ({ type: "show_cfo", actionId: x.actionId, view: "overview" }), replayOf: 5, expect: ["text", "text"] },
];
