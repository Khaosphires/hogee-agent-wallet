import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index';
import {
  checkNames,
  column,
  columnNames,
  foreignKeyRefs,
  hasUnique,
  keyColumnLists,
  tableByName,
  tableConfigs,
  uniqueKeys,
} from './helpers';

const SPEC_TABLES = [
  'facilities',
  'founders',
  'plans',
  'plan_lines',
  'payees',
  'suppliers',
  'supplier_evidence',
  'invoices',
  'payments',
  'nonces',
  'log_checkpoints',
  'sales',
  'exceptions',
  'traces',
  'llm_calls',
  'denials',
];

/** G0-DECISION tables (not in §12.1). Changing this list needs lead approval. */
const G0_DECISION_TABLES = [
  'chat_sessions',
  'chat_messages',
  'memory_entries',
  'plan_drafts',
  'shortlists',
  'escrow_orders',
  'escrow_milestones',
  'chain_actions',
  'signature_requests',
  'evidence_runs',
  // Task 1.16, approved by the lead 2026-10-18 (G0-DECISIONS.md §10): rationale preimages for the evidence bundle.
  'rationales',
  // G2 schema batch (G0-DECISIONS.md §11, run-4 lead 5): one-time founder enrolment codes and rejected pending keys.
  'founder_enrolment_codes',
  'rejected_founder_keys',
  // VISION-DECISIONS §6 (0004_chat_first): the founder's confirmed supplier terms.
  'supplier_terms',
];

const NON_TENANT_TABLES = ['nonces', 'log_checkpoints'];

describe('table inventory', () => {
  it('contains exactly the §12.1 tables plus the listed G0-DECISION tables', () => {
    const names = tableConfigs.map((t) => t.name).sort();
    expect(names).toEqual([...SPEC_TABLES, ...G0_DECISION_TABLES].sort());
  });
});

describe('tenant scope (§12.1, T31)', () => {
  const tenantTables = tableConfigs.filter((t) => !NON_TENANT_TABLES.includes(t.name));

  it.each(tenantTables.map((t) => [t.name, t] as const))('%s has NOT NULL facility_id', (_, t) => {
    expect(column(t, 'facility_id').notNull).toBe(true);
  });

  it.each(tenantTables.map((t) => [t.name, t] as const))(
    '%s has a key or index led by facility_id',
    (_, t) => {
      const lists = keyColumnLists(t, { uniqueOnly: false });
      expect(lists.some((list) => list[0] === 'facility_id')).toBe(true);
    },
  );

  it.each(NON_TENANT_TABLES)('%s has no facility_id', (name) => {
    expect(columnNames(tableByName(name))).not.toContain('facility_id');
  });
});

