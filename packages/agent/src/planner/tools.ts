/**
 * The Planner's tools (project.md §7.5), all typed with zod and narrow:
 * - read-only lookups bound to the request's facility by the caller (no tool takes a facility, tenant or founder id,
 *   so the model cannot ask for another founder's data, T31). Each returns an observation
 *   `{status, summary, source, taint, data}`; untrusted listing text never reaches the Planner, only code-computed values;
 * - two TERMINAL proposals without `execute` (plan-then-execute, §7.2): `askClarifyingQuestions` (slots only) and
 *   `proposePlanIntent` (a PlanIntent). The loop stops when either is called; deterministic code acts on it.
 * Never exposed: transactions, payee or plan writes, URL fetches with user data.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  CountryCode,
  Id,
  IntentSlot,
  PlanIntent,
  type Balances,
  type CountryPack,
  type PlanRecord,
  type Shortlist,
  type Sourced,
} from "@hogee/core";

export const FX_PAIRS = ["CNY/MYR", "USD/MYR", "CNY/IDR", "USD/IDR", "CNY/SGD", "USD/SGD"] as const;
export type FxPair = (typeof FX_PAIRS)[number];

/** Read-only data ports, already scoped to the request's facility by the API (task 1.12). */
export interface PlannerPorts {
  readonly getFx?: (pair: FxPair) => Promise<Sourced<number> | null>;
  readonly getPlan?: () => Promise<PlanRecord | null>;
  readonly getBalances?: () => Promise<Balances | null>;
  readonly getShortlist?: (requestId: string) => Promise<Shortlist | null>;
}

export interface Observation {
  readonly status: "ok" | "not_found" | "error";
  readonly summary: string;
  readonly source: string;
  readonly taint: { readonly trust: "trusted" | "untrusted"; readonly sensitivity: "public" | "private" };
  readonly data: unknown;
}

const TRUSTED = { trust: "trusted", sensitivity: "public" } as const;
const ok = (summary: string, source: string, data: unknown, taint: Observation["taint"] = TRUSTED): Observation => ({ status: "ok", summary, source, taint, data });
const notFound = (summary: string, source: string): Observation => ({ status: "not_found", summary, source, taint: TRUSTED, data: null });

function packSummary(pack: CountryPack) {
  return {
    countryCode: pack.countryCode,
    tier: pack.tier,
    version: pack.version,
    currency: pack.currency,
    entities: (pack.entities ?? []).map((e) => ({ type: e.type, eligibility: e.eligibility.value })),
    productApprovals: Object.fromEntries(Object.entries(pack.productApprovals ?? {}).map(([k, v]) => [k, v?.agency.value ?? null])),
  };
}

function shortlistView(s: Shortlist) {
  // Code-computed fields only: no listing text (names, pros/cons, red-flag excerpts) reaches the Planner.
  return {
    requestId: s.requestId,
    status: s.status,
    candidates: s.candidates.map((c) => ({
      supplierId: c.supplierId,
      rank: c.rank,
      score: c.score,
      evidenceCoverageBps: c.evidenceCoverageBps,
      landedCostTotalMinor: c.landedCost.totalMinor,
      failedGates: c.gates.filter((g) => !g.passed).map((g) => g.gate),
      redFlagCount: c.redFlags.length,
    })),
    excluded: s.excluded,
    rankStabilityPct: s.rankStabilityPct,
  };
}

export const ASK_TOOL = "askClarifyingQuestions";
export const PROPOSE_TOOL = "proposePlanIntent";

export interface PlannerToolOptions {
  /** false withholds getCountryPack (the E2 `no_pack` ablation). Default true. */
  readonly countryPackTool?: boolean;
}

export function plannerTools(pack: CountryPack, ports: PlannerPorts = {}, options: PlannerToolOptions = {}) {
  const packTool = {
    getCountryPack: tool({
      description: "Read-only. Summary of the facility's country pack: entity types, eligibility and product approvals.",
      inputSchema: z.strictObject({ country: CountryCode }),
      execute: async ({ country }): Promise<Observation> =>
        country === pack.countryCode
          ? ok(`${pack.countryCode} pack ${pack.version} (${pack.tier})`, `pack:${pack.countryCode}`, packSummary(pack))
          : { status: "error", summary: `Only the ${pack.countryCode} pack is available for this facility; call again with country ${pack.countryCode}.`, source: "pack", taint: TRUSTED, data: null },
    }),
  };
  const base = {
    [ASK_TOOL]: tool({
      description: "Ask the founder up to 3 clarifying questions. Give only the PlanIntent slots that are missing; the app writes the questions.",
      inputSchema: z.strictObject({ slots: z.array(IntentSlot).min(1).max(3) }),
    }),
    [PROPOSE_TOOL]: tool({
      description:
        "Propose the plan intent once every field is known. Use only what the founder said; list anything you assumed in `assumptions`. " +
        "budgetCeilingMinor is the founder's own stated budget in minor units of the facility currency (SGD 10,000 or RM 10,000 = 1000000). Code compiles all amounts, caps, payees and rules.",
      inputSchema: PlanIntent,
    }),
  };
  const getFx = ports.getFx;
  const getPlan = ports.getPlan;
  const getBalances = ports.getBalances;
  const getShortlist = ports.getShortlist;
  return {
    ...(options.countryPackTool === false ? {} : packTool),
    ...base,
    ...(getFx && {
      getFx: tool({
        description: "Read-only. Central-bank FX rate for a currency pair.",
        inputSchema: z.strictObject({ pair: z.enum(FX_PAIRS) }),
        execute: async ({ pair }): Promise<Observation> => {
          const r = await getFx(pair);
          return r ? ok(`${pair} rate`, r.sourceUrl, r) : notFound(`No rate for ${pair}`, "fx");
        },
      }),
    }),
    ...(getPlan && {
      getPlan: tool({
        description: "Read-only. The founder's current plan (version, status, lines).",
        inputSchema: z.strictObject({}),
        execute: async (): Promise<Observation> => {
          const r = await getPlan();
          return r
            ? ok(`Plan v${r.manifest.version} (${r.status})`, "db:plans", { status: r.status, version: r.manifest.version, totalMinor: r.manifest.totalMinor, lines: r.manifest.lines.map((l) => ({ lineKey: l.lineKey, amountMinor: l.amountMinor })) })
            : notFound("No plan yet", "db:plans");
        },
      }),
    }),
    ...(getBalances && {
      getBalances: tool({
        description: "Read-only. Current pocket balances of the founder's plan.",
        inputSchema: z.strictObject({}),
        execute: async (): Promise<Observation> => {
          const r = await getBalances();
          return r ? ok("Balances", "chain:treasury", { paused: r.paused, pockets: r.pockets.map((p) => ({ lineKey: p.lineKey, available: p.available, spent: p.spent })) }) : notFound("No balances yet", "chain:treasury");
        },
      }),
    }),
    ...(getShortlist && {
      getShortlist: tool({
        description: "Read-only. A supplier shortlist computed by code (scores, gates, landed cost). No listing text.",
        inputSchema: z.strictObject({ requestId: Id }),
        execute: async ({ requestId }): Promise<Observation> => {
          const r = await getShortlist(requestId);
          return r
            ? ok(`Shortlist ${r.requestId} (${r.status})`, `db:shortlists:${r.requestId}`, shortlistView(r), { trust: "untrusted", sensitivity: "public" })
            : notFound(`No shortlist ${requestId}`, "db:shortlists");
        },
      }),
    }),
  };
}
