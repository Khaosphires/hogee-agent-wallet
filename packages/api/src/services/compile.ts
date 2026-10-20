/**
 * Plan compilation inputs and drafts (§4 stage 2, D6). Every amount, cap, payee and the reserve come from code
 * (@hogee/core compilePlan) with the facility as the CHAIN holds it: cap and reserve floor, the judging-window end, the
 * payee registry (static platform payees + bindings), the founder's owner EOA, the lender and the oracle, and the
 * worker's agent address. A replan compiles against the committed plan exactly as PlanReplan compares it (runtime
 * caps, pocket and agent state, and per line its payees plus the ones bound to it by a signed approval since) and
 * against the intent that plan was compiled from, so the compiler can keep everything the new intent does not change
 * (tighten-only form; code 14 checked).
 */
import {
  ZERO_HEX32,
  committedPlanFromContext,
  compilePlan,
  PlanDraft,
  PlanIntent,
  replanLoosenings,
  type CommittedPlan,
  type CompileFacility,
  type CountryCode,
  type CountryPack,
  type Hex32,
  type RegistryPayee,
} from "@hogee/core";
import type { Address, Hex } from "viem";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import { currencyFor } from "../runtime/env";
import { chainNow, founderKeyOnChain, judgingWindowEnd, lenderOnChain, observerOnChain, oracleOnChain, signedPayeeOnChain, workerRoles } from "./chain";
import { founderRow, requireFacility, type FacilityRow } from "./facility";
import { randomBytes32 } from "./ids";
import { policyWorld, type PolicyWorld } from "./policy-context";
import { committedPlanRow } from "./plans";
import { one, pool, rows, type Q } from "./sql";
import { toBytes32 } from "./tags";

export interface CompileEnv {
  readonly facility: CompileFacility;
  readonly now: bigint;
  readonly agent: Address;
  readonly planId: Hex32;
  readonly current?: CommittedPlan;
  /** Replan only: the intent the committed plan was compiled from (its signed draft's). */
  readonly currentIntent?: PlanIntent;
}

async function boundSuppliers(q: Q, scope: Scope): Promise<RegistryPayee[]> {
  const ms = await rows<{ payee_id: string; cooling_until: string | null; amount_minor: string; auto_release: boolean }>(
    q,
    `select p.id as payee_id, p.cooling_until::text as cooling_until, m.amount_minor::text as amount_minor, m.auto_release
       from payees p join escrow_orders o on o.facility_id = p.facility_id and o.payee_id = p.id
       join escrow_milestones m on m.facility_id = o.facility_id and m.order_id = o.order_id
      where p.facility_id = $1 and p.kind = 'supplier' and p.status in ('COOLING', 'BOUND') order by p.id, m.idx`,
    [scope.facilityId],
  );
  const byPayee = new Map<string, RegistryPayee>();
  for (const m of ms) {
    const prev = byPayee.get(m.payee_id);
    byPayee.set(m.payee_id, {
      payeeId: m.payee_id,
      source: "bound",
      lineKeys: ["SUPPLIER"],
      schedule: [...(prev?.schedule ?? []), { amountMinor: m.amount_minor, autoRelease: m.auto_release }],
      ...(m.cooling_until ? { coolingUntil: m.cooling_until } : {}),
    });
  }
  return [...byPayee.values()];
}

/**
 * The committed plan exactly as PlanReplan compares a re-commit with it: the policy world's committed plan, the
 * pockets' window, pacing and escrow flag, the agent state, and per line its listed payees plus every registry payee
 * of that line bound to it by a signed approval since (Treasury.isSignedPayee; bindPayee, LOOSEN_ADD_PAYEE). A static
 * platform payee the plan no longer lists stays out: its automatic binding is not a signed one.
 */
async function onChainCurrent(deps: ApiDeps, world: PolicyWorld, registry: readonly RegistryPayee[]): Promise<CommittedPlan> {
  const base = committedPlanFromContext(world.ctx);
  const s = world.snapshot;
  const views = new Map(s.lines.map((v) => [v.lineId.toLowerCase(), v]));
  const lines = await Promise.all(
    base.lines.map(async (l) => {
      const lineId = world.manifest.lines.find((m) => m.lineKey === l.lineKey)?.lineId;
      const view = lineId ? views.get(lineId.toLowerCase()) : undefined;
      if (!lineId || !view) return l;
      const candidates = [...new Set(registry.filter((p) => (p.lineKeys as readonly string[]).includes(l.lineKey)).map((p) => p.payeeId))].filter((id) => !l.payeeIds.includes(id));
      const signed = await Promise.all(candidates.map(async (id) => ((await signedPayeeOnChain(deps, lineId as Hex, toBytes32(id), s.blockNumber)) ? id : null)));
      return {
        ...l,
        windowSeconds: String(view.pocket.windowSeconds),
        pacingMinor: view.pocket.pacingMinor.toString(),
        escrowOnly: view.pocket.escrowOnly,
        payeeIds: [...l.payeeIds, ...signed.filter((id): id is string => id !== null)],
      };
    }),
  );
  return { ...base, agent: { address: s.plan.agent.toLowerCase() as Address, expiresAt: s.agentExpiry.toString() }, lines };
}

