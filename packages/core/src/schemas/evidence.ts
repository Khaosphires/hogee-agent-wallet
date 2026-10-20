/**
 * Evidence bundle (project.md §16, §26.5, §26.8): evidence/<run-id>/evidence.json (EvidenceRow[]),
 * manifest.json (BundleManifest).
 */
import { z } from "zod";
import { ContractErrorName, EVIDENCE_EXPECTEDS, EVIDENCE_LAYERS, EVIDENCE_OUTCOMES, EvidenceTaskId } from "./enums";
import { Address, BlockNumber, ChainId, DecisionId, DeploymentId, Hex32, HttpUrl, Id, IsoDateTime, NonNegInt } from "./primitives";

export const EvidenceRow = z
  .strictObject({
    taskId: EvidenceTaskId,
    title: z.string().min(1).max(200),
    expected: z.enum(EVIDENCE_EXPECTEDS),
    expectedError: ContractErrorName.optional(),
    layer: z.enum(EVIDENCE_LAYERS),
    outcome: z.enum(EVIDENCE_OUTCOMES),
    txHash: Hex32.optional(),
    chainId: ChainId,
    deploymentId: DeploymentId,
    block: BlockNumber.optional(),
    // G0-DECISION: contract/function are required strings but may be "" on offchain / agent_refusal rows.
    contract: z.string().max(64),
    function: z.string().max(64),
    decodedEvent: z.string().min(1).max(500).optional(),
    revertReason: z.string().min(1).max(200).optional(),
    decisionId: DecisionId.optional(),
    traceId: Id.optional(),
    payoutId: Id.optional(),
    explorerUrl: HttpUrl.optional(),
    artifacts: z.array(z.string().min(1).max(300)).describe("Paths relative to the bundle root"),
  })
  .superRefine((row, ctx) => {
    // G0-DECISION: on-chain rows must carry a txHash; agent-refusal rows must carry a traceId (D14).
    if ((row.layer === "onchain_revert" || row.layer === "onchain_success") && !row.txHash) {
      ctx.addIssue({ code: "custom", path: ["txHash"], message: `${row.layer} rows need a txHash` });
    }
    if (row.layer === "agent_refusal" && !row.traceId) {
      ctx.addIssue({ code: "custom", path: ["traceId"], message: "agent_refusal rows need a traceId" });
    }
  });
export type EvidenceRow = z.infer<typeof EvidenceRow>;

export const EvidenceRows = z.array(EvidenceRow);

export const BundleManifest = z.strictObject({
  runId: Id,
  gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  deployments: z.record(
    DeploymentId,
    z.strictObject({
      chainId: ChainId,
      contracts: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/), z.strictObject({ address: Address, verifiedUrl: HttpUrl })),
    }),
  ),
  toolVersions: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

// G0-DECISION: shapes for GET /api/evidence/runs and GET /api/evidence/:runId (spec says only "bundle").
export const EvidenceRunSummary = z.strictObject({
  runId: Id,
  createdAt: IsoDateTime,
  gitCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
  rowCount: NonNegInt,
});
export type EvidenceRunSummary = z.infer<typeof EvidenceRunSummary>;

export const EvidenceBundle = z.strictObject({
  manifest: BundleManifest,
  rows: EvidenceRows,
  files: z.array(z.string().min(1).max(300)).describe("Bundle file paths, fetch via /api/evidence/:runId/files/*"),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundle>;
