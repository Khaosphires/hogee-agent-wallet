/**
 * Chat sessions, messages and agent memory.
 *
 * G0-DECISION: these tables are not in §12.1. They back `POST /api/chat`, `GET /api/chat/:sessionId`,
 * `POST /api/plans/draft {sessionId}` (§26.6) and the provenance-carrying memory of §7.4.
 */
import { index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, hex32, hex32Checks, tenantFk, updatedAt } from './columns';
import { chatRoleEnum, memorySourceEnum } from './enums';
import { facilityRef, founders } from './tenancy';

/** `sessionId` is a client-generated UUIDv7 (§26.3). */
export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').notNull(),
    facilityId: facilityRef(),
    founderId: text('founder_id'),
    /** Latest PlanIntent (§26.5) confirmed in this session; input to `POST /api/plans/draft`. */
    intentJson: jsonb('intent_json'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // G0-REVIEW (M9): client-generated id, tenant-scoped key.
    primaryKey({ name: 'chat_sessions_pk', columns: [t.facilityId, t.id] }),
    tenantFk('chat_sessions_founder_fk', [t.facilityId, t.founderId], [founders.facilityId, founders.id]),
  ],
);

/**
 * Append-only conversation log (§7.1: never edit earlier turns).
 *
 * G0-DECISION (privacy): `parts_json` stores the REDACTED parts (output of `@hogee/privacy` `redact`),
 * the same text that is sent to the LLM provider. National IDs must never be persisted server-side
 * (§14.1 "nowhere outside the client").
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    /** AI SDK UI message id (client-meaningful). */
    id: text('id').notNull(),
    facilityId: facilityRef(),
    sessionId: uuid('session_id').notNull(),
    seq: integer('seq').notNull(),
    role: chatRoleEnum('role').notNull(),
    /** AI SDK UI message parts, including the frozen `data-*` parts (§26.6). */
    partsJson: jsonb('parts_json').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped keys and FKs.
    primaryKey({ name: 'chat_messages_pk', columns: [t.facilityId, t.id] }),
    uniqueIndex('chat_messages_session_seq_unique').on(t.facilityId, t.sessionId, t.seq),
    tenantFk(
      'chat_messages_session_fk',
      [t.facilityId, t.sessionId],
      [chatSessions.facilityId, chatSessions.id],
    ),
  ],
);

/**
 * §7.4 memory. Written only from authenticated user turns or verified oracle facts; each entry
 * carries provenance (source, source_ref, time) and an HMAC. Append-only; memory never grants
 * capabilities. The `memory_source` enum has no untrusted value, so a listing/invoice/web page can
 * never be persisted as memory (T14).
 */
export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: text('id').notNull(),
    facilityId: facilityRef(),
    sessionId: uuid('session_id'),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    source: memorySourceEnum('source').notNull(),
    /** chat message id (USER_TURN) or verified event / tx hash (ORACLE_FACT). */
    sourceRef: text('source_ref').notNull(),
    /** HMAC-SHA256 over the JCS of the entry without `hmac` (32 bytes, 0x hex). */
    hmac: hex32('hmac').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // G0-REVIEW (M9): tenant-scoped keys and FKs.
    primaryKey({ name: 'memory_entries_pk', columns: [t.facilityId, t.id] }),
    index('memory_entries_facility_key_idx').on(t.facilityId, t.key),
    tenantFk(
      'memory_entries_session_fk',
      [t.facilityId, t.sessionId],
      [chatSessions.facilityId, chatSessions.id],
    ),
    ...hex32Checks('memory_entries', [t.hmac]),
  ],
);
