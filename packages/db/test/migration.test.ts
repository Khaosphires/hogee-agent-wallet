import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNames, columnNames, tableConfigs } from './helpers';

const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

interface Journal {
  entries: Array<{ idx: number; tag: string }>;
}
interface Snapshot {
  tables: Record<
    string,
    {
      name: string;
      columns: Record<string, { name: string; type: string }>;
      checkConstraints: Record<string, { name: string }>;
    }
  >;
}

const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as Journal;
const sqlFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort();
const allSql = sqlFiles.map((f) => readFileSync(join(drizzleDir, f), 'utf8')).join('\n');

const lastEntry = journal.entries.at(-1);
if (!lastEntry) throw new Error('drizzle journal has no entries; run db:generate');
const snapshotFile = `${String(lastEntry.idx).padStart(4, '0')}_snapshot.json`;
const snapshot = JSON.parse(readFileSync(join(drizzleDir, 'meta', snapshotFile), 'utf8')) as Snapshot;

describe('generated migrations', () => {
  it('every journal entry has its SQL file', () => {
    expect(sqlFiles).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
  });

  it('contain no real / double precision / float columns', () => {
    expect(allSql).not.toMatch(/\breal\b/i);
    expect(allSql).not.toMatch(/double precision/i);
    expect(allSql).not.toMatch(/\bfloat\d*\b/i);
  });

  it('create every schema table', () => {
    for (const t of tableConfigs) {
      expect(allSql, t.name).toContain(`CREATE TABLE "${t.name}"`);
    }
  });

  it('store money as numeric(39, 0) bounded by uint128 (G0-REVIEW M10)', () => {
    expect(allSql).toMatch(/"amount_minor" numeric\(39, 0\) NOT NULL/);
    expect(allSql).toContain(
      'CONSTRAINT "payments_amount_minor_uint128" CHECK ("payments"."amount_minor" <= 340282366920938463463374607431768211455)',
    );
  });

  // G0-AUDIT (v-4): a DROPPED row keeps its intent (its signed bytes can still be mined at its nonce).
  it('make payments.intent_id unique per facility only while live (G0-REVIEW M11, G0-AUDIT v-4)', () => {
    expect(allSql).toContain(
      `CREATE UNIQUE INDEX "payments_facility_intent_id_unique" ON "payments" USING btree ("facility_id","intent_id") WHERE "payments"."state" NOT IN ('POLICY_DENIED', 'REVERTED', 'CANCELLED')`,
    );
  });

  it('add the terminal CANCELLED payment state last (G0-AUDIT v-4)', () => {
    expect(allSql).toContain(
      `CREATE TYPE "public"."payment_state" AS ENUM('PROPOSED', 'POLICY_DENIED', 'POLICY_OK', 'SIGNED', 'BROADCAST', 'INCLUDED', 'FINALIZED', 'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED', 'REVERTED', 'DROPPED', 'CANCELLED')`,
    );
  });

  it('keep signed bytes off POLICY_DENIED rows, which release the intent (G0-AUDIT v-4)', () => {
    expect(allSql).toContain(
      `CONSTRAINT "payments_policy_denied_unsigned" CHECK ("payments"."state" <> 'POLICY_DENIED' OR "payments"."raw_signed_tx" IS NULL)`,
    );
    // CANCELLED was signed before its nonce was consumed, so it must keep raw_signed_tx.
    expect(allSql).toContain(
      `CONSTRAINT "payments_signed_state_has_tx" CHECK ("payments"."state" IN ('PROPOSED', 'POLICY_DENIED', 'POLICY_OK') OR "payments"."raw_signed_tx" IS NOT NULL)`,
    );
  });

  // G0-AUDIT (v-4, finding 8): CANCELLED needs proof that a FOREIGN tx consumed the nonce. A fee bump
  // overwrites tx_hash in place, so every earlier hash of the row is kept in superseded_tx_hashes.
  it('make CANCELLED name a foreign tx that is none of the row\'s own hashes (G0-AUDIT v-4)', () => {
    expect(allSql).toMatch(/"superseded_tx_hashes" text\[\] DEFAULT '\{\}'(::text\[\])? NOT NULL,/);
    expect(allSql).toContain(`"nonce_consumed_by_tx_hash" text,`);
    expect(allSql).toContain(
      `CONSTRAINT "payments_superseded_tx_hashes_hex32" CHECK (array_position("payments"."superseded_tx_hashes", NULL) IS NULL AND array_to_string("payments"."superseded_tx_hashes", ',') ~ '^(0x[0-9a-f]{64}(,0x[0-9a-f]{64})*)?$')`,
    );
    expect(allSql).toContain(
      `CONSTRAINT "payments_nonce_consumed_by_tx_hash_hex32" CHECK ("payments"."nonce_consumed_by_tx_hash" ~ '^0x[0-9a-f]{64}$')`,
    );
    expect(allSql).toContain(
      `CONSTRAINT "payments_cancelled_iff_nonce_consumed" CHECK (("payments"."state" = 'CANCELLED') = ("payments"."nonce_consumed_by_tx_hash" IS NOT NULL))`,
    );
    expect(allSql).toContain(
      `CONSTRAINT "payments_nonce_consumed_by_foreign_tx" CHECK ("payments"."nonce_consumed_by_tx_hash" IS NULL OR ("payments"."tx_hash" IS NOT NULL AND "payments"."nonce_consumed_by_tx_hash" <> "payments"."tx_hash" AND array_position("payments"."superseded_tx_hashes", "payments"."nonce_consumed_by_tx_hash") IS NULL))`,
    );
  });

  // G0-AUDIT (v-4, finding 9): REVERTED releases the intent, so it needs the (finalized) receipt.
  it('make REVERTED carry its receipt block and tx hash (G0-AUDIT v-4)', () => {
    expect(allSql).toContain(
      `CONSTRAINT "payments_reverted_has_receipt" CHECK ("payments"."state" <> 'REVERTED' OR ("payments"."block" IS NOT NULL AND "payments"."tx_hash" IS NOT NULL))`,
    );
  });

  it.each(['payments', 'chain_actions'])('make %s signer nonces unique where set (G0-REVIEW M11)', (table) => {
    expect(allSql).toContain(
      `CREATE UNIQUE INDEX "${table}_signer_nonce_unique" ON "${table}" USING btree ("signer_address","chain_id","nonce") WHERE "${table}"."nonce" IS NOT NULL`,
    );
  });
});

describe('latest snapshot is in sync with the schema (run db:generate after schema edits)', () => {
  it('has the same tables', () => {
    const snapTables = Object.values(snapshot.tables).map((t) => t.name).sort();
    expect(snapTables).toEqual(tableConfigs.map((t) => t.name).sort());
  });

  it.each(tableConfigs.map((t) => [t.name, t] as const))('%s columns, types and checks match', (name, t) => {
    const snap = snapshot.tables[`public.${name}`];
    expect(snap).toBeDefined();
    if (!snap) return;
    expect(Object.keys(snap.columns).sort()).toEqual(columnNames(t).sort());
    for (const c of t.columns) {
      expect(snap.columns[c.name]?.type, `${name}.${c.name}`).toBe(c.getSQLType());
    }
    expect(Object.keys(snap.checkConstraints).sort()).toEqual(checkNames(t).sort());
  });
});
