/**
 * File-backed catalog (P3's data contracts, project.md §26.8): `data/country-packs/<CC>.json` (CountryPack),
 * `data/suppliers/demo/*.json` (a Supplier record, or {supplier, evidence[]}), the raw listing text at the record's
 * `listing.rawTextRef` (repo-relative; untrusted), and the static onboarded payees of the server's HOGEE_COUNTRY
 * (catalog/payees.ts; fail-open 2 of SG-DESIGN §4: never another country's, and none without a country). Every file is
 * validated with the frozen zod schemas; anything malformed, or a pack whose countryCode is not its file's, is skipped
 * and logged, never trusted. The eval datasets (E2 prompts, E3 supplier sets) are read by eval-data.ts with the same
 * rules.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CountryPack, type CountryCode } from "@hogee/core";
import { demoPayeesFor } from "../catalog/payees";
import type { ApiLogger, CatalogPort, OnboardedPayee, SupplierFixture } from "../context";
import { ConfigError } from "../http/problem";
import { e2PromptLoader, supplierSetLoader } from "./eval-data";
import { cachedLoad, completeFixtures, dataRoots, loadSupplierDir, readContainedJson } from "./files";

/** The repo's data/ directory: HOGEE_DATA_DIR, else the first `data/country-packs` parent above the cwd. */
export function findDataDir(explicit: string | undefined, from = process.cwd()): string | undefined {
  // Runtime paths, not bundle inputs: tell Turbopack not to trace the whole project from them.
  if (explicit) return resolve(/*turbopackIgnore: true*/ explicit);
  let dir = resolve(/*turbopackIgnore: true*/ from);
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "data", "schemas"))) return join(dir, "data");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** The payees of `country` (ApiConfig.countryCode); refused without a country or for one with no payee set (ID). */
function payeesOf(country: CountryCode | undefined): readonly OnboardedPayee[] {
  if (!country) throw new ConfigError("The payee catalog needs the server's HOGEE_COUNTRY");
  try {
    return demoPayeesFor(country);
  } catch (error: unknown) {
    throw new ConfigError(error instanceof Error ? error.message : "No demo payees for this country");
  }
}

/** `country`: the server's HOGEE_COUNTRY (deps.config.countryCode), which alone picks the payees. */
export function fileCatalog(dataDir: string | undefined, log: ApiLogger, country?: CountryCode): CatalogPort {
  const roots = dataDir ? dataRoots(dataDir) : undefined;

  const loadPack = async (cc: CountryCode): Promise<CountryPack | null> => {
    if (!dataDir) return null;
    const path = join(dataDir, "country-packs", `${cc}.json`);
    if (!existsSync(path)) return null;
    const parsed = CountryPack.safeParse(await readContainedJson(join(dataDir, "country-packs"), path, log));
    if (!parsed.success) {
      log.error("country_pack_invalid", { country: cc, issue: parsed.error.issues[0]?.path.join(".") });
      return null;
    }
    // Run-8 hardening: a valid pack under another country's file name is refused here, before compilePlan's
    // COUNTRY_MISMATCH, so no reader (the shortlist's landed cost) ever uses another country's facts.
    if (parsed.data.countryCode !== cc) {
      log.error("country_pack_mismatch", { country: cc, packCountry: parsed.data.countryCode });
      return null;
    }
    return parsed.data;
  };

  const loadSuppliers = async (): Promise<readonly SupplierFixture[]> => (dataDir ? loadSupplierDir(join(dataDir, "suppliers", "demo"), roots, log) : []);
  const suppliers = cachedLoad(loadSuppliers, completeFixtures);

  return {
    countryPack: cachedLoad(loadPack, (pack) => pack !== null),
    suppliers: () => suppliers(undefined),
    payees: async () => payeesOf(country),
    e2Prompt: e2PromptLoader(roots?.repo, log),
    supplierEvalSet: supplierSetLoader(dataDir, roots, log),
  };
}
