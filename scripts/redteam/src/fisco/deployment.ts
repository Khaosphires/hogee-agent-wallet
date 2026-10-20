/**
 * deployment.json: the mirror's final-2 set as deployed (DeployFinal's manifest + broadcast) and read back from the
 * chain, next to final-2 on Sepolia. Fail closed: the deploy inputs (cooling, loosen timelock, judging window, platform
 * payees) must equal final-2's Sepolia broadcast and the on-chain views; only the chain tag, roles and links differ.
 */
import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";
import { DeploymentFile, DeployManifest, FINAL_2, FISCO_CHAIN_ID, FISCO_CHAIN_TAG, type DeployedName, type Role } from "../../../../tools/verify-evidence/src/fisco/pack";
import { broadcastCreates, CaptureError } from "./capture";
import type { Reader } from "./reads";
import type { SepoliaSource } from "./source";

/** The final-2 DeployFinal broadcast (tracked), copied verbatim into the pack as sepolia-broadcast.json. */
export const SEPOLIA_BROADCAST_FILE = "contracts/broadcast/DeployFinal.s.sol/11155111/run-1792385076465.json";

/** "[0xa, 0xb]" (forge's printed array argument) → ["0xa", "0xb"], lowercase. */
export function parseArrayArg(v: string | undefined): Hex[] {
  if (!v || !/^\[.*\]$/.test(v)) throw new CaptureError(`not a printed array: ${String(v).slice(0, 40)}`);
  const inner = v.slice(1, -1).trim();
  return inner === "" ? [] : inner.split(",").map((x) => x.trim().toLowerCase() as Hex);
}

/** The single sender of the broadcast's deploy txs (Treasury's default ContractAuth admin on FISCO, before G3). */
export function deployerOf(broadcast: unknown): Hex {
  const deployers = new Set([...broadcastCreates(broadcast).values()].map((b) => b.transaction.from.toLowerCase()));
  const [only] = deployers;
  if (deployers.size !== 1 || !only || !/^0x[0-9a-f]{40}$/.test(only)) throw new CaptureError("the deploy txs do not come from one sender");
  return only as Hex;
}

/** The constructor inputs both deploys must share: Treasury(registry, oracle, cooling, links(…, timelock), ids, hashes), PlanRegistry(…, judgingWindowEnd). */
export function deployParams(broadcast: unknown): DeploymentFile["params"] {
  const c = broadcastCreates(broadcast);
  const t = c.get("Treasury")?.arguments;
  const r = c.get("PlanRegistry")?.arguments;
  if (!t || t.length !== 6 || !r || r.length !== 6) throw new CaptureError("the broadcast's Treasury / PlanRegistry arguments are not DeployFinal's");
  const links = /^\((0x[0-9a-fA-F]{40}), (0x[0-9a-fA-F]{40}), (0x[0-9a-fA-F]{40}), ([0-9]+)\)$/.exec(t[3] as string);
  if (!links) throw new CaptureError("the Treasury links argument does not parse");
  return {
    coolingSeconds: String(t[2]),
    loosenTimelockSeconds: links[4] as string,
    judgingWindowEnd: String(r[5]),
    platformPayeeIds: parseArrayArg(t[4]),
    platformPayoutHashes: parseArrayArg(t[5]),
  };
}

/** The mirror's deploy inputs; throws unless they equal final-2's Sepolia broadcast. */
export function checkDeployInputs(broadcast: unknown, sepoliaBroadcastBytes: Uint8Array): DeploymentFile["params"] {
  const params = deployParams(broadcast);
  const sepolia = deployParams(JSON.parse(Buffer.from(sepoliaBroadcastBytes).toString("utf8")) as unknown);
  if (JSON.stringify(params) !== JSON.stringify(sepolia)) throw new CaptureError("the mirror's deploy inputs differ from final-2's Sepolia broadcast");
  return params;
}

export interface DeploymentInputs {
  readonly manifestJson: unknown;
  readonly broadcast: unknown;
  readonly sepoliaBroadcastBytes: Uint8Array;
  readonly src: SepoliaSource;
  readonly reader: Reader;
  readonly roles: Readonly<Record<Exclude<Role, "deployer" | "observer">, Hex>>;
}

/** The deploy manifest, checked: chain 20200, tag fisco, deployment final-2. Addresses lowercased for the replay. */
export function parseDeployManifest(json: unknown): { manifest: DeployManifest; contracts: Record<DeployedName, Hex> } {
  const manifest = DeployManifest.parse(json);
  if (manifest.chainId !== FISCO_CHAIN_ID || manifest.chainTag !== FISCO_CHAIN_TAG || manifest.deploymentId !== FINAL_2.deploymentId) {
    throw new CaptureError(`the deployment manifest is ${manifest.chainTag}/${manifest.deploymentId} on chain ${manifest.chainId}, not ${FISCO_CHAIN_TAG}/${FINAL_2.deploymentId} on ${FISCO_CHAIN_ID}`);
  }
  const c = manifest.contracts;
  const contracts = { PlanRegistry: c.PlanRegistry.address, Treasury: c.Treasury.address, MilestoneEscrow: c.MilestoneEscrow.address, SalesOracle: c.SalesOracle.address };
  return { manifest, contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, v.toLowerCase()])) as Record<DeployedName, Hex> };
}

