/**
 * Mirror of `library HogeeKinds` in contracts/src/interfaces/HogeeKinds.sol (frozen at G0).
 * test/kinds.test.ts parses the Solidity file and fails on any drift.
 */
export const HOGEE_KINDS = {
  // Sig.kind
  SIG_ECDSA: 0,
  SIG_WEBAUTHN: 1,

  // ITreasury.tighten kinds (agent may do these alone)
  TIGHTEN_LOWER_PER_TX_CAP: 1,
  TIGHTEN_LOWER_WINDOW_CAP: 2,
  TIGHTEN_RAISE_RESERVE_BPS: 3,
  TIGHTEN_REVOKE_AGENT: 4,
  TIGHTEN_PAUSE_LINE: 5,

  // LoosenRequest.kind (timelocked)
  LOOSEN_RAISE_PER_TX_CAP: 1,
  LOOSEN_RAISE_WINDOW_CAP: 2,
  LOOSEN_ADD_PAYEE: 3, // G0-REVIEW: newValue = uint256(payoutAccountHash)
  LOOSEN_EXTEND_AGENT_EXPIRY: 4,
  LOOSEN_EXTEND_LINE_EXPIRY: 5,
  LOOSEN_MOVE_POCKETS: 6,
  LOOSEN_UNPAUSE: 7,
  LOOSEN_WITHDRAW_RESERVE: 8,

  // QueuedLoosen.status
  LOOSEN_STATUS_NONE: 0,
  LOOSEN_STATUS_QUEUED: 1,
  LOOSEN_STATUS_EXECUTED: 2,
  LOOSEN_STATUS_CANCELLED: 3,
  LOOSEN_STATUS_EXPIRED: 4,

  // PlanInvariantViolated(code)
  CONST_LINES_EXCEED_FACILITY_CAP: 1,
  CONST_AGENT_EXPIRY_TOO_LATE: 2,
  CONST_AGENT_EXPIRY_TOO_EARLY: 3,
  CONST_PER_TX_CAP_OVER_25PCT: 4,
  CONST_WINDOW_CAP_OVER_50PCT: 5,
  CONST_LINE_VALIDITY_TOO_LONG: 6,
  CONST_RESERVE_BELOW_FLOOR: 7,
  CONST_STAGE1_OVER_40PCT: 8,
  CONST_PLAN_ADDS_PAYEE: 9,
  CONST_SUPPLIER_LINE_NOT_ESCROW: 10,
  CONST_PAYEE_CAP_OVER_SCHEDULE: 11,
  CONST_TOTALS_MISMATCH: 12,
  CONST_MALFORMED_PLAN: 13,
  CONST_REPLAN_LOOSENS: 14, // G0-AUDIT (v-1)

  // Stage.metric
  METRIC_NONE: 0,
  METRIC_SALES_MINOR: 1,
  METRIC_ORDERS: 2,

  // ITreasury.settlementState
  SETTLEMENT_NONE: 0,
  SETTLEMENT_CONFIRMED: 1,
  SETTLEMENT_FAILED: 2,
} as const;

export type HogeeKindName = keyof typeof HOGEE_KINDS;

/** lineId of the supplier line: stringToHex('SUPPLIER', { size: 32 }). */
export const LINE_SUPPLIER = '0x535550504c494552000000000000000000000000000000000000000000000000' as const;

const CONSTITUTION_CODE_NAMES: ReadonlyMap<number, HogeeKindName> = new Map(
  (Object.keys(HOGEE_KINDS) as HogeeKindName[])
    .filter((name) => name.startsWith('CONST_'))
    .map((name) => [HOGEE_KINDS[name], name] as const),
);

/** Name of a PlanInvariantViolated(code) value, e.g. 7 -> 'CONST_RESERVE_BELOW_FLOOR'; undefined if unknown. */
export function constitutionCodeName(code: number): HogeeKindName | undefined {
  return CONSTITUTION_CODE_NAMES.get(code);
}

/**
 * G0-REVIEW (H2): mirror of HogeeKinds.requiresLender. Every current loosen kind needs founder AND lender;
 * a later kind may opt out additively. Unknown kinds fail safe (true).
 */
export function requiresLender(kind: number): boolean {
  if (kind >= HOGEE_KINDS.LOOSEN_RAISE_PER_TX_CAP && kind <= HOGEE_KINDS.LOOSEN_WITHDRAW_RESERVE) return true;
  return true;
}