describe('money columns (§12.1, §26.3)', () => {
  const allColumns = tableConfigs.flatMap((t) => t.columns.map((c) => ({ table: t.name, c })));

  it('no real / double precision / float column anywhere', () => {
    const floats = allColumns.filter(({ c }) => /real|double|float/i.test(c.getSQLType()));
    expect(floats.map(({ table, c }) => `${table}.${c.name}`)).toEqual([]);
  });

  // G0-REVIEW (M10): numeric(39, 0) + uint128 CHECK.
  it('every *_minor column is numeric(39, 0)', () => {
    const minorCols = allColumns.filter(({ c }) => c.name.endsWith('_minor'));
    expect(minorCols.length).toBeGreaterThanOrEqual(13);
    for (const { table, c } of minorCols) {
      expect(c.getSQLType(), `${table}.${c.name}`).toBe('numeric(39, 0)');
      expect(c.columnType, `${table}.${c.name} must use the validating minor() type`).toBe('PgCustomColumn');
    }
  });

  it('minor() rejects anything but a digit string on write (no silent rounding)', () => {
    const amount = column(tableByName('payments'), 'amount_minor');
    const UINT128_MAX = '340282366920938463463374607431768211455';
    const UINT128_MAX_PLUS_1 = '340282366920938463463374607431768211456';
    expect(schema.UINT128_MAX).toBe(UINT128_MAX);
    expect(amount.mapToDriverValue('1000000')).toBe('1000000');
    expect(amount.mapToDriverValue('0')).toBe('0');
    expect(amount.mapToDriverValue(UINT128_MAX)).toBe(UINT128_MAX);
    for (const bad of ['10.5', '-1', '1e6', ' 1', '', '01', UINT128_MAX_PLUS_1, '9'.repeat(40), 10, 10n, null]) {
      expect(() => amount.mapToDriverValue(bad as never), JSON.stringify(String(bad))).toThrow(TypeError);
    }
  });

  it('sales.amount_bucket (minor units without the suffix) is numeric(39, 0)', () => {
    expect(column(tableByName('sales'), 'amount_bucket').getSQLType()).toBe('numeric(39, 0)');
  });

  it('every numeric column is a *_minor column or sales.amount_bucket', () => {
    const numericCols = allColumns.filter(({ c }) => c.getSQLType().startsWith('numeric'));
    for (const { table, c } of numericCols) {
      const ok = c.name.endsWith('_minor') || (table === 'sales' && c.name === 'amount_bucket');
      expect(ok, `${table}.${c.name}`).toBe(true);
    }
  });

  it('every numeric column has non-negative and uint128 CHECKs (G0-REVIEW M10)', () => {
    for (const t of tableConfigs) {
      for (const c of t.columns.filter((col) => col.getSQLType().startsWith('numeric'))) {
        expect(checkNames(t), `${t.name}.${c.name}`).toContain(`${t.name}_${c.name}_nonneg`);
        expect(checkNames(t), `${t.name}.${c.name}`).toContain(`${t.name}_${c.name}_uint128`);
      }
    }
  });
});