export async function deploymentFile(x: DeploymentInputs): Promise<DeploymentFile> {
  const { manifest, contracts } = parseDeployManifest(x.manifestJson);
  const creates = broadcastCreates(x.broadcast);
  const deployers = new Set([...creates.values()].map((b) => b.transaction.from.toLowerCase()));
  if (deployers.size !== 1) throw new CaptureError("the deploy txs come from more than one sender");
  const params = checkDeployInputs(x.broadcast, x.sepoliaBroadcastBytes);
  const sepoliaBroadcast = JSON.parse(Buffer.from(x.sepoliaBroadcastBytes).toString("utf8")) as unknown;
  const r = x.reader;
  const [governance, observer, cooling, timelock, judging, founder] = await Promise.all([
    r.view<Hex>("Treasury", "governance"),
    r.view<Hex>("Treasury", "observer"),
    r.view<bigint>("Treasury", "coolingSeconds"),
    r.view<bigint>("Treasury", "loosenTimelockSeconds"),
    r.view<bigint>("PlanRegistry", "judgingWindowEnd"),
    r.view<readonly [Hex, Hex, Hex]>("PlanRegistry", "founderKey"),
  ]);
  if (String(cooling) !== params.coolingSeconds || String(timelock) !== params.loosenTimelockSeconds || String(judging) !== params.judgingWindowEnd) throw new CaptureError("the deployed views disagree with the broadcast's inputs");
  const sepCreates = broadcastCreates(sepoliaBroadcast);
  const sepTreasury = (sepoliaBroadcast as { transactions: { contractName: string; additionalContracts?: { contractName?: string; address: string }[] }[] }).transactions.find((t) => t.contractName === "Treasury");
  const sepGovernance = sepTreasury?.additionalContracts?.find((a) => a.contractName === "TreasuryGovernance")?.address;
  if (!sepGovernance) throw new CaptureError("the Sepolia broadcast does not list TreasuryGovernance");
  for (const [name, b] of sepCreates) if (b.contractAddress?.toLowerCase() !== x.src.contracts[name]) throw new CaptureError(`the Sepolia broadcast's ${name} is not the bundle's`);
  const deployTx = (name: DeployedName): Hex => (creates.get(name) as { hash: string }).hash.toLowerCase() as Hex;
  return DeploymentFile.parse({
    chainTag: FISCO_CHAIN_TAG,
    deploymentId: FINAL_2.deploymentId,
    fiscoMs: false,
    contracts: {
      PlanRegistry: { address: contracts.PlanRegistry, deployTx: deployTx("PlanRegistry") },
      Treasury: { address: contracts.Treasury, deployTx: deployTx("Treasury") },
      TreasuryGovernance: { address: governance.toLowerCase(), deployTx: null },
      MilestoneEscrow: { address: contracts.MilestoneEscrow, deployTx: deployTx("MilestoneEscrow") },
      SalesOracle: { address: contracts.SalesOracle, deployTx: deployTx("SalesOracle") },
    },
    roles: { deployer: [...deployers][0], lender: x.roles.lender, oracle: x.roles.oracle, agent: x.roles.agent, relayer: x.roles.relayer, observer: observer.toLowerCase(), regulator: x.roles.regulator },
    founderKey: { qx: founder[0].toLowerCase(), qy: founder[1].toLowerCase(), ownerEOA: founder[2].toLowerCase() },
    params,
    sepolia: {
      contracts: { ...x.src.contracts, TreasuryGovernance: sepGovernance.toLowerCase() },
      broadcastFile: SEPOLIA_BROADCAST_FILE,
      broadcastKeccak: keccak256(x.sepoliaBroadcastBytes),
    },
    manifestJson: manifest,
  });
}

export const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

/** UTF-8 text that encodes back to exactly `bytes` (a byte-order mark kept); CaptureError for anything else. */
export function broadcastText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CaptureError("the Sepolia broadcast is not UTF-8 text");
  }
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new CaptureError("the Sepolia broadcast text does not encode back to its bytes");
  return text;
}

/**
 * The tracked Sepolia broadcast, read once: `bytes` are what deployment.json's broadcastKeccak hashes and the deploy
 * inputs are checked against, `text` is what the pack stores as sepolia-broadcast.json (the same bytes).
 */
export function readSepoliaBroadcast(path: string): { readonly bytes: Uint8Array; readonly text: string } {
  const bytes = readBytes(path);
  return { bytes, text: broadcastText(bytes) };
}
