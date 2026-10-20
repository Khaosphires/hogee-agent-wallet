/**
 * The deployment manifest (packages/chain/deployments/<chainTag>-<deploymentId>.json, written by the deploy script):
 * the single source of contract addresses. Parsed here with zod instead of @hogee/chain `loadDeployment`, whose
 * module Turbopack cannot bundle (see chain-lib.ts). Same shape and rules: lowercase labels, 20-byte addresses,
 * PlanRegistry + Treasury required. The API serves the `final-1` set, so MilestoneEscrow and SalesOracle are required
 * too (escrow and sales routes need them).
 */
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

const Label = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
const Addr = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "must be a 20-byte address")
  .transform((s) => getAddress(s));
const Contract = z.object({ address: Addr, verifiedUrl: z.string().regex(/^https:\/\//).optional() });

export const DeploymentSchema = z.object({
  chainId: z.number().int().positive(),
  deploymentId: Label,
  chainTag: Label,
  contracts: z.strictObject({
    PlanRegistry: Contract,
    Treasury: Contract,
    MilestoneEscrow: Contract,
    SalesOracle: Contract,
  }),
  blockNumber: z.number().int().min(0),
  deployedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)) && s.endsWith("Z"), "ISO-8601 UTC"),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

export type ContractKey = keyof Deployment["contracts"];

export class DeploymentConfigError extends Error {
  override readonly name = "DeploymentConfigError";
}

export function parseDeploymentJson(json: unknown): Deployment {
  const parsed = DeploymentSchema.safeParse(json);
  if (!parsed.success) throw new DeploymentConfigError(`deployment manifest is invalid: ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
  return parsed.data;
}

/** packages/chain/deployments/<name>, looked up from the working directory upwards (apps/web runs two levels down). */
async function findInRepo(name: string): Promise<string | null> {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, "packages", "chain", "deployments", name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/** Reads DEPLOYMENT_FILE, or packages/chain/deployments/<chainTag>-<deploymentId>.json. */
export async function loadDeploymentFile(opts: { file?: string | undefined; chainTag: string; deploymentId: string }): Promise<Deployment> {
  const name = `${Label.parse(opts.chainTag)}-${Label.parse(opts.deploymentId)}.json`;
  const path = opts.file ?? (await findInRepo(name));
  let raw: string;
  try {
    if (!path) throw new Error("missing");
    raw = await readFile(/*turbopackIgnore: true*/ path, "utf8");
  } catch {
    throw new DeploymentConfigError(`cannot read the deployment manifest ${opts.file ? "DEPLOYMENT_FILE" : name}`);
  }
  const manifest = parseDeploymentJson(JSON.parse(raw) as unknown);
  if (manifest.deploymentId !== opts.deploymentId) throw new DeploymentConfigError("the deployment manifest is not FINAL_DEPLOYMENT_ID");
  return manifest;
}

/** Lowercase address of a deployed contract (the API's wire format, §26.3). */
export function contractAddress(d: Deployment, name: ContractKey): Address {
  return d.contracts[name].address.toLowerCase() as Address;
}