describe('hex32, address and chain-time columns (§26.3)', () => {
  const HEX32_NAMES = new Set(['intent_id', 'settlement_id', 'line_id', 'digest', 'hash', 'qx', 'qy', 'hmac']);
  const isHex32Name = (name: string) =>
    HEX32_NAMES.has(name) || name.endsWith('_hash') || (name.endsWith('_tx') && name !== 'raw_signed_tx');

  it('every hash / tx-hash column is text with a lowercase hex32 CHECK', () => {
    let count = 0;
    for (const t of tableConfigs) {
      for (const c of t.columns.filter((col) => isHex32Name(col.name))) {
        count += 1;
        expect(c.getSQLType(), `${t.name}.${c.name}`).toBe('text');
        expect(checkNames(t), `${t.name}.${c.name}`).toContain(`${t.name}_${c.name}_hex32`);
      }
    }
    expect(count).toBeGreaterThan(30);
  });

  // G0-AUDIT (v-4): e.g. payments.superseded_tx_hashes.
  it('every hash-array column is text[] with a per-element lowercase hex32 CHECK', () => {
    let count = 0;
    for (const t of tableConfigs) {
      for (const c of t.columns.filter((col) => col.name.endsWith('_hashes'))) {
        count += 1;
        expect(c.getSQLType(), `${t.name}.${c.name}`).toBe('text[]');
        expect(checkNames(t), `${t.name}.${c.name}`).toContain(`${t.name}_${c.name}_hex32`);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('every address column has a lowercase address CHECK', () => {
    for (const t of tableConfigs) {
      const addressCols = t.columns.filter(
        (c) => c.name.endsWith('_address') || (t.name === 'log_checkpoints' && c.name === 'contract'),
      );
      for (const c of addressCols) {
        expect(checkNames(t), `${t.name}.${c.name}`).toContain(`${t.name}_${c.name}_address`);
      }
    }
  });

  it('chain-mirrored times, blocks and nonces are bigint (TS bigint)', () => {
    const CHAIN_NAMES = new Set([
      'valid_until',
      'expires_at',
      'executable_at',
      'deadline',
      'cooling_until',
      'block',
      'nonce',
      'next_nonce',
      'last_block',
    ]);
    let count = 0;
    for (const t of tableConfigs) {
      for (const c of t.columns.filter((col) => CHAIN_NAMES.has(col.name))) {
        count += 1;
        expect(c.getSQLType(), `${t.name}.${c.name}`).toBe('bigint');
        expect(c.dataType, `${t.name}.${c.name}`).toBe('bigint');
      }
    }
    expect(count).toBeGreaterThanOrEqual(10);
  });

  it('off-chain times are timestamptz', () => {
    for (const t of tableConfigs) {
      for (const c of t.columns.filter((col) => col.name.endsWith('_at') && col.name !== 'expires_at' && col.name !== 'executable_at')) {
        expect(c.getSQLType(), `${t.name}.${c.name}`).toBe('timestamp with time zone');
      }
    }
  });
});

describe('keys and invariants', () => {
  // G0-REVIEW (M11): partial unique per facility; the WHERE clause is asserted in migration.test.ts.
  it('payments.intent_id is unique per facility while the payment is live', () => {
    const ix = tableByName('payments').indexes.find(
      (i) => i.config.name === 'payments_facility_intent_id_unique',
    );
    expect(ix?.config.unique).toBe(true);
    expect(ix?.config.where).toBeDefined();
    expect(ix?.config.columns.map((c) => ('name' in c ? c.name : '?'))).toEqual(['facility_id', 'intent_id']);
  });

  // G0-AUDIT (v-4): DROPPED is not terminal (its signed bytes can still be mined at its nonce), so it
  // keeps the intent. Only rows that can never execute release it.
  it('only POLICY_DENIED / REVERTED / CANCELLED release the intent', () => {
    expect([...schema.INTENT_RELEASED_STATES]).toEqual(['POLICY_DENIED', 'REVERTED', 'CANCELLED']);
    expect(schema.INTENT_RELEASED_STATES).not.toContain('DROPPED');
    // The lists are spliced into raw SQL, so every entry must be a real enum value.
    for (const s of [...schema.INTENT_RELEASED_STATES, ...schema.UNSIGNED_PAYMENT_STATES]) {
      expect(schema.paymentStateValues).toContain(s);
    }
  });

  it('CANCELLED is a signed state and POLICY_DENIED rows hold no signed bytes (G0-AUDIT v-4)', () => {
    expect(schema.UNSIGNED_PAYMENT_STATES).not.toContain('CANCELLED');
    expect(checkNames(tableByName('payments'))).toContain('payments_policy_denied_unsigned');
  });

  it('the releasing exits carry proof: CANCELLED names a foreign tx, REVERTED its receipt (G0-AUDIT v-4)', () => {
    const t = tableByName('payments');
    const superseded = column(t, 'superseded_tx_hashes');
    expect(superseded.getSQLType()).toBe('text[]');
    expect(superseded.notNull).toBe(true);
    expect(superseded.hasDefault).toBe(true);
    expect(column(t, 'nonce_consumed_by_tx_hash').notNull).toBe(false);
    for (const name of [
      'payments_cancelled_iff_nonce_consumed',
      'payments_nonce_consumed_by_foreign_tx',
      'payments_reverted_has_receipt',
    ]) {
      expect(checkNames(t)).toContain(name);
    }
  });

  it.each(['payments', 'chain_actions'])('%s has a unique (signer_address, chain_id, nonce) where set', (name) => {
    const ix = tableByName(name).indexes.find((i) => i.config.name === `${name}_signer_nonce_unique`);
    expect(ix?.config.unique).toBe(true);
    expect(ix?.config.columns.map((c) => ('name' in c ? c.name : '?'))).toEqual(['signer_address', 'chain_id', 'nonce']);
  });

  it('payments nullability matches core Payment and the owner-kind rule (H4, M11)', () => {
    const t = tableByName('payments');
    expect(column(t, 'invoice_hash').notNull).toBe(true);
    expect(column(t, 'trace_id').notNull).toBe(true);
    expect(column(t, 'decision_id').notNull).toBe(false);
    expect(column(t, 'rationale_hash').notNull).toBe(false);
    expect(checkNames(t)).toContain('payments_decision_iff_agent_kind');
    expect(checkNames(t)).toContain('payments_milestone_ref');
  });

  it('payees carry the signed payout destination hash (3b)', () => {
    const c = column(tableByName('payees'), 'payout_account_hash');
    expect(c.notNull).toBe(true);
    expect(checkNames(tableByName('payees'))).toContain('payees_payout_account_hash_hex32');
  });

  it('payments has the §12.1 columns', () => {
    const cols = columnNames(tableByName('payments'));
    for (const name of [
      'id', 'kind', 'intent_id', 'line_id', 'payee_id', 'amount_minor', 'invoice_hash',
      'plan_version', 'state', 'raw_signed_tx', 'nonce', 'tx_hash', 'block', 'payout_id',
      'payout_attempt', 'payout_status', 'decision_id', 'rationale_hash',
    ]) {
      expect(cols).toContain(name);
    }
  });

  it.each(['payments', 'chain_actions'])('%s enforces raw tx + nonce written together (§12.3)', (name) => {
    const checks = checkNames(tableByName(name));
    expect(checks).toContain(`${name}_signed_tx_atomic`);
    expect(checks).toContain(`${name}_signed_state_has_tx`);
  });

  it('nonces PK is (signer_address, chain_id) and next_nonce is bigint', () => {
    const t = tableByName('nonces');
    expect(hasUnique(t, ['signer_address', 'chain_id'])).toBe(true);
    expect(column(t, 'next_nonce').getSQLType()).toBe('bigint');
  });

  it('log_checkpoints PK is (contract, chain_id) and last_block is bigint', () => {
    const t = tableByName('log_checkpoints');
    expect(hasUnique(t, ['contract', 'chain_id'])).toBe(true);
    expect(column(t, 'last_block').getSQLType()).toBe('bigint');
  });

  it('traces are unique on (trace_id, seq) and carry the hash chain', () => {
    const t = tableByName('traces');
    expect(hasUnique(t, ['facility_id', 'trace_id', 'seq'])).toBe(true);
    expect(column(t, 'prev_hash').notNull).toBe(true);
    expect(column(t, 'hash').notNull).toBe(true);
    for (const ref of ['plan_version', 'payment_id', 'invoice_hash', 'decision_id', 'tx_hash', 'payout_id', 'exception_id', 'llm_call_id']) {
      expect(columnNames(t)).toContain(ref);
    }
  });

  it('sales dedupe on stripe_event_id and sale_id_hash (T23)', () => {
    const t = tableByName('sales');
    expect(hasUnique(t, ['facility_id', 'stripe_event_id'])).toBe(true);
    expect(hasUnique(t, ['facility_id', 'sale_id_hash'])).toBe(true);
  });

  it('invoices are unique on (facility_id, invoice_hash)', () => {
    expect(hasUnique(tableByName('invoices'), ['facility_id', 'invoice_hash'])).toBe(true);
  });

  it('llm_calls stores hashes and the redaction report, not raw prompts', () => {
    const cols = columnNames(tableByName('llm_calls'));
    for (const name of ['prompt_hash', 'response_hash', 'redaction_report', 'params_json', 'tokens']) {
      expect(cols).toContain(name);
    }
    expect(cols.some((c) => /^(prompt|response|messages)(_text|_json)?$/.test(c))).toBe(false);
    expect(column(tableByName('llm_calls'), 'redaction_report').getSQLType()).toBe('jsonb');
  });
});

describe('enum value arrays match project.md', () => {
  const cases: Array<[string, readonly string[], string[]]> = [
    ['paymentStateValues', schema.paymentStateValues, [
      'PROPOSED', 'POLICY_DENIED', 'POLICY_OK', 'SIGNED', 'BROADCAST', 'INCLUDED', 'FINALIZED',
      'SETTLEMENT_REQUESTED', 'SETTLED', 'SETTLEMENT_FAILED', 'REVERTED', 'DROPPED',
      'CANCELLED', // G0-AUDIT (v-4)
    ]],
    ['paymentKindValues', schema.paymentKindValues, [
      'SPEND', 'FUND_MILESTONE', 'RELEASE_MILESTONE', 'OWNER_SPEND', 'WITHDRAW_RESERVE',
    ]],
    ['payoutStatusValues', schema.payoutStatusValues, ['NONE', 'REQUESTED', 'SUCCEEDED', 'FAILED']],
    ['exceptionKindValues', schema.exceptionKindValues, [
      'RAISE_CAP', 'ADD_PAYEE', 'EXTEND_EXPIRY', 'MOVE_POCKETS', 'UNPAUSE', 'WITHDRAW_RESERVE',
      'RELEASE_ESCROW_BALANCE', 'RELEASE_STAGE', 'REPLAN', 'POLICY_ESCALATION',
    ]],
    ['exceptionStatusValues', schema.exceptionStatusValues, [
      'OPEN', 'FOUNDER_SIGNED', 'APPROVED', 'QUEUED', 'EXECUTABLE', 'EXECUTED', 'DENIED',
      'CANCELLED', 'EXPIRED',
    ]],
    ['traceActorValues', schema.traceActorValues, [
      'planner', 'reader', 'policy', 'txbuilder', 'executor', 'worker', 'founder', 'officer',
      'oracle', 'reconciler',
    ]],
    ['traceKindValues', schema.traceKindValues, [
      'LLM_CALL', 'TOOL_CALL', 'PROPOSAL', 'POLICY_VERDICT', 'TX', 'PAYOUT', 'SIGNATURE',
      'EXCEPTION', 'DENIAL', 'ALERT',
    ]],
    ['policyVerdictValues', schema.policyVerdictValues, ['AUTO', 'NEEDS_FOUNDER', 'NEEDS_OFFICER', 'DENY']],
    ['chainActionStateValues', schema.chainActionStateValues, ['PENDING', 'BROADCAST', 'INCLUDED', 'FINALIZED', 'REVERTED']],
    ['shortlistStatusValues', schema.shortlistStatusValues, ['PENDING', 'READY', 'FAILED']],
    ['lineKeyValues', schema.lineKeyValues, [
      'SUPPLIER', 'PACKAGING', 'LOGISTICS', 'ADS', 'PLATFORM_FEES', 'LICENSING', 'CONTINGENCY',
    ]],
    ['countryCodeValues', schema.countryCodeValues, ['MY', 'ID', 'SG']], // SG-DECISIONS: SG appended (0003_sg_country)
    ['residencyValues', schema.residencyValues, ['citizen', 'pr', 'foreigner']],
    ['evidenceTierValues', schema.evidenceTierValues, ['tier1', 'tier2', 'tier3']],
    ['sourceTypeValues', schema.sourceTypeValues, ['live', 'mock']],
    ['signatureKindValues', schema.signatureKindValues, [
      'PlanApproval', 'SupplierApproval', 'MilestoneRelease', 'LoosenRequest', 'StageRelease', 'OwnerSpend',
    ]],
    ['signatureMethodValues', schema.signatureMethodValues, ['passkey', 'eip712']],
    ['payeeKindValues', schema.payeeKindValues, ['supplier', 'platform']],
    ['founderKeyStatusValues', schema.founderKeyStatusValues, ['PENDING_LENDER', 'REGISTERED']],
  ];

  it.each(cases)('%s', (_, actual, expected) => {
    expect([...actual]).toEqual(expected);
  });

  it('pg enums are built from the exported arrays', () => {
    expect(schema.paymentStateEnum.enumValues).toEqual([...schema.paymentStateValues]);
    expect(schema.paymentKindEnum.enumValues).toEqual([...schema.paymentKindValues]);
    expect(schema.payoutStatusEnum.enumValues).toEqual([...schema.payoutStatusValues]);
    expect(schema.exceptionKindEnum.enumValues).toEqual([...schema.exceptionKindValues]);
    expect(schema.exceptionStatusEnum.enumValues).toEqual([...schema.exceptionStatusValues]);
    expect(schema.traceActorEnum.enumValues).toEqual([...schema.traceActorValues]);
    expect(schema.traceKindEnum.enumValues).toEqual([...schema.traceKindValues]);
    expect(schema.policyVerdictEnum.enumValues).toEqual([...schema.policyVerdictValues]);
    expect(schema.chainActionStateEnum.enumValues).toEqual([...schema.chainActionStateValues]);
  });

  it('payments.state / kind / payout_status use those enums', () => {
    const t = tableByName('payments');
    expect(column(t, 'state').getSQLType()).toBe('payment_state');
    expect(column(t, 'kind').getSQLType()).toBe('payment_kind');
    expect(column(t, 'payout_status').getSQLType()).toBe('payout_status');
  });
});

describe('0004_chat_first (VISION-DECISIONS §6)', () => {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0004_chat_first.sql'), 'utf8');

  it('shortlists gain source (catalog default, CHECK catalog|web) and search_json', () => {
    const t = tableByName('shortlists');
    expect(column(t, 'source').notNull).toBe(true);
    expect(column(t, 'source').hasDefault).toBe(true);
    expect(column(t, 'search_json').getSQLType()).toBe('jsonb');
    expect(column(t, 'search_json').notNull).toBe(false);
    expect([...schema.shortlistSourceValues]).toEqual(['catalog', 'web']);
    expect(sql).toContain(`ALTER TABLE "shortlists" ADD COLUMN "source" text DEFAULT 'catalog' NOT NULL;`);
    expect(sql).toContain(`CONSTRAINT "shortlists_source" CHECK ("shortlists"."source" IN ('catalog', 'web'))`);
  });

  it('supplier_terms has the decided columns', () => {
    const cols = columnNames(tableByName('supplier_terms'));
    for (const name of [
      'id', 'facility_id', 'shortlist_id', 'supplier_id', 'chosen_index', 'currency', 'quote_total_minor', 'quantity',
      'terms_json', 'schedule_json', 'payout_account_ref', 'payout_account_hash', 'bank_name', 'payee_type', 'quote_hash',
      'status', 'order_id', 'created_at', 'updated_at',
    ]) {
      expect(cols).toContain(name);
    }
    expect(column(tableByName('supplier_terms'), 'order_id').notNull).toBe(false);
  });

  it('supplier_terms is keyed per facility and points at its supplier, shortlist and escrow order', () => {
    const t = tableByName('supplier_terms');
    expect(hasUnique(t, ['facility_id', 'id'])).toBe(true);
    const fks = foreignKeyRefs(t).map((f) => `${f.columns.join(',')}->${f.foreignTable}`);
    expect(fks).toEqual(
      expect.arrayContaining([
        'facility_id,supplier_id->suppliers',
        'facility_id,shortlist_id->shortlists',
        'facility_id,order_id->escrow_orders',
      ]),
    );
  });

  it('supplier_terms: status CHECK, USED exactly with an order, uint8 index, company payee, hex32 and uint128', () => {
    const checks = checkNames(tableByName('supplier_terms'));
    for (const name of [
      'supplier_terms_status',
      'supplier_terms_used_iff_order',
      'supplier_terms_chosen_index_uint8',
      'supplier_terms_payee_company',
      'supplier_terms_payout_account_hash_hex32',
      'supplier_terms_quote_hash_hex32',
      'supplier_terms_quote_total_minor_uint128',
    ]) {
      expect(checks).toContain(name);
    }
    expect([...schema.supplierTermsStatusValues]).toEqual(['CONFIRMED', 'SUPERSEDED', 'USED']);
    expect(sql).toContain(`CONSTRAINT "supplier_terms_used_iff_order" CHECK (("supplier_terms"."status" = 'USED') = ("supplier_terms"."order_id" IS NOT NULL))`);
  });

  it('one live (CONFIRMED or USED) terms row per supplier and facility', () => {
    const key = uniqueKeys(tableByName('supplier_terms')).find((k) => k.name === 'supplier_terms_facility_supplier_live_unique');
    expect(key?.columns).toEqual(['facility_id', 'supplier_id']);
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "supplier_terms_facility_supplier_live_unique" ON "supplier_terms" USING btree ("facility_id","supplier_id") WHERE "supplier_terms"."status" IN ('CONFIRMED', 'USED');`,
    );
  });

  it('is additive: no DROP, no type change of an existing column', () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
  });
});
