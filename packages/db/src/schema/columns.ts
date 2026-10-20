/**
 * Column builders and CHECK helpers shared by every table.
 *
 * Type choices (G0-DECISION; listed in the G0 report for lead approval):
 * - Money: integer minor units (1 BU = 100 minor), TS `string` of digits. Never float/real/double and
 *   never a JS `number` (§12.1, §26.3).
 *   G0-REVIEW (M10): `numeric(39,0)` + CHECK `0 <= x <= uint128 max` on every minor-unit column, the
 *   on-chain amount type (§8.4). Postgres silently ROUNDS a fractional literal into numeric(p,0)
 *   ('10.5' → 11) before any CHECK runs, so `minor()` also validates on write with the same rule as
 *   core `Minor`: digits, no leading zeros, ≤ uint128. Anything else throws in the app.
 * - Tenancy, G0-REVIEW (M9): every tenant table's primary key is `(facility_id, …)` and every FK between
 *   tenant tables includes `facility_id`, so fixture ids (`supplier-a`, `order-a-001`, `shopee-ads`, …)
 *   can repeat across tenants and a row can never point at another tenant's row.
 * - Chain-mirrored integers (unix seconds `valid_until` / `expires_at` / `executable_at` / `deadline` /
 *   `cooling_until`, block numbers, nonces): pg `bigint`, TS `bigint` (mode 'bigint'). Exact for all
 *   uint64 values and matches viem. The API layer turns them into digit strings (§26.3).
 * - Off-chain times: `timestamptz`, TS `Date`. The API layer serialises with `toISOString()` (§26.3).
 * - `Hex32`: `text` + CHECK `^0x[0-9a-f]{64}$` (lowercase, §26.3).
 * - Addresses: `text` + CHECK `^0x[0-9a-f]{40}$`. Stored LOWERCASE so `nonces` can never hold two rows
 *   for one signer written with different checksum casing (that would hand out a nonce twice).
 * - Raw signed tx: `text` + CHECK `^0x([0-9a-f]{2})+$`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  integer,
  text,
  timestamp,
  type PgColumn,
} from 'drizzle-orm/pg-core';

export const HEX32_PATTERN = '^0x[0-9a-f]{64}$';
export const ADDRESS_PATTERN = '^0x[0-9a-f]{40}$';
export const RAW_TX_PATTERN = '^0x([0-9a-f]{2})+$';

/** G0-REVIEW (M10): same rule as core `Minor`: digits, no leading zeros except "0", ≤ 39 chars. */
export const MINOR_PATTERN = /^(0|[1-9][0-9]{0,38})$/;
/** uint128 max, the on-chain amount type (§8.4). */
export const UINT128_MAX = '340282366920938463463374607431768211455';
const UINT128_MAX_BIGINT = BigInt(UINT128_MAX);

/**
 * Integer minor units as numeric(39,0); TS sees a digit string. Writes that are not a canonical digit
 * string ≤ uint128 max (fractions, signs, exponents, leading zeros, JS numbers) throw instead of being
 * rounded or rejected later by Postgres.
 */
export const minor = customType<{ data: string; driverData: string }>({
  dataType: () => 'numeric(39, 0)',
  toDriver(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !MINOR_PATTERN.test(value) ||
      BigInt(value) > UINT128_MAX_BIGINT
    ) {
      throw new TypeError(`minor units must be a uint128 digit string, got ${JSON.stringify(value)}`);
    }
    return value;
  },
});

/** Chain-mirrored unsigned integer (unix seconds, block number, nonce) as pg bigint / TS bigint. */
export const chainUint = (name: string) => bigint(name, { mode: 'bigint' });

/** EVM chain id (Sepolia 11155111, Anvil 31337). */
export const chainId = (name = 'chain_id') => integer(name);

/** `0x` + 64 lowercase hex. Pair with {@link hex32Checks}. */
export const hex32 = (name: string) => text(name);

/** Lowercase EVM address. Pair with {@link addressChecks}. */
export const address = (name: string) => text(name);

/** Raw signed transaction bytes (0x hex). Pair with {@link rawTxCheck}. */
export const rawTx = (name = 'raw_signed_tx') => text(name);

/** Off-chain timestamp (timestamptz, TS Date). */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => tstz('created_at').notNull().defaultNow();

export const updatedAt = () =>
  tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** CHECK `<col> ~ '^0x[0-9a-f]{64}$'` for each column. Named `<table>_<column>_hex32`. */
export function hex32Checks(table: string, columns: readonly PgColumn[]) {
  return columns.map((col) =>
    check(`${table}_${col.name}_hex32`, sql`${col} ~ ${sql.raw(`'${HEX32_PATTERN}'`)}`),
  );
}

