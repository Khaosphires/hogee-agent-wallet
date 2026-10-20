/**
 * Hogee MCP server (ROLE-P2 2.16; MCP spec 2026-07-28 via the v2 TypeScript SDK): five tools over the HTTP API.
 * Any external agent gets exactly the agent's powers, no more: it can read the plan and evidence, propose a spend
 * (the server derives payee and amount from the signed plan, D6), request a loosening (a human must sign), and pause.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ExceptionCreate, LINE_KEYS, TIMELOCK_EXCEPTION_KINDS, formatBu } from "@hogee/core";
import { HogeeApiError, type HogeeApi } from "./api";

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (summary: string, data: Record<string, unknown>): Result => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }],
  structuredContent: data,
});

const fail = (e: unknown): Result => ({
  content: [{ type: "text", text: e instanceof HogeeApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e) }],
  isError: true,
});

async function guarded(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (e) {
    return fail(e);
  }
}

const LineKeyInput = z.enum(LINE_KEYS);

/** How long propose_spend waits. It never resends: the proposal may have been recorded even if no answer came. */
export const PROPOSE_TIMEOUT_MS = 30_000;
export const UNKNOWN_OUTCOME =
  "Outcome unknown: no complete answer came back, and the proposal may already be recorded. Don't resend it; ask the founder to check the payments list and the timeline, because a resent invoice proposal is recorded as a denial.";

/** No complete answer and not a refused connection: the API may have recorded the proposal. */
const outcomeUnknown = (e: unknown): boolean => e instanceof HogeeApiError && e.status === 0 && e.code !== "UNREACHABLE";

/**
 * The verdict in plain words. AUTO is not a payment yet: the worker re-checks it before paying. ALREADY_PROPOSED_TODAY
 * is the live API's pacing rule: a line pays one pacing slot per chain day, and it counts a slot signed or mined that
 * day, not a proposal.
 */
export function spendSummary(verdict: string, reasonCode: string): string {
  if (verdict === "AUTO") return "Allowed inside the signed plan; the worker re-checks it before paying.";
  if (reasonCode === "ALREADY_PROPOSED_TODAY") {
    return "Not paid: this line's pacing slot for today is already paid or being paid (one slot per line per chain day). Nothing was recorded on-chain for this one; propose again tomorrow.";
  }
  return `Not paid: ${verdict} (${reasonCode}).`;
}

