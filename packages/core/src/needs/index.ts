/**
 * The founder's needs checklist (VISION-DECISIONS §8 core-needs). Types live in ./types (not exported here, so the core
 * barrel never declares NeedsItem / NeedsChecklist twice once v-contract's schemas land).
 */
export { buildNeeds } from "./build";
export { NeedsError, type NeedsErrorCode } from "./errors";
export { NEEDS_LINE_SPLIT_REF } from "./items";
