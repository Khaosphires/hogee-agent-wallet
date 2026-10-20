/**
 * Drizzle schema (§12.1). drizzle-kit reads this file (see `drizzle.config.ts`).
 * Only the lead generates migrations (`pnpm --filter @hogee/db db:generate`).
 */
export * from './enums';
export {
  HEX32_PATTERN,
  ADDRESS_PATTERN,
  MINOR_PATTERN,
  UINT128_MAX,
  RAW_TX_PATTERN,
  type TaintJson,
  type SigJson,
} from './columns';
export * from './tenancy';
export * from './chat';
export * from './plans';
export * from './suppliers';
export * from './payments';
export * from './governance';
export * from './audit';
export * from './enrolment';
