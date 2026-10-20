/**
 * Seed data for the in-memory store (project.md §26.7), per demo (profile.ts; SG-DECISIONS: Mei is the main demo).
 *
 * Source order per file, validated with the frozen schema in SCENARIO_RINA_FILE_SCHEMAS:
 *   - MY (Rina): fixtures/scenario-rina/<file> (P3), or evidence/<runId>/scenario/<file> in REPLAY mode; a missing file
 *     falls back to the matching @hogee/core example.
 *   - SG (Mei): fixtures/scenario-mei/<file> when P3 adds one (or the REPLAY snapshot); a missing file falls back to
 *     Rina's scenario re-issued for Mei (scenario-mei.ts), so the mock serves Mei before P3's Mei fixtures exist.
 * A file is read as evidence.ts reads bundle files (readInside): never through a link, a hard link or a special file,
 * and at most MAX_FIXTURE_BYTES; a REPLAY snapshot folder must be a plain folder of a plain run folder. A file that
 * exists but is any of those, or fails validation, throws: a broken fixture must never be served silently. A scenario whose
 * facility, founder or plan country is not the configured one throws too, and so does an SG scenario that carries
 * any Malaysian label: SG never shows Malaysia's names (country-switch previews aside).
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  RINA_IDS,
  SCENARIO_RINA_FILE_SCHEMAS,
  exampleAutonomyStats,
  exampleBalances,
  exampleChatMessages,
  exampleEscrowSchedule,
  exampleExceptions,
  exampleFacility,
  exampleOwnerSpendPayment,
  examplePayment,
  examplePlanDraft,
  examplePlanRecord,
  exampleSession,
  exampleShortlist,
  exampleSupplierWithEvidence,
  exampleTraceEvent,
  exampleWithdrawReservePayment,
  type EscrowSchedule,
  type PlanDraft,
  type ScenarioRinaFile,
  type Shortlist,
  type SupplierWithEvidence,
} from "@hogee/core";
import { MAX_INDEX_FILE_BYTES, isRealDir, readInside } from "./evidence";
import { PROFILES, type DemoProfile, type MockCountry } from "./profile";
import { findMyLabel, meiPlanDraft, meiScenario, meiShortlist, meiSupplier, remapIds } from "./scenario-mei";

type Schemas = typeof SCENARIO_RINA_FILE_SCHEMAS;
export type Scenario = { -readonly [F in ScenarioRinaFile]: z.output<Schemas[F]> };
/** fixture: P3's file (or the replay snapshot's); example: a core example; derived: Rina's, re-issued for Mei. */
export type SeedSource = "fixture" | "example" | "derived";

const RINA_EXAMPLES: Scenario = {
  "facility.json": exampleFacility,
  "session.json": exampleSession,
  "chat.json": [...exampleChatMessages],
  "plan-draft.json": examplePlanDraft,
  "plan-current.json": examplePlanRecord,
  "shortlist.json": exampleShortlist,
  "suppliers.json": [exampleSupplierWithEvidence],
  "balances.json": exampleBalances,
  "payments.json": [examplePayment, exampleOwnerSpendPayment, exampleWithdrawReservePayment],
  "traces.json": [exampleTraceEvent],
  "exceptions.json": [...exampleExceptions],
  "autonomy.json": exampleAutonomyStats,
  "escrow.json": { [RINA_IDS.supplierAOrderId]: exampleEscrowSchedule },
};

export interface LoadedScenario {
  readonly country: MockCountry;
  readonly scenario: Scenario;
  readonly sources: Readonly<Record<ScenarioRinaFile, SeedSource>>;
  readonly dir: string;
}

/** Where to look for a scenario: the profile's fixture folder, or a REPLAY run's scenario/ snapshot. */
export interface ScenarioPaths {
  readonly repoRoot: string;
  readonly fixturesDir: string;
  readonly replayRunId: string | undefined;
}

/** Deep copy so store mutations never touch the shared example objects. */
const clone = <T>(value: T): T => structuredClone(value);

/** A scenario file is at most this (evidence.ts's index-file cap; P3's largest fixture is about 24 KB). */
export const MAX_FIXTURE_BYTES = MAX_INDEX_FILE_BYTES;

/** False only when nothing is at `path` (a missing file or folder); anything there, a dangling link included, is present. */
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

function readFixture<F extends ScenarioRinaFile>(dir: string, file: F): Scenario[F] | undefined {
  const path = join(dir, file);
  if (!isPresent(path)) return undefined;
  const read = readInside(dir, file, MAX_FIXTURE_BYTES);
  if (!read) throw new Error(`api-mock: ${path} is not a regular, single-link file of at most ${MAX_FIXTURE_BYTES} bytes inside ${dir} (links are never followed)`);
  let json: unknown;
  try {
    json = JSON.parse(read.data.toString("utf8"));
  } catch {
    throw new Error(`api-mock: ${path} is not JSON`);
  }
  const parsed = SCENARIO_RINA_FILE_SCHEMAS[file].safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`api-mock: ${path} does not match its frozen schema (${issues})`);
  }
  return parsed.data as Scenario[F];
}