/** The intent of the committed plan's signed draft (absent or unreadable: none, so the compiler keeps everything). */
async function committedIntent(q: Q, scope: Scope, draftId: string | null): Promise<PlanIntent | undefined> {
  if (!draftId) return undefined;
  const r = await one<{ intent_json: unknown }>(q, "select intent_json from plan_drafts where facility_id = $1 and id = $2", [scope.facilityId, draftId]);
  const parsed = PlanIntent.safeParse(r?.intent_json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * SG-DESIGN fail-open 3: the server's HOGEE_COUNTRY must be the facility's, by the founder row's country and the
 * facility row's currency (the server's own currency included). Otherwise an SG server would compile an MYR facility
 * with the SG pack (or the reverse) and nothing would notice. Refused before the chain is read. Audit run-8: the
 * supplier shortlist prices with the same pack, so it runs this check too (`outcome` names what was not done).
 */
export async function requireServerCountry(deps: ApiDeps, q: Q, scope: Scope, f: FacilityRow, outcome = "nothing was compiled"): Promise<void> {
  const country = deps.config.countryCode;
  const currency = currencyFor(country);
  const founder = await founderRow(q, scope);
  if (!founder) throw fail("CONFLICT", `The facility has no founder, so its country is unknown; ${outcome}`);
  if (founder.country !== country || f.currency !== currency || deps.config.currency !== currency) {
    throw fail("CONFLICT", `This server plans for ${country} (${currency}), but the facility is ${founder.country} (${f.currency}); ${outcome}`);
  }
}

/** `firstPlan`: a new founder's version-1 context (no committed plan to replan against; used by /api/eval/plan). */
export async function compileEnv(deps: ApiDeps, scope: Scope, opts: { readonly firstPlan?: boolean } = {}): Promise<CompileEnv> {
  const db = pool(deps.db);
  const f = await requireFacility(db, scope);
  await requireServerCountry(deps, db, scope, f);
  const [now, jwe, founder, lender, oracle, observer, roles, catalog] = await Promise.all([
    chainNow(deps),
    judgingWindowEnd(deps),
    founderKeyOnChain(deps),
    lenderOnChain(deps),
    oracleOnChain(deps),
    observerOnChain(deps),
    workerRoles(db, deps),
    deps.catalog.payees(),
  ]);
  const platform: RegistryPayee[] = catalog
    .filter((p) => p.source === "platform" && p.lineKey)
    .map((p) => ({ payeeId: p.payeeId, source: "platform", lineKeys: [p.lineKey as NonNullable<typeof p.lineKey>], ...(p.channels ? { channels: p.channels } : {}) }));
  const registry: RegistryPayee[] = [...platform, ...(await boundSuppliers(db, scope))];
  // Audit run-7: the draft id (so the prior intent) and the plan series come from the plan row policyWorld checked
  // against the chain, never from a second read that a commit landing in between could make newer than that world.
  const world = opts.firstPlan || !(await committedPlanRow(db, scope)) ? undefined : await policyWorld(deps, scope);
  const committed = world?.plan;
  const current = world ? await onChainCurrent(deps, world, registry) : undefined;
  const currentIntent = committed ? await committedIntent(db, scope, committed.draft_id) : undefined;
  return {
    facility: {
      facilityId: scope.facilityId,
      countryCode: deps.config.countryCode,
      currency: f.currency,
      capMinor: f.cap_minor,
      reserveFloorBps: Number(f.reserve_floor_bps),
      judgingWindowEnd: jwe.toString(),
      payees: registry,
      ownerEOA: founder.ownerEOA.toLowerCase() as Address,
      lender: lender.toLowerCase() as Address,
      oracle: oracle.toLowerCase() as Address,
      observer: observer.toLowerCase() as Address, // zero = none; the agent must differ from it (code 13)
    },
    now,
    agent: roles.agent,
    planId: (committed?.plan_id ?? randomBytes32()) as Hex32,
    ...(current ? { current } : {}),
    ...(current && currentIntent ? { currentIntent } : {}),
  };
}

export async function packFor(deps: ApiDeps, country: CountryCode): Promise<CountryPack> {
  const pack = await deps.catalog.countryPack(country);
  if (!pack) throw fail("NOT_FOUND", `No ${country} country pack is available yet`);
  return pack;
}

export interface CompileRequest {
  readonly intent: PlanIntent;
  readonly draftId: string;
  readonly env: CompileEnv;
  readonly pack: CountryPack;
  readonly aigc: { readonly model: string; readonly promptHash: Hex32 };
}

export function compileDraft(r: CompileRequest): PlanDraft {
  return compilePlan({
    intent: r.intent,
    countryPack: r.pack,
    facility: r.env.facility,
    now: r.env.now,
    ids: { draftId: r.draftId, planId: r.env.planId, agentAddress: r.env.agent.toLowerCase() as Address },
    aigc: r.aigc,
    ...(r.env.current ? { current: r.env.current } : {}),
    ...(r.env.current && r.env.currentIntent ? { currentIntent: r.env.currentIntent } : {}),
  });
}

export async function storeDraft(q: Q, scope: Scope, d: PlanDraft, links: { sessionId?: string | null; sourceDraftId?: string | null }): Promise<void> {
  await q.query(
    `insert into plan_drafts (id, facility_id, session_id, source_draft_id, country_code, intent_json, manifest_json, baseline_json, diff_json, blast_radius_minor, constitution_report_json)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb)`,
    [
      d.draftId,
      scope.facilityId,
      links.sessionId ?? null,
      links.sourceDraftId ?? null,
      d.manifest.countryCode,
      JSON.stringify(d.intent),
      JSON.stringify(d.manifest),
      JSON.stringify(d.baseline),
      JSON.stringify(d.diff),
      d.blastRadiusMinor,
      JSON.stringify(d.constitutionReport),
    ],
  );
}

interface DraftRow {
  id: string;
  session_id: string | null;
  source_draft_id: string | null;
  intent_json: unknown;
  manifest_json: unknown;
  baseline_json: unknown;
  diff_json: unknown;
  blast_radius_minor: string;
  constitution_report_json: unknown;
}

const DRAFT_COLS = "id, session_id, source_draft_id, intent_json, manifest_json, baseline_json, diff_json, blast_radius_minor::text as blast_radius_minor, constitution_report_json";

function toDraft(r: DraftRow): PlanDraft {
  return PlanDraft.parse({
    draftId: r.id,
    intent: r.intent_json,
    manifest: r.manifest_json,
    baseline: r.baseline_json,
    diff: r.diff_json,
    blastRadiusMinor: r.blast_radius_minor,
    constitutionReport: r.constitution_report_json,
  });
}

export async function loadDraft(q: Q, scope: Scope, draftId: string): Promise<{ draft: PlanDraft; sessionId: string | null; preview: boolean } | undefined> {
  const r = await one<DraftRow>(q, `select ${DRAFT_COLS} from plan_drafts where facility_id = $1 and id = $2`, [scope.facilityId, draftId]);
  return r ? { draft: toDraft(r), sessionId: r.session_id, preview: r.source_draft_id !== null } : undefined;
}

/** The newest non-preview draft of a chat session. */
export async function latestSessionDraft(q: Q, scope: Scope, sessionId: string): Promise<PlanDraft | undefined> {
  const r = await one<DraftRow>(
    q,
    `select ${DRAFT_COLS} from plan_drafts where facility_id = $1 and session_id = $2 and source_draft_id is null order by created_at desc limit 1`,
    [scope.facilityId, sessionId],
  );
  return r ? toDraft(r) : undefined;
}

/**
 * Next version, same predecessor, same agent, within the facility cap, and (for a replan) the same plan series. Before
 * the first commit any planId is fine: the series starts with the version-1 PlanApproval.
 */
function sameBase(d: PlanDraft, env: CompileEnv): boolean {
  const m = d.manifest;
  const prev = env.current ? env.current.planHash : ZERO_HEX32;
  return (
    (env.current ? m.planId === env.planId : true) &&
    m.version === (env.current?.version ?? 0) + 1 &&
    m.prevPlanHash === prev &&
    m.agent.address.toLowerCase() === env.agent.toLowerCase() &&
    BigInt(m.totalMinor) <= BigInt(env.facility.capMinor)
  );
}

/**
 * Still signable: sameBase, and tighten-only against the committed plan as the chain holds it NOW (code 14, audit
 * run-7). A Treasury-only change since the draft was compiled (a TIGHTEN_*, an executed loosening, a new signed
 * binding) does not move the version, so without this a stale draft would be offered and PlanReplan would refuse it.
 */
export function stillCurrent(d: PlanDraft, env: CompileEnv): boolean {
  return sameBase(d, env) && replanLoosenings(d.manifest, env.current).length === 0;
}

/**
 * draftPlan's reuse: a signable draft, or one that already failed code 14 when it was compiled (a genuine loosening,
 * routed through exceptions and never signed as is) while its base holds, so drafting it again writes no new draft.
 * Only a draft that WAS tighten-only and now loosens is compiled again.
 */
export function reusableDraft(d: PlanDraft, env: CompileEnv): boolean {
  const loosenedAtCompile = d.constitutionReport.some((c) => c.code === "REPLAN_LOOSENS" && !c.ok);
  return stillCurrent(d, env) || (loosenedAtCompile && sameBase(d, env));
}

export const NO_AIGC = { model: "none:server-compile", promptHash: ZERO_HEX32 } as const;
