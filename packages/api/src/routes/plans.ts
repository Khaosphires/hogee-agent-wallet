/**
 * §26.1 step 2: plan drafts and records. Every amount comes from code (compilePlan) with the facility as the chain
 * holds it. A draft is reused only while it is still signable against the committed plan; otherwise the session's
 * confirmed intent is recompiled. The country preview is off-chain only: a new draft under another pack, with the
 * budget converted at a sourced FX rate, stored with source_draft_id so it can never be signed (PlanApproval refuses).
 */
import {
  ENTITY_TYPES_BY_COUNTRY,
  PlanIntent,
  mulDivFloor,
  rationalOf,
  type CountryCode,
  type CountryPack,
  type EntityType,
  type PlanDraft,
  type PlanRecord,
} from "@hogee/core";
import type { ApiDeps, Scope } from "../context";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";
import { sessionExists, sessionIntent } from "../services/chat-store";
import { NO_AIGC, compileDraft, compileEnv, latestSessionDraft, loadDraft, packFor, reusableDraft, storeDraft, type CompileEnv } from "../services/compile";
import { newId, randomBytes32 } from "../services/ids";
import { committedPlanRow, planRecord, planRows } from "../services/plans";
import { pool } from "../services/sql";

async function draftPlan(deps: ApiDeps, scope: Scope, sessionId: string): Promise<PlanDraft> {
  const db = pool(deps.db);
  if (!(await sessionExists(db, scope, sessionId))) throw fail("NOT_FOUND", "No such chat session");
  const raw = await sessionIntent(db, scope, sessionId);
  if (raw === undefined || raw === null) throw fail("NOT_FOUND", "This chat has no confirmed plan intent yet");
  const intent = PlanIntent.parse(raw);
  const env = await compileEnv(deps, scope);
  const latest = await latestSessionDraft(db, scope, sessionId);
  if (latest && reusableDraft(latest, env)) return latest;
  const pack = await packFor(deps, env.facility.countryCode);
  const draft = compileDraft({ intent, draftId: newId("draft"), env, pack, aigc: latest?.manifest.aigc ?? NO_AIGC });
  await storeDraft(db, scope, draft, { sessionId });
  return draft;
}

/** The first entity type of `country` open to the founder's residency (the pack's eligibility when it lists one). */
function entityFor(intent: PlanIntent, country: CountryCode, pack: CountryPack): EntityType {
  const types = ENTITY_TYPES_BY_COUNTRY[country];
  if (types.includes(intent.entityType)) return intent.entityType;
  const eligible = (t: EntityType) => {
    const e = (pack.entities ?? []).find((x) => x.type === t);
    return e ? e.eligibility.value.includes(intent.residency) : true;
  };
  const pick = types.find(eligible);
  if (!pick) throw fail("COMPILE_FAILED", `No ${country} business type is open to a ${intent.residency}`, { details: { violations: [] } });
  return pick;
}

export async function converter(deps: ApiDeps, from: string, to: string): Promise<(minor: string) => string> {
  if (from === to) return (m) => m;
  const rate = await deps.checks.fx(`${from}/${to}`, new Date(deps.clock()).toISOString().slice(0, 10));
  const r = rationalOf(rate.value);
  return (m) => mulDivFloor(BigInt(m), r.num, r.den).toString();
}

async function previewCountry(deps: ApiDeps, scope: Scope, draftId: string, country: CountryCode): Promise<PlanDraft> {
  const db = pool(deps.db);
  const source = await loadDraft(db, scope, draftId);
  if (!source) throw fail("NOT_FOUND", "No such plan draft");
  const env = await compileEnv(deps, scope);
  const pack = await packFor(deps, country);
  const convert = await converter(deps, env.facility.currency, pack.currency);
  const from = source.draft.intent;
  const intent = PlanIntent.parse({ ...from, countryCode: country, entityType: entityFor(from, country, pack), budgetCeilingMinor: convert(from.budgetCeilingMinor) });
  const same = country === env.facility.countryCode;
  const { current: _current, currentIntent: _currentIntent, ...base } = env;
  const previewEnv: CompileEnv = {
    ...base,
    planId: randomBytes32() as CompileEnv["planId"],
    facility: { ...env.facility, countryCode: country, currency: pack.currency, capMinor: convert(env.facility.capMinor), payees: same ? env.facility.payees : [] },
  };
  const draft = compileDraft({ intent, draftId: newId("draft"), env: previewEnv, pack, aigc: NO_AIGC });
  await storeDraft(db, scope, draft, { sessionId: source.sessionId, sourceDraftId: draftId });
  return draft;
}

async function currentPlan(deps: ApiDeps, scope: Scope): Promise<PlanRecord> {
  const row = await committedPlanRow(pool(deps.db), scope);
  if (!row) throw fail("NOT_FOUND", "No plan is committed yet");
  return planRecord(row);
}

async function planVersions(deps: ApiDeps, scope: Scope): Promise<PlanRecord[]> {
  return (await planRows(pool(deps.db), scope)).map(planRecord);
}

export const planRoutes: RouteGroup = {
  draftPlan: ({ req, deps, scope }) => draftPlan(deps, scope, req.body.sessionId),
  previewCountry: ({ req, deps, scope }) => previewCountry(deps, scope, req.body.draftId, req.body.country),
  getCurrentPlan: ({ deps, scope }) => currentPlan(deps, scope),
  listPlanVersions: ({ deps, scope }) => planVersions(deps, scope),
};