export function createHogeeMcpServer(api: HogeeApi): McpServer {
  const server = new McpServer({ name: "hogee", version: "0.1.0" });

  server.registerTool(
    "get_plan",
    {
      title: "Get the signed plan",
      description: "The current signed plan: budget pockets with their caps and payees, the tax reserve and the stages. Amounts are budget units (BU).",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const plan = await api.call("getCurrentPlan");
        const m = plan.manifest;
        const data = {
          version: m.version,
          status: plan.status,
          planHash: plan.planHash,
          txHash: plan.txHash,
          totalMinor: m.totalMinor,
          reserveBps: m.reserveBps,
          agentExpiresAt: m.agent.expiresAt,
          lines: m.lines.map((l) => ({ lineKey: l.lineKey, amountMinor: l.amountMinor, perTxCapMinor: l.perTxCapMinor, windowCapMinor: l.windowCapMinor, payeeIds: l.payeeIds, escrowOnly: l.escrowOnly, pacingMinor: l.pacing?.amountMinor ?? null })),
          stages: m.stages.map((s) => ({ stageId: s.stageId, releaseMinor: s.releaseMinor, gate: s.gate })),
        };
        return ok(`Plan v${m.version} (${plan.status.toLowerCase()}), total ${formatBu(m.totalMinor)}.`, data);
      }),
  );

  server.registerTool(
    "propose_spend",
    {
      title: "Propose a spend",
      description:
        "Ask the policy engine to pay one bound invoice or one pacing slot of a pocket. You cannot choose a payee or an amount: the server takes both from the invoice or from the signed plan, and refuses anything outside the caps. A line pays one pacing slot per day. Never resend a proposal after a timeout or a lost connection: ask the founder to check the payments list and the timeline, because a resent invoice proposal is recorded as a denial.",
      inputSchema: z.object({
        lineKey: LineKeyInput,
        invoiceId: z.string().min(1).max(128).optional().describe("A bound invoice to pay"),
        pacingSlot: z.number().int().min(0).optional().describe("A pacing slot of a no-invoice line (e.g. ads)"),
        reason: z.string().min(1).max(500),
      }),
    },
    ({ lineKey, invoiceId, pacingSlot, reason }) =>
      guarded(async () => {
        if ((invoiceId === undefined) === (pacingSlot === undefined)) throw new Error("Give exactly one of invoiceId or pacingSlot.");
        const body = invoiceId !== undefined ? { lineKey, invoiceId, reason } : { lineKey, pacingSlot: pacingSlot as number, reason };
        let res;
        try {
          res = await api.call("proposeSpend", { body }, { timeoutMs: PROPOSE_TIMEOUT_MS });
        } catch (e) {
          if (outcomeUnknown(e)) throw new Error(UNKNOWN_OUTCOME);
          throw e;
        }
        return ok(spendSummary(res.verdict, res.reasonCode), { ...res });
      }),
  );

  server.registerTool(
    "request_loosen",
    {
      title: "Request a loosening",
      description:
        "Ask for a change the agent may not make alone (raise a cap, add a payee, extend an expiry, move budget between pockets, unpause, withdraw the reserve). It only opens a request: the founder and the loan officer must sign, then a timelock runs.",
      inputSchema: z.object({
        kind: z.enum(TIMELOCK_EXCEPTION_KINDS),
        payload: z.record(z.string(), z.unknown()).describe("Fields for the kind, e.g. RAISE_CAP: {lineKey, cap: perTx|window, newCapMinor}"),
        reason: z.string().min(1).max(500),
      }),
    },
    ({ kind, payload, reason }) =>
      guarded(async () => {
        const body = ExceptionCreate.parse({ kind, payload, reason });
        const e = await api.call("createException", { body });
        return ok(`Request ${e.exceptionId} opened (${e.status}); it needs ${[e.requires.founder && "the founder", e.requires.lender && "the loan officer"].filter(Boolean).join(" and ")}.`, {
          exceptionId: e.exceptionId,
          status: e.status,
          title: e.title,
          requires: e.requires,
          blastRadiusMinor: e.blastRadiusMinor,
        });
      }),
  );

  server.registerTool(
    "get_evidence",
    {
      title: "Get evidence",
      description: "List the recorded evidence runs, or one run's rows: every executed or blocked action with its tx hash, decision id and trace.",
      inputSchema: z.object({ runId: z.string().min(1).max(128).optional() }),
      annotations: { readOnlyHint: true },
    },
    ({ runId }) =>
      guarded(async () => {
        if (!runId) {
          const runs = await api.call("listEvidenceRuns");
          return ok(`${runs.length} evidence run(s).`, { runs });
        }
        const b = await api.call("getEvidenceRun", { params: { runId } });
        const rows = b.rows.map((r) => ({ taskId: r.taskId, title: r.title, layer: r.layer, outcome: r.outcome, txHash: r.txHash ?? null, revertReason: r.revertReason ?? null, decisionId: r.decisionId ?? null, traceId: r.traceId ?? null }));
        return ok(`${rows.filter((r) => r.outcome === "pass").length} of ${rows.length} rows pass.`, { runId, gitCommit: b.manifest.gitCommit, rows });
      }),
  );

  server.registerTool(
    "pause",
    {
      title: "Pause spending",
      description: "Pause every agent payment at once. Pausing only tightens, so it is instant; unpausing needs both humans and a timelock.",
      inputSchema: z.object({}),
      annotations: { idempotentHint: true, destructiveHint: false },
    },
    () =>
      guarded(async () => {
        const action = await api.call("pause");
        return ok("Spending paused.", { ...action });
      }),
  );

  return server;
}
