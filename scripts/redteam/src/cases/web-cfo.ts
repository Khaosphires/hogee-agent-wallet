/**
 * The AI CFO on the WEB world (variant WEB; sepolia-prep TODOs S11, S12):
 *   S11  two signed Stripe test sales are recorded by the oracle; GET /api/cfo then agrees with the chain-backed
 *        balances (revenue, reserve, every pocket's available amount), counts exactly the new sales, links each to its
 *        mined recordSale tx, and always carries the disclaimer; the chat's show_cfo answers with data-cfo
 *   S12  the cfo-guard JOB (not the runner) tightens a line that burns faster than its pace: two logistics invoices on
 *        two days (time travel on Anvil), both mined within stage 1 next to the escrowed demo order (2,500 BU), then
 *        runCfoGuard proposes, re-checks and sends a tighten the agent signs;
 *        nothing is loosened, a second run sends nothing, and the CFO report lists the action with its tx
 */
import { CfoReport, MEI_IDS } from "@hogee/core";
import { runCfoGuard } from "@hogee/worker";
import type { Hex } from "viem";
import { paymentIntentSucceeded, postStripe } from "../api-internals";
import { actionRow, balances, payment, propose, registerInvoice } from "../flows";
import { DAY } from "../stack";
import { firstPart } from "../web/stream";
import type { CaseDef, Ctx } from "./context";
import { WEB_ONLY, act, action, observe, ready } from "./web-lib";

