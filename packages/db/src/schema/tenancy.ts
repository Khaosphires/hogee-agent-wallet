/**
 * Tenant root. Every table except `nonces` and `log_checkpoints` carries `facility_id` (§12.1) so every
 * query can be scoped by the session's facility and T31 (cross-tenant leak) is testable.
 */
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  address,
  addressChecks,
  chainId,
  createdAt,
  hex32,
  hex32Checks,
  minor,
  minorChecks,
  tstz,
  updatedAt,
} from './columns';
import { countryCodeEnum, founderKeyStatusEnum, residencyEnum } from './enums';

/**
 * G0-DECISION: the facilities primary key column is named `facility_id` (not `id`) so the tenant
 * filter `where facility_id = $1` is identical on every tenant table, including this one.
 */
export const facilities = pgTable(
  'facilities',
  {
    facilityId: text('facility_id').primaryKey(),
    capMinor: minor('cap_minor').notNull(),
    /** Display currency of the facility (ISO 4217, e.g. MYR). Amounts are still budget-unit minor units. */
    currency: text('currency').notNull(),
    /** `openFacility(capMinor, reserveFloorBps)` argument (§26.1 step 0). */
    reserveFloorBps: integer('reserve_floor_bps').notNull(),
    lenderAddress: address('lender_address').notNull(),
    /** e.g. `loop-1` / `final-1` (§8.1); matches `packages/chain/deployments/<chain>-<deploymentId>.json`. */
    deploymentId: text('deployment_id').notNull(),
    chainId: chainId().notNull(),
    openedTx: hex32('opened_tx'),
    createdAt: createdAt(),
  },
  (t) => [
    ...minorChecks('facilities', [t.capMinor]),
    ...addressChecks('facilities', [t.lenderAddress]),
    ...hex32Checks('facilities', [t.openedTx]),
    check('facilities_currency_iso4217', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('facilities_reserve_floor_bps_range', sql`${t.reserveFloorBps} BETWEEN 0 AND 10000`),
  ],
);

/** Tenant scope column with FK to `facilities`. */
export const facilityRef = () =>
  text('facility_id')
    .notNull()
    .references(() => facilities.facilityId);

/**
 * Founder identity is limited to what signing needs. No name, national ID or phone is stored
 * (§12.2, §14.1: ID numbers never leave the client).
 */
export const founders = pgTable(
  'founders',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    country: countryCodeEnum('country').notNull(),
    residency: residencyEnum('residency').notNull(),
    /** WebAuthn credential id (base64url). */
    passkeyCredentialId: text('passkey_credential_id'),
    /** P-256 public key coordinates registered on-chain; `0x00…00` for an ECDSA-only owner (§26.9). */
    qx: hex32('qx'),
    qy: hex32('qy'),
    /** Backup owner EOA (§8.7). */
    walletAddress: address('wallet_address'),
    keyStatus: founderKeyStatusEnum('key_status').notNull().default('PENDING_LENDER'),
    /** G2: when the founder registered the current passkey (the officer reviews it); null when none is pending. */
    passkeyRegisteredAt: tstz('passkey_registered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped keys; fixture founders (e.g. `rina`) can repeat across tenants.
    primaryKey({ name: 'founders_pk', columns: [t.facilityId, t.id] }),
    uniqueIndex('founders_facility_passkey_credential_id_unique').on(
      t.facilityId,
      t.passkeyCredentialId,
    ),
    ...hex32Checks('founders', [t.qx, t.qy]),
    ...addressChecks('founders', [t.walletAddress]),
  ],
);
