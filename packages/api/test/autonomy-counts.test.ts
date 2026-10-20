/**
 * rcfix-autonomy (skills re-check W-4): "N AI payments" on the Wallet counts only the payments the agent decided by
 * itself. A founder-signed payment the relayer only carries (RELEASE_MILESTONE: her passkey MilestoneRelease;
 * OWNER_SPEND: her manual fallback) is a person's signature (humanSigs), never also an AI payment. On Sepolia final-2
 * (2 FUND_MILESTONE + 1 RELEASE_MILESTONE) the counter said 3 where the AI made 2. The SQL itself is exercised on
 * Postgres by test/live/web-terms.live.test.ts; here the rule and the query's bound kinds, with no database.
 */
import { NON_AGENT_PAYMENT_KINDS, PAYMENT_KINDS } from "@hogee/core";
import { describe, expect, it } from "vitest";
import { AGENT_PAYMENT_KINDS, autonomyCounts } from "../src/services/dashboard";
import type { Q } from "../src/services/sql";

/** Payment kinds a founder signs; the worker's relayer key only carries them (apps/worker agent-actions-founder.ts). */
const FOUNDER_SIGNED = ["RELEASE_MILESTONE", "OWNER_SPEND"] as const;

function recordingQ(): { q: Q; calls: { text: string; values: readonly unknown[] }[] } {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const query = async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    return { rows: [{ agent_txs: "2", human_sigs: "1", auto: "0", escalated: "0", started_at: null }] };
  };
  return { q: { query } as unknown as Q, calls };
}

describe("agentTxs counts only the payments the agent decided (W-4)", () => {
  it("is SPEND and FUND_MILESTONE: never a founder-signed kind, never a kind without an agent decision", () => {
    expect([...AGENT_PAYMENT_KINDS]).toEqual(["SPEND", "FUND_MILESTONE"]);
    for (const kind of AGENT_PAYMENT_KINDS) expect(PAYMENT_KINDS).toContain(kind);
    for (const kind of [...FOUNDER_SIGNED, ...NON_AGENT_PAYMENT_KINDS]) expect(AGENT_PAYMENT_KINDS).not.toContain(kind);
  });

  it("binds exactly those kinds to the payments count, and no founder-signed kind anywhere in the query", async () => {
    const { q, calls } = recordingQ();
    const row = await autonomyCounts(q, { facilityId: "fac-rina", founderId: "founder-rina" });
    expect(row.agent_txs).toBe("2");
    expect(calls).toHaveLength(1);
    const { text, values } = calls[0] as { text: string; values: readonly unknown[] };
    const from = text.indexOf("from payments where");
    const payments = from < 0 ? "" : text.slice(from, text.indexOf("from chain_actions", from));
    const kindParam = /\bkind(?:::text)? = any\(\$(\d+)::text\[\]\)/.exec(payments)?.[1];
    expect(kindParam, `the payments count filters on kind: ${payments}`).toBeDefined();
    expect(values[Number(kindParam) - 1]).toEqual(AGENT_PAYMENT_KINDS);
    for (const kind of FOUNDER_SIGNED) expect(JSON.stringify(values)).not.toContain(kind);
    expect(text).not.toMatch(/RELEASE_MILESTONE|OWNER_SPEND/);
  });
});
