/**
 * The LLM call log maps onto the frozen `llm_calls` table and memory entries onto `memory_entries`
 * (packages/db/src/schema). The assignments below are checked by `pnpm typecheck`; the runtime test pins the keys.
 */
import { describe, expect, it } from "vitest";
import type { llmCalls, memoryEntries, memorySourceValues, llmRoleValues } from "@hogee/db";
import { keccak256Utf8 } from "@hogee/core";
import { toLlmCallRow, type LlmCallRole, type LlmCallRow } from "../src/guard/call-log";
import { MEMORY_SOURCES, createMemoryEntry, type MemoryEntry, type MemorySource } from "../src/memory/memory";

type LlmInsert = typeof llmCalls.$inferInsert;
type MemoryInsert = typeof memoryEntries.$inferInsert;

/** Compile-time: a call-log row is a valid llm_calls insert. */
const asInsert = (r: LlmCallRow): LlmInsert => ({ ...r, paramsJson: r.paramsJson, redactionReport: r.redactionReport, tokens: r.tokens });
/** Compile-time: a memory entry is a valid memory_entries insert (taint is derived from `source`, not stored). */
const asMemoryInsert = (e: MemoryEntry): MemoryInsert => ({
  id: e.id,
  facilityId: e.facilityId,
  sessionId: e.sessionId,
  key: e.key,
  value: e.value,
  source: e.source,
  sourceRef: e.sourceRef,
  hmac: e.hmac,
  createdAt: new Date(e.createdAt),
});
// Enum parity at the type level.
const roles: readonly LlmCallRole[] = [] as (typeof llmRoleValues)[number][];
const sources: readonly (typeof memorySourceValues)[number][] = [] as MemorySource[];

describe("DB parity", () => {
  it("a call record becomes an llm_calls insert with hashes only", () => {
    const row = asInsert(
      toLlmCallRow({
        id: "llm-1",
        facilityId: "fac-rina",
        traceId: "t-1",
        role: "reader",
        provider: "anthropic",
        modelId: "claude-haiku-5-5",
        paramsJson: { maxOutputTokens: 2048 },
        promptHash: keccak256Utf8("prompt"),
        responseHash: keccak256Utf8("response"),
        redactionReport: { entities: [{ type: "MY_NRIC", start: 3, end: 17, part: 1 }], count: 1 },
        latencyMs: 12,
        tokens: { input: 10, output: 5 },
        outcome: "ok",
        finishReason: "stop",
        rawFinishReason: "end_turn",
      }),
    );
    expect(row.promptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(roles).toEqual([]);
  });

  it("memory sources equal the memory_source DB enum", () => {
    expect([...MEMORY_SOURCES]).toEqual(["USER_TURN", "ORACLE_FACT"]);
    const e = createMemoryEntry({ id: "m-1", facilityId: "fac-rina", sessionId: null, key: "slot:buyFrom", value: "CN", source: "USER_TURN", sourceRef: "msg-1", createdAt: "2026-10-16T01:00:00Z" }, new Uint8Array(32).fill(2));
    expect(asMemoryInsert(e).hmac).toBe(e.hmac);
    expect(sources).toEqual([]);
  });
});
