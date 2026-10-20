/** G2: the founder enrolment helper's guards and the 0002 migration, without a database. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { consumeEnrolmentCode, issueEnrolmentCode, type EnrolmentQueryable } from '../src/index';

const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0002_founder_enrolment.sql'), 'utf8');

/** Records every statement; answers founder locks with one row and updates with `rowCount`. */
function recorder(rowCount = 1) {
  const calls: { text: string; values: unknown[] }[] = [];
  const q = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: text.includes('for update') ? [{ x: 1 }] : [], rowCount };
    },
  } as unknown as EnrolmentQueryable;
  return { q, calls };
}

const now = new Date('2026-10-18T09:00:00Z');
const later = new Date('2026-10-18T09:15:00Z');
const base = { facilityId: 'fac-rina', founderId: 'rina', id: 'enr-1', now, expiresAt: later };

describe('0002_founder_enrolment (additive only)', () => {
  it('creates the two tables, one nullable founders column, and no DROP / RENAME / ALTER COLUMN TYPE', () => {
    expect(sql).toContain('CREATE TABLE "founder_enrolment_codes"');
    expect(sql).toContain('CREATE TABLE "rejected_founder_keys"');
    expect(sql).toContain('ALTER TABLE "founders" ADD COLUMN "passkey_registered_at" timestamp with time zone;');
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b|ALTER COLUMN|SET NOT NULL/i);
  });

  it('allows one open code per facility', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "founder_enrolment_codes_one_open" ON "founder_enrolment_codes" USING btree ("facility_id") WHERE "founder_enrolment_codes"."used_at" IS NULL AND "founder_enrolment_codes"."revoked_at" IS NULL',
    );
  });
});

describe('issueEnrolmentCode', () => {
  it('locks the founder, revokes the open code, then inserts the lowercase hash', async () => {
    const { q, calls } = recorder();
    expect(await issueEnrolmentCode(q, { ...base, codeHash: `0x${'AB'.repeat(32)}` })).toBe(1);
    expect(calls.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(' '))).toEqual(['select 1', 'update founder_enrolment_codes', 'insert into']);
    expect(calls[2]?.values).toEqual(['enr-1', 'fac-rina', 'rina', `0x${'ab'.repeat(32)}`, later]);
  });

  it.each([
    ['not a 32-byte hash', { codeHash: '0x1234' }],
    ['a raw code instead of its hash', { codeHash: 'ZXhhbXBsZS1lbnJvbG1lbnQt' }],
    ['an expiry that is not after now', { codeHash: `0x${'ab'.repeat(32)}`, expiresAt: now }],
  ])('refuses %s before touching the database', async (_label, patch) => {
    const { q, calls } = recorder();
    await expect(issueEnrolmentCode(q, { ...base, ...patch } as Parameters<typeof issueEnrolmentCode>[1])).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('consumeEnrolmentCode', () => {
  it('only consumes a code that is still open and unexpired at now', async () => {
    const { q, calls } = recorder(0);
    expect(await consumeEnrolmentCode(q, { facilityId: 'fac-rina', id: 'enr-1', credentialId: 'cred', now })).toBe(false);
    expect(calls[0]?.text).toMatch(/used_at is null and revoked_at is null and code_expires_at > \$3/);
  });
});