async function cfoReport(ctx: Ctx, label: string): Promise<CfoReport> {
  const r = await ctx.h.get(ctx.s.founder, label, "/api/cfo");
  if (r.status !== 200) throw new Error(`getCfoReport: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return CfoReport.parse(r.json);
}

async function minedSince(ctx: Ctx, kind: string, since: Date): Promise<{ id: string; txHash: Hex | null; state: string }[]> {
  const r = await ctx.s.db.$client.query<{ id: string; tx_hash: Hex | null; state: string }>(
    "select id, tx_hash, state from chain_actions where facility_id = $1 and kind = $2 and created_at >= $3 and coalesce(ref_id, '') not like 'redteam:%' order by created_at",
    [ctx.s.facilityId, kind, since],
  );
  return r.rows.map((x) => ({ id: x.id, txHash: x.tx_hash, state: x.state }));
}

const SALES = [25_000, 15_000] as const;

export const WEB_S11: CaseDef = {
  id: "S11",
  variant: "WEB",
  title: "AI CFO: sales and the tax reserve, checked against the chain",
  layers: "onchain_success recordSale ×2 via the signed webhook · offchain: GET /api/cfo equals /api/balances (revenue, reserve, pockets), counts exactly the 2 new sales, links each to its mined recordSale tx, carries the disclaimer; show_cfo → data-cfo",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    const w = ready(ctx);
    const s = ctx.s;
    const before = await balances(s, ctx.h, "balances before");
    const cfo0 = await cfoReport(ctx, "CFO report before");
    const since = new Date(Date.now() - 1000);
    for (const amount of SALES) {
      const event = paymentIntentSucceeded({ facilityId: s.facilityId, amountMinor: amount, currency: "sgd" });
      const res = await postStripe(s.app, event, s.flags.stripeWebhookSecret as string);
      ctx.h.t.entries.push({ label: "stripe webhook", method: "POST", path: "/api/webhooks/stripe", body: { eventId: event.id, amount }, status: res.status, response: await res.text() });
    }
    await s.pump();
    const sales = await minedSince(ctx, "SalesOracle.recordSale", since);
    const first = sales[0]?.txHash;
    await ctx.tx({ title: `Two signed Stripe test sales (${SALES.join(" + ")} SGD minor): ${sales.filter((x) => x.txHash).length} recordSale tx mined by the oracle`, expected: "success", ok: sales.length === SALES.length && sales.every((x) => x.txHash && x.state !== "REVERTED"), ...(first ? { hash: first } : { facts: null }) });
    const after = await balances(s, ctx.h, "balances after");
    const cfo = await cfoReport(ctx, "CFO report after");
    const mined = new Set(sales.map((x) => x.txHash?.toLowerCase()));
    const linked = cfo.sales.recent.filter((r) => r.txHash && mined.has(r.txHash.toLowerCase())).length;
    const pocketsOff = after.pockets.filter((p) => cfo.spending.byLine.find((l) => l.lineKey === p.lineKey)?.availableMinor !== p.available).map((p) => p.lineKey);
    const checks: [string, boolean][] = [
      [`sales count +${cfo.sales.count - cfo0.sales.count}`, cfo.sales.count - cfo0.sales.count === SALES.length],
      [`revenue ${cfo.overview.revenueMinor} = chain ${after.revenueMinor}`, cfo.overview.revenueMinor === after.revenueMinor],
      [`revenue delta = chain delta`, BigInt(cfo.sales.revenueMinor) - BigInt(cfo0.sales.revenueMinor) === BigInt(after.revenueMinor) - BigInt(before.revenueMinor)],
      [`reserve ${cfo.reserve.balanceMinor} = chain ${after.reserveMinor}`, cfo.reserve.balanceMinor === after.reserveMinor],
      [`reserve skim delta = chain delta`, BigInt(cfo.reserve.skimmedMinor) - BigInt(cfo0.reserve.skimmedMinor) === BigInt(after.reserveMinor) - BigInt(before.reserveMinor)],
      [`pockets off: ${pocketsOff.join(", ") || "none"}`, pocketsOff.length === 0],
      [`${linked}/${SALES.length} new sales linked to their recordSale tx`, linked === SALES.length],
      ["currency SGD, this facility", cfo.currency === "SGD" && cfo.facilityId === s.facilityId],
    ];
    const art = ctx.artifact("cfo", { before: cfo0, after: cfo, balances: { before, after } });
    await observe(ctx, { title: `CFO report vs chain: ${checks.map(([t, ok]) => `${ok ? "ok" : "FAIL"} ${t}`).join("; ")}`.slice(0, 200), expected: "success", ok: checks.every(([, ok]) => ok), artifacts: [art] });
    const turn = await act(ctx, w.sessionId, action({ type: "show_cfo", view: "sales" }));
    const part = firstPart(turn.stream, "data-cfo");
    await observe(ctx, { title: `show_cfo(sales) → data-cfo view ${part?.view ?? "none"}; invalid parts ${turn.stream.invalid.length}`, expected: "success", ok: turn.status === 200 && part?.view === "sales" && turn.stream.invalid.length === 0 });
  },
};

type Pocket = Awaited<ReturnType<typeof balances>>["pockets"][number];
type GuardReport = Awaited<ReturnType<typeof runCfoGuard>>[number];

/** "ok", or why the guard did nothing ("halted", "mismatch", an error): read loosely, the report may grow fields. */
function outcomeOf(r: GuardReport | undefined): string {
  if (!r) return "no report";
  const x = r as GuardReport & { readonly status?: string; readonly error?: string };
  if (x.error) return `error ${x.error}`;
  return x.status ?? "ok";
}
const capsOf = (ps: readonly Pocket[]) => new Map(ps.map((p) => [p.lineKey, { perTx: BigInt(p.perTxCap), window: BigInt(p.windowCap) }]));

export const WEB_S12: CaseDef = {
  id: "S12",
  variant: "WEB",
  title: "The CFO guard job lowers a cap on a burn by itself, and never loosens",
  layers: "onchain_success two LOGISTICS spends mined within stage 1 (the demo order escrowed); Treasury.tighten signed by the agent, sent by the cfo-guard job after two days of logistics spending above pace · offchain: no cap raised; a second run sends nothing; the CFO report lists the action with its tx",
  anvilOnly: WEB_ONLY,
  async run(ctx) {
    ready(ctx);
    const s = ctx.s;
    const b0 = await balances(s, ctx.h, "balances before");
    const logistics = b0.pockets.find((p) => p.lineKey === "LOGISTICS");
    if (!logistics) throw new Error("no LOGISTICS pocket");
    const per = BigInt(logistics.perTxCap) < BigInt(logistics.windowCap) / 2n ? BigInt(logistics.perTxCap) : BigInt(logistics.windowCap) / 2n;
    const paid: string[] = [];
    const paymentIds: string[] = [];
    for (let day = 0; day < 2; day += 1) {
      const inv = await registerInvoice(s, { payeeId: MEI_IDS.logisticsPayeeId, amountMinor: per.toString(), label: `s12-web-${day}` });
      const p = await propose(s, ctx.h, `logistics invoice day ${day + 1}`, { lineKey: "LOGISTICS", invoiceId: inv.id, reason: "courier" });
      await s.agentRound();
      paid.push(`${p.verdict}${p.paymentId ? ` ${p.paymentId}` : ""}`);
      if (p.paymentId) paymentIds.push(p.paymentId);
      await s.clock.advance(DAY + 60n);
      await s.pump();
    }
    // The demo order (2,500 BU) is escrowed in full right after cooling and still leaves stage-1 room: both logistics
    // payments are mined (with the 4,000 BU quote both reverted CapExceeded and there was no burn to react to).
    const spends = await Promise.all(paymentIds.map((id) => payment(s, id)));
    const spent = spends.filter((x) => x?.txHash && x.kind === "SPEND");
    const released = (await balances(s, ctx.h, "balances after the logistics spending")).releasedMinor;
    await ctx.tx({
      title: `Two logistics payments of ${per} minor within stage 1 (released ${released} minor, the demo order escrowed): ${spent.length}/2 mined (${paid.join("; ")})`,
      expected: "success",
      ok: spent.length === 2,
      ...(spent[1]?.txHash ? { hash: spent[1].txHash, traceId: spent[1].traceId } : { facts: null }),
    });
    const caps0 = capsOf((await balances(s, ctx.h, "balances before the guard")).pockets);
    const since = new Date(Date.now() - 1000);
    const [report] = await runCfoGuard(s.workerDeps(), [s.facilityId]);
    await s.pump();
    const sent = report?.tightened ?? [];
    const actions = await Promise.all(sent.map((id) => actionRow(s, id)));
    const mined = actions.filter((a) => a?.txHash && a.state !== "REVERTED");
    const tightenTxs = await minedSince(ctx, "Treasury.tighten", since);
    const caps1 = capsOf((await balances(s, ctx.h, "balances after the guard")).pockets);
    const raised = [...caps1].filter(([k, c]) => {
      const was = caps0.get(k);
      return was !== undefined && (c.perTx > was.perTx || c.window > was.window);
    });
    const lowered = [...caps1].filter(([k, c]) => {
      const was = caps0.get(k);
      return was !== undefined && (c.perTx < was.perTx || c.window < was.window);
    });
    const firstTx = mined[0]?.txHash ?? null;
    await ctx.tx({
      title: `cfo-guard (${outcomeOf(report)}) after logistics spending (${paid.join("; ")}): ${sent.length} tighten(s) sent, ${mined.length} mined; lowered ${lowered.map(([k]) => k).join(", ") || "nothing"}; raised ${raised.map(([k]) => k).join(", ") || "nothing"}`,
      expected: "success",
      ok: outcomeOf(report) === "ok" && mined.length >= 1 && mined.length === sent.length && raised.length === 0 && (lowered.length >= 1 || tightenTxs.length >= 1),
      ...(firstTx ? { hash: firstTx } : { facts: null }),
    });
    const [again] = await runCfoGuard(s.workerDeps(), [s.facilityId]);
    await s.pump();
    await observe(ctx, { title: `A second cfo-guard run the same chain day: ${again?.tightened.length ?? "?"} tighten(s), ${outcomeOf(again)} (idempotent per line per day)`, expected: "success", ok: again !== undefined && again.tightened.length === 0 && outcomeOf(again) === "ok" });
    const cfo = await cfoReport(ctx, "CFO report after the guard");
    const listed = firstTx ? cfo.agentActions.some((a) => a.txHash?.toLowerCase() === firstTx.toLowerCase()) : false;
    await observe(ctx, { title: `The CFO report lists the agent's action with its tx: ${listed}`, expected: "success", ok: listed });
  },
};
