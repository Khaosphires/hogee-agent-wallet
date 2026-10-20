/**
 * FISCO BCOS mirror packs (evidence/fisco/fm-<16hex>/ and their Sepolia anchor sidecar; REG-BRIEF fisco-proof), read
 * with the live API's own reader (@hogee/api listFiscoPacks / readFiscoFile / readFiscoAnchor: realpath containment,
 * O_NOFOLLOW, one link, inode match, the pack's caps, inert headers) under the mock's tenant: a pack is listed and
 * served only while its source Sepolia bundle is one the demo may read (evidence.ts ownsEvidenceRun; in REPLAY, only
 * the replayed run). The reader asks that question once per source run within a request (fisco-store.ts oncePerRun,
 * a fresh memo per call) and the listing filters by it before its cap (test/fisco-tenancy.test.ts pins both here).
 * index.ts adds nosniff to every evidence response, errors included.
 */
import { join } from "node:path";
import type { FiscoPackSummary } from "@hogee/api-contract";
import { listFiscoPacks, readFiscoAnchor, readFiscoFile, type OwnsSource } from "@hogee/api";
import type { MockEnv } from "./env";
import { ownsEvidenceRun } from "./evidence";

const rootOf = (env: MockEnv): string => join(env.repoRoot, "evidence");
const ownsOf = (env: MockEnv): OwnsSource => async (runId) => ownsEvidenceRun(env, runId);

export const fiscoPacks = (env: MockEnv): Promise<FiscoPackSummary[]> => listFiscoPacks(rootOf(env), ownsOf(env));

export const fiscoFile = (env: MockEnv, packId: string, path: string): Promise<Response | null> => readFiscoFile(rootOf(env), packId, path, ownsOf(env));

export const fiscoAnchor = (env: MockEnv, packId: string): Promise<Response | null> => readFiscoAnchor(rootOf(env), packId, ownsOf(env));
