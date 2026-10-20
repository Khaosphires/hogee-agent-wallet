/**
 * G0-REVIEW (M9): tenant isolation is structural. Every tenant key and every tenant-to-tenant FK
 * includes facility_id, so a second tenant seeded from the same fixtures cannot conflict and a row
 * cannot reference another tenant's row. `tenancy.live.test.ts` proves the same on a real database.
 */
import { describe, expect, it } from 'vitest';
import { foreignKeyRefs, tableByName, tableConfigs, uniqueKeys } from './helpers';

const NON_TENANT_TABLES = ['nonces', 'log_checkpoints'];
/** Global on purpose: one signer key's nonce can be used once, whatever the tenant (M11). */
const GLOBAL_UNIQUE_KEYS = ['payments_signer_nonce_unique', 'chain_actions_signer_nonce_unique'];

/** Fixture ids from @hogee/core demo/rina that a second tenant reuses verbatim. */
const FIXTURE_IDS: Record<string, Record<string, readonly string[]>> = {
  suppliers: { supplier_id: ['supplier-a'] },
  payees: { id: ['supplier-a', 'shopee-ads', 'spx-logistics', 'shopee-fees', 'printer-kl', 'lhdn-tax'] },
  escrow_orders: { order_id: ['order-a-001'] },
};

const tenantTables = tableConfigs.filter((t) => !NON_TENANT_TABLES.includes(t.name));

describe('tenant-scoped keys', () => {
  it.each(tenantTables.map((t) => [t.name, t] as const))('%s primary key starts with facility_id', (_, t) => {
    const pk = t.primaryKeys[0]?.columns.map((c) => c.name) ?? t.columns.filter((c) => c.primary).map((c) => c.name);
    expect(pk[0]).toBe('facility_id');
  });

  it.each(tenantTables.map((t) => [t.name, t] as const))('%s unique keys all include facility_id', (_, t) => {
    const offenders = uniqueKeys(t).filter(
      (k) => !k.columns.includes('facility_id') && !GLOBAL_UNIQUE_KEYS.includes(k.name),
    );
    expect(offenders).toEqual([]);
  });

  it.each(tenantTables.map((t) => [t.name, t] as const))(
    '%s foreign keys to tenant tables start with facility_id on both sides',
    (_, t) => {
      for (const fk of foreignKeyRefs(t).filter((f) => f.foreignTable !== 'facilities')) {
        expect(fk.columns[0], fk.name).toBe('facility_id');
        expect(fk.foreignColumns[0], fk.name).toBe('facility_id');
      }
    },
  );
});

describe('a second tenant reusing the demo fixture ids does not conflict', () => {
  // Worst case: the second tenant's rows are byte-identical to the first except facility_id.
  const row = (facilityId: string, natural: Record<string, string>) => ({ facility_id: facilityId, ...natural });

  it.each(
    Object.entries(FIXTURE_IDS).flatMap(([table, cols]) =>
      Object.entries(cols).flatMap(([col, ids]) => ids.map((id) => [table, col, id] as const)),
    ),
  )('%s.%s = %s', (table, col, id) => {
    const t = tableByName(table);
    const a = row('fac-rina', { [col]: id });
    const b = row('fac-second', { [col]: id });
    for (const key of uniqueKeys(t)) {
      const project = (r: Record<string, string>) => key.columns.map((c) => r[c] ?? '<same>').join('|');
      expect(project(a), key.name).not.toBe(project(b));
    }
  });
});