/** Every file from `dir` when present, else from `fallback` (labelled `fallbackSource`). */
function loadFrom(dir: string, fallback: Scenario, fallbackSource: SeedSource): { scenario: Scenario; sources: Record<ScenarioRinaFile, SeedSource> } {
  const scenario = {} as Scenario;
  const sources = {} as Record<ScenarioRinaFile, SeedSource>;
  for (const file of Object.keys(SCENARIO_RINA_FILE_SCHEMAS) as ScenarioRinaFile[]) {
    const fixture = readFixture(dir, file);
    (scenario as Record<ScenarioRinaFile, unknown>)[file] = fixture ?? clone(fallback[file]);
    sources[file] = fixture === undefined ? fallbackSource : "fixture";
  }
  return { scenario, sources };
}

/**
 * Where the scenario lives: REPLAY bundles may carry a scenario/ snapshot; otherwise P3's fixtures for the profile.
 * The snapshot and its run folder must be plain folders (no link, as evidence.ts reads the run); one reached through a
 * link, or a file in its place, throws rather than seed the store from elsewhere.
 */
export function scenarioDir(paths: ScenarioPaths, profile: DemoProfile): string {
  if (paths.replayRunId) {
    const run = join(paths.repoRoot, "evidence", paths.replayRunId);
    const snapshot = join(run, "scenario");
    if (isRealDir(run) && isRealDir(snapshot)) return snapshot;
    if (isPresent(snapshot)) throw new Error(`api-mock: the REPLAY snapshot ${snapshot} is not a plain folder in a plain run folder (links are never followed)`);
  }
  return join(paths.fixturesDir, profile.scenarioFolder);
}

/** Refuses a scenario that is not the configured founder's (a wrong snapshot or fixture folder), or SG text that is Malaysia's. */
function assertScenarioCountry(s: Scenario, profile: DemoProfile, dir: string): void {
  const facility = s["facility.json"];
  const checks: readonly (readonly [string, unknown, unknown])[] = [
    ["facility currency", facility.currency, profile.currency],
    ["facility id", facility.facilityId, profile.ids.facilityId],
    ["session founder", s["session.json"].founderId, profile.ids.founderId],
    ["draft country", s["plan-draft.json"].intent.countryCode, profile.country],
    ["plan country", s["plan-current.json"].manifest.countryCode, profile.country],
  ];
  const wrong = checks.find(([, got, want]) => got !== want);
  if (wrong) throw new Error(`api-mock: the scenario in ${dir} is not ${profile.founderName}'s (${wrong[0]} ${String(wrong[1])}, HOGEE_COUNTRY=${profile.country} needs ${String(wrong[2])})`);
  const label = profile.country === "SG" ? findMyLabel(s) : undefined;
  if (label) throw new Error(`api-mock: the SG scenario in ${dir} shows Malaysian text at ${label}`);
}

export function loadScenario(paths: ScenarioPaths, country: MockCountry): LoadedScenario {
  const profile = PROFILES[country];
  const dir = scenarioDir(paths, profile);
  const { scenario, sources } =
    country === "MY"
      ? loadFrom(dir, RINA_EXAMPLES, "example")
      : loadFrom(dir, meiScenario(loadFrom(join(paths.fixturesDir, PROFILES.MY.scenarioFolder), RINA_EXAMPLES, "example").scenario), "derived");
  assertScenarioCountry(scenario, profile, dir);
  return { country, scenario, sources, dir };
}

export interface ExampleAliases {
  readonly draft: PlanDraft;
  readonly supplier: SupplierWithEvidence;
  readonly escrow: { readonly orderId: string; readonly schedule: EscrowSchedule };
  readonly shortlist: Shortlist;
}

/**
 * Records the api-contract examples refer to by id, per demo. They are added beside the fixtures (never replacing
 * them), so every ROUTE_EXAMPLES request still finds its record when P3's fixtures use different ids. SG's are the
 * core examples re-issued for Mei (draft-mei-001; order ids follow the live API, order-a-001), so an SG store holds no Malaysian record.
 */
export function exampleAliases(country: MockCountry): ExampleAliases {
  if (country === "MY") {
    return {
      draft: examplePlanDraft,
      supplier: exampleSupplierWithEvidence,
      escrow: { orderId: RINA_IDS.supplierAOrderId, schedule: exampleEscrowSchedule },
      shortlist: exampleShortlist,
    };
  }
  const aliases: ExampleAliases = {
    draft: meiPlanDraft(examplePlanDraft),
    supplier: meiSupplier(exampleSupplierWithEvidence),
    escrow: { orderId: PROFILES.SG.ids.supplierAOrderId, schedule: remapIds(exampleEscrowSchedule) },
    shortlist: meiShortlist(exampleShortlist, [exampleSupplierWithEvidence]),
  };
  const label = findMyLabel(aliases);
  if (label) throw new Error(`api-mock: an SG example alias shows Malaysian text at ${label}`);
  return aliases;
}
