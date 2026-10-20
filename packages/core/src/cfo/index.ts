/**
 * AI CFO (VISION-DECISIONS §8 core-cfo): pure report, insights and tighten-only proposals from the founder's own
 * records. P1 adds the barrel line in core/src/index.ts at merge (see docs/decisions/core-cfo.md for the exact one).
 */
export * from "./types";
export { buildCfoReport } from "./report";
export { toCfoReportJson, type CfoReportJson, type Serialised } from "./json";
export { proposeTightenings, tightenContextOf, toTightenProposal } from "./tighten";
export { meiCfoInputs } from "./demo";
