/**
 * Deployment manifests: packages/chain/deployments/<chain>-<deploymentId>.json, written by the deploy script
 * (project.md §8.1, §26.9). The single source of contract addresses.
 *
 * Plain TypeScript validation on purpose (no zod from @hogee/core), so this package stays dependency-light.
 * `parseDeployment` is isomorphic; `loadDeployment` needs Node >= 22.3 (process.getBuiltinModule), so
 * browser bundles never pull in node:fs.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { toBytes32Tag } from './eip712';

export const CONTRACT_NAMES = ['PlanRegistry', 'Treasury', 'MilestoneEscrow', 'SalesOracle'] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

export interface DeployedContract {
  readonly address: Address;
  readonly verifiedUrl?: string;
}

/**
 * G0-DECISION: MilestoneEscrow and SalesOracle are optional because `loop-1` deploys only PlanRegistry +
 * Treasury (D17). `chainTag` and `deploymentId` are the human labels; on-chain they are toBytes32Tag(label).
 */
export interface DeploymentContracts {
  readonly PlanRegistry: DeployedContract;
  readonly Treasury: DeployedContract;
  readonly MilestoneEscrow?: DeployedContract;
  readonly SalesOracle?: DeployedContract;
}

export interface DeploymentManifest {
  readonly chainId: number;
  /** e.g. "loop-1", "final-1" */
  readonly deploymentId: string;
  /** e.g. "sepolia", "anvil"; also the <chain> part of the file name */
  readonly chainTag: string;
  readonly contracts: DeploymentContracts;
  readonly blockNumber: number;
  /** ISO-8601 UTC */
  readonly deployedAt: string;
}

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REQUIRED: readonly ContractName[] = ['PlanRegistry', 'Treasury'];

export class DeploymentError extends Error {
  override readonly name = 'DeploymentError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function label(value: unknown, field: string): string {
  if (typeof value !== 'string' || !LABEL_RE.test(value)) {
    throw new DeploymentError(`${field} must be a lowercase label (a-z, 0-9, '-', at most 32 chars)`);
  }
  return value;
}

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DeploymentError(`${field} must be a non-negative integer`);
  }
  return value;
}

function contract(value: unknown, name: ContractName): DeployedContract {
  if (!isRecord(value)) throw new DeploymentError(`contracts.${name} must be an object`);
  const { address, verifiedUrl } = value;
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) {
    throw new DeploymentError(`contracts.${name}.address must be a 20-byte hex address`);
  }
  if (verifiedUrl !== undefined && (typeof verifiedUrl !== 'string' || !/^https:\/\//.test(verifiedUrl))) {
    throw new DeploymentError(`contracts.${name}.verifiedUrl must be an https URL`);
  }
  const checksummed = getAddress(address);
  return verifiedUrl === undefined ? { address: checksummed } : { address: checksummed, verifiedUrl };
}

function contracts(value: unknown): DeploymentContracts {
  if (!isRecord(value)) throw new DeploymentError('contracts must be an object');
  const unknownNames = Object.keys(value).filter((k) => !(CONTRACT_NAMES as readonly string[]).includes(k));
  if (unknownNames.length > 0) throw new DeploymentError(`unknown contracts: ${unknownNames.join(', ')}`);
  for (const name of REQUIRED) {
    if (value[name] === undefined) throw new DeploymentError(`contracts.${name} is required`);
  }
  const entries = CONTRACT_NAMES.filter((name) => value[name] !== undefined).map(
    (name) => [name, contract(value[name], name)] as const,
  );
  return Object.fromEntries(entries) as unknown as DeploymentContracts;
}

/** Validates an untrusted manifest object. Addresses are returned checksummed. */
export function parseDeployment(json: unknown): DeploymentManifest {
  if (!isRecord(json)) throw new DeploymentError('deployment manifest must be a JSON object');
  const deployedAt = json.deployedAt;
  if (typeof deployedAt !== 'string' || Number.isNaN(Date.parse(deployedAt)) || !deployedAt.endsWith('Z')) {
    throw new DeploymentError('deployedAt must be an ISO-8601 UTC timestamp');
  }
  const chainId = nonNegativeInt(json.chainId, 'chainId');
  if (chainId === 0) throw new DeploymentError('chainId must be positive');
  return {
    chainId,
    deploymentId: label(json.deploymentId, 'deploymentId'),
    chainTag: label(json.chainTag, 'chainTag'),
    contracts: contracts(json.contracts),
    blockNumber: nonNegativeInt(json.blockNumber, 'blockNumber'),
    deployedAt,
  };
}

/** "<chain>-<deploymentId>.json", e.g. deploymentFileName('sepolia', 'final-1') = "sepolia-final-1.json". */
export function deploymentFileName(chainTag: string, deploymentId: string): string {
  return `${label(chainTag, 'chainTag')}-${label(deploymentId, 'deploymentId')}.json`;
}

/** The bytes32 values the contracts were constructed with (inputs to the EIP-712 domain salt). */
export function deploymentTags(m: Pick<DeploymentManifest, 'chainTag' | 'deploymentId'>): {
  chainTag: Hex;
  deploymentId: Hex;
} {
  return { chainTag: toBytes32Tag(m.chainTag), deploymentId: toBytes32Tag(m.deploymentId) };
}

export interface LoadDeploymentOptions {
  /** Directory holding the manifests. Default: packages/chain/deployments. */
  readonly dir?: string | URL;
}

/** Reads and validates deployments/<chainTag>-<deploymentId>.json (Node only). */
export function loadDeployment(chainTag: string, deploymentId: string, opts: LoadDeploymentOptions = {}): DeploymentManifest {
  const getBuiltin = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltin !== 'function') {
    throw new DeploymentError('loadDeployment needs Node >= 22.3; in the browser fetch the JSON and use parseDeployment');
  }
  const fs = getBuiltin('node:fs');
  const path = getBuiltin('node:path');
  const { fileURLToPath } = getBuiltin('node:url');
  // Indirect base so bundlers don't treat `new URL(literal, import.meta.url)` as an asset import.
  const moduleUrl = import.meta.url;
  const dir = opts.dir ?? new URL('../deployments/', moduleUrl);
  const dirPath = dir instanceof URL ? fileURLToPath(dir) : path.resolve(dir);
  const file = path.join(dirPath, deploymentFileName(chainTag, deploymentId));
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DeploymentError(`cannot read deployment ${file}: ${reason}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DeploymentError(`deployment ${file} is not valid JSON`);
  }
  const manifest = parseDeployment(json);
  if (manifest.chainTag !== chainTag || manifest.deploymentId !== deploymentId) {
    throw new DeploymentError(`deployment ${file} does not match its file name`);
  }
  return manifest;
}
