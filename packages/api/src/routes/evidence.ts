/**
 * §26.6 evidence (task 1.16): the server facility's bundles under evidence/ and the export that builds them.
 *   GET  /api/evidence/runs                 finished bundles of this facility, newest first
 *   GET  /api/evidence/:runId               manifest + rows + file list
 *   GET  /api/evidence/:runId/files/<path>  one raw file, read with strict containment (evidence/store.ts)
 *   GET  /api/evidence/fisco                FISCO BCOS mirror packs whose source bundle this tenant may read, newest first
 *   GET  /api/evidence/fisco/:packId/files/<path>, /fisco/:packId/anchor   one raw pack file, the pack's Sepolia
 *                                           anchor sidecar (evidence/fisco-store.ts; REG-BRIEF fisco-proof)
 *   POST /api/evidence/export               {runId}: claims the run (idempotent, one at a time) and builds it in the
 *                                           background; the run is listed once it is on disk. An unsettled facility (a
 *                                           row in flight or above the finalized head) is CONFLICT with the reason.
 * Every read is scoped to the server's tenant (a bundle names its facility, deployment and chain; anyone else's is
 * NOT_FOUND, T31). An export within MIN_EXPORT_INTERVAL_S of the last finished run is CONFLICT (evidence/retention.ts).
 */
import type { ApiDeps } from "../context";
import { EvidenceBusyError, exportEvidence, isEvidenceRefusal, tenantOf } from "../evidence/export";
import { listFiscoPacks, readFiscoAnchor, readFiscoFile, type OwnsSource } from "../evidence/fisco-store";
import { getRun, listRuns, ownsRun, readFileResponse, type Tenant } from "../evidence/store";
import { fail } from "../http/problem";
import type { RouteGroup } from "../http/register";

const rootOf = (deps: ApiDeps): string | undefined => deps.config.evidenceDir;

/** A FISCO pack is the tenant's while the Sepolia bundle it mirrors is (the same check as GET /api/evidence/:runId). */
const ownsSourceOf = (root: string, tenant: Tenant): OwnsSource => (runId) => ownsRun(root, runId, tenant);

export const evidenceRoutes: RouteGroup = {
  listEvidenceRuns: async ({ deps, scope }) => {
    const root = rootOf(deps);
    return root ? listRuns(root, tenantOf(deps, scope)) : [];
  },

  getEvidenceRun: async ({ req, deps, scope }) => {
    const root = rootOf(deps);
    const bundle = root ? await getRun(root, req.params.runId, tenantOf(deps, scope)) : null;
    if (!bundle) throw fail("NOT_FOUND", "No such evidence bundle");
    return bundle;
  },

  getEvidenceFile: async ({ req, deps, scope }) => {
    const root = rootOf(deps);
    const res = root ? await readFileResponse(root, req.params.runId, req.params.path, tenantOf(deps, scope)) : null;
    if (!res) throw fail("NOT_FOUND", "No such file in this evidence bundle");
    return res;
  },

  listFiscoPacks: async ({ deps, scope }) => {
    const root = rootOf(deps);
    return root ? listFiscoPacks(root, ownsSourceOf(root, tenantOf(deps, scope))) : [];
  },

  getFiscoFile: async ({ req, deps, scope }) => {
    const root = rootOf(deps);
    const res = root ? await readFiscoFile(root, req.params.packId, req.params.path, ownsSourceOf(root, tenantOf(deps, scope))) : null;
    if (!res) throw fail("NOT_FOUND", "No such file in this FISCO mirror pack");
    return res;
  },

  getFiscoAnchor: async ({ req, deps, scope }) => {
    const root = rootOf(deps);
    const res = root ? await readFiscoAnchor(root, req.params.packId, ownsSourceOf(root, tenantOf(deps, scope))) : null;
    if (!res) throw fail("NOT_FOUND", "This FISCO mirror pack has no Sepolia anchor");
    return res;
  },

  exportEvidence: async ({ deps, scope }) => {
    const root = rootOf(deps);
    if (!root) throw fail("CONFLICT", "No evidence directory is configured (HOGEE_EVIDENCE_DIR)");
    try {
      const { runId } = await exportEvidence(deps, scope, { root });
      return { runId };
    } catch (error: unknown) {
      if (error instanceof EvidenceBusyError) throw fail("CONFLICT", error.message);
      if (isEvidenceRefusal(error)) throw fail("CONFLICT", error.message);
      throw error;
    }
  },
};