/**
 * G0-AUDIT (v-4): CHECK that a `text[]` column holds only lowercase Hex32 values and no NULL element.
 * A CHECK cannot use a subquery (`unnest`), so the elements are joined with ',' and matched as one
 * string. `array_to_string` skips NULL elements, so `array_position(col, NULL)` rejects those.
 * Named `<table>_<column>_hex32`.
 */
export function hex32ArrayCheck(table: string, column: PgColumn) {
  const element = HEX32_PATTERN.slice(1, -1); // without ^ and $
  return check(
    `${table}_${column.name}_hex32`,
    sql`array_position(${column}, NULL) IS NULL AND array_to_string(${column}, ',') ~ ${sql.raw(`'^(${element}(,${element})*)?$'`)}`,
  );
}

/** CHECK `<col> ~ '^0x[0-9a-f]{40}$'` for each column. Named `<table>_<column>_address`. */
export function addressChecks(table: string, columns: readonly PgColumn[]) {
  return columns.map((col) =>
    check(`${table}_${col.name}_address`, sql`${col} ~ ${sql.raw(`'${ADDRESS_PATTERN}'`)}`),
  );
}

/** CHECK `<col> >= 0` (nonces, block numbers). Named `<table>_<column>_nonneg`. */
export function nonNegativeChecks(table: string, columns: readonly PgColumn[]) {
  return columns.map((col) => check(`${table}_${col.name}_nonneg`, sql`${col} >= 0`));
}

/**
 * G0-REVIEW (M10): money range CHECKs, `<table>_<column>_nonneg` (`>= 0`) and
 * `<table>_<column>_uint128` (`<= 340282366920938463463374607431768211455`).
 */
export function minorChecks(table: string, columns: readonly PgColumn[]) {
  return columns.flatMap((col) => [
    check(`${table}_${col.name}_nonneg`, sql`${col} >= 0`),
    check(`${table}_${col.name}_uint128`, sql`${col} <= ${sql.raw(UINT128_MAX)}`),
  ]);
}

/**
 * G0-REVIEW (M9): composite FK `(facility_id, <col>) → <target>(facility_id, <key>)`. Rows can only
 * reference rows of the same tenant. A NULL `<col>` skips the check (MATCH SIMPLE).
 */
export function tenantFk(
  name: string,
  columns: [PgColumn, PgColumn],
  foreignColumns: [PgColumn, PgColumn],
) {
  return foreignKey({ name, columns, foreignColumns });
}

/** CHECK on the raw signed tx hex. Named `<table>_raw_signed_tx_hex`. */
export function rawTxCheck(table: string, column: PgColumn) {
  return check(`${table}_${column.name}_hex`, sql`${column} ~ ${sql.raw(`'${RAW_TX_PATTERN}'`)}`);
}

/**
 * Crash-safety invariant for any row the worker signs (§12.3):
 * - `raw_signed_tx` and `nonce` are written together (both NULL or both set), in the SAME DB
 *   transaction that allocates the nonce from `nonces` (`SELECT … FOR UPDATE`), BEFORE broadcast;
 * - once the row has left the unsigned states it must carry the signed bytes, so recovery can
 *   rebroadcast the same bytes instead of signing a new tx.
 */
export function signedTxChecks(
  table: string,
  cols: { rawSignedTx: PgColumn; nonce: PgColumn; signerAddress: PgColumn; chainId: PgColumn },
  state: PgColumn,
  unsignedStates: readonly string[],
) {
  const unsigned = sql.raw(unsignedStates.map((s) => `'${s}'`).join(', '));
  return [
    check(
      `${table}_signed_tx_atomic`,
      sql`(${cols.rawSignedTx} IS NULL) = (${cols.nonce} IS NULL) AND (${cols.rawSignedTx} IS NULL) = (${cols.signerAddress} IS NULL) AND (${cols.rawSignedTx} IS NULL) = (${cols.chainId} IS NULL)`,
    ),
    check(
      `${table}_signed_state_has_tx`,
      sql`${state} IN (${unsigned}) OR ${cols.rawSignedTx} IS NOT NULL`,
    ),
  ];
}

/** CHECK that a `taint` jsonb column has the §26.3 shape `{trust, sensitivity}`. */
export function taintCheck(table: string, column: PgColumn) {
  return check(
    `${table}_${column.name}_shape`,
    sql`${column}->>'trust' IN ('trusted', 'untrusted') AND ${column}->>'sensitivity' IN ('public', 'private')`,
  );
}

/** §26.3 Taint, stored as jsonb. */
export interface TaintJson {
  trust: 'trusted' | 'untrusted';
  sensitivity: 'public' | 'private';
}

/** §26.9 Sig wrapper, stored as jsonb: kind 0 = ECDSA (65 bytes), 1 = abi.encode(WebAuthnAuth). */
export interface SigJson {
  kind: 0 | 1;
  data: `0x${string}`;
}
