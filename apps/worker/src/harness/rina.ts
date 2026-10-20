/**
 * Rina's facility on a local deployment (§26.1 steps 0, 3, 4; §26.2 numbers), set up the way production does it:
 * every transaction goes through the worker's chain_actions outbox (Postgres nonce, raw tx stored first). The plan
 * is dated from the chain clock (t0 = latest block time), so it stays valid however far Anvil has been warped.
 *
 * - the LENDER registers the founder (an Anvil account, ECDSA-only owner) and opens the facility;
 * - the founder signs the EIP-712 PlanApproval off-chain; the RELAYER submits commitPlan (stage 1 = 400,000);
 * - the LENDER funds 1,000,000.
 */
import {
  buildCommitPlan,
  buildFund,
  buildOpenFacility,
  buildRegisterFounderKey,
  hashLines,
  hashStages,
  hogeeDomain,
  hogeeTypedData,
  manifestToLines,
  manifestToStages,
  toBytes32Tag,
  toTxRequest,
  type DeploymentManifest,
  type HogeeCall,
  type HogeePublicClient,
  type PlanApprovalMessage,
  type TxSigner,
} from '@hogee/chain';
import { hashObject, keccak256Utf8, payoutAccountHash, PlanManifest, RINA_LINES, SCHEMA_VERSION, ZERO_HEX32, type LineKey } from '@hogee/core';
import { facilities, payees as payeesTable, planLines, plans, type Db } from '@hogee/db';
import type { Address, Hex } from 'viem';
import type { HDAccount } from 'viem/accounts';
import type { WorkerSigners } from '../config/keys';
import { sendAction, type ActionContext } from '../chain/actions';
import { payoutAccountRef, type PayoutDestination } from '../rail/rail';

const DAY = 86_400n;
export const RINA_CAP_MINOR = 1_000_000n;
export const RINA_RESERVE_FLOOR_BPS = 300;

/** Static platform payees and their test payout accounts (the hash is what Treasury stores at deploy). */
export const PLATFORM_PAYEES = [
  { id: 'shopee-ads', lineKey: 'ADS', displayName: 'Shopee Ads (test)', account: { channel: 'MY_DUITNOW', accountNumber: '1000000001', holderName: 'Shopee Ads Test' } },
  { id: 'shopee-fees', lineKey: 'PLATFORM_FEES', displayName: 'Shopee fees (test)', account: { channel: 'MY_DUITNOW', accountNumber: '1000000002', holderName: 'Shopee Fees Test' } },
  { id: 'spx-logistics', lineKey: 'LOGISTICS', displayName: 'SPX Logistics (test)', account: { channel: 'MY_DUITNOW', accountNumber: '1000000003', holderName: 'SPX Test' } },
] as const;

export type PlatformPayee = { readonly id: string; readonly lineKey: string; readonly displayName: string; readonly account: PayoutDestination };

/** The platform payees with some TEST accounts swapped (tests stage Xendit failures by account number). */
export function platformPayees(accounts: Readonly<Record<string, PayoutDestination>> = {}): readonly PlatformPayee[] {
  return PLATFORM_PAYEES.map((p) => ({ ...p, account: accounts[p.id] ?? p.account }));
}

export function platformPayeeHashes(payees: readonly PlatformPayee[] = PLATFORM_PAYEES): { id: string; payoutAccountHash: Hex }[] {
  return payees.map((p) => ({ id: p.id, payoutAccountHash: payoutAccountHash(p.account) as Hex }));
}

export interface RinaManifestInput {
  readonly planId: Hex;
  readonly facilityId: string;
  readonly agent: Address;
  /** Chain time the plan is dated from. */
  readonly t0: bigint;
  /** Override a line's window cap (live tests: a tight window shows the headroom skip quickly). */
  readonly windowCapMinor?: Partial<Record<LineKey, string>>;
}

export function rinaManifest(i: RinaManifestInput): PlanManifest {
  const at = (days: bigint) => String(i.t0 + days * DAY);
  return PlanManifest.parse({
    schemaVersion: SCHEMA_VERSION,
    planId: i.planId.toLowerCase(),
    version: 1,
    prevPlanHash: ZERO_HEX32,
    facilityId: i.facilityId,
    countryCode: 'MY',
    countryPackVersion: '2026.10-loop',
    countryPackHash: keccak256Utf8('hogee/loop/country-pack-MY'),
    displayCurrency: 'MYR',
    totalMinor: RINA_CAP_MINOR.toString(),
    reserveBps: 500,
    agent: { address: i.agent.toLowerCase(), expiresAt: at(60n) },
    stages: [
      { stageId: 'stage-1', releaseMinor: '400000', gate: null },
      { stageId: 'stage-2', releaseMinor: '600000', gate: { metric: 'salesMinor', target: '200000', deadline: at(30n) } },
    ],
    lines: RINA_LINES.map((l) => ({
      lineKey: l.lineKey,
      lineId: toBytes32Tag(l.lineKey),
      purpose: l.purpose,
      amountMinor: l.amountMinor,
      perTxCapMinor: l.perTxCapMinor,
      windowCapMinor: i.windowCapMinor?.[l.lineKey] ?? l.windowCapMinor,
      windowSeconds: '604800',
      validUntil: at(60n),
      payeeIds: [...l.payeeIds],
      escrowOnly: l.escrowOnly,
      ...(l.pacingPerDayMinor ? { pacing: { period: 'day', amountMinor: l.pacingPerDayMinor } } : {}),
    })),
    rules: [],
    aigc: { model: 'loop-harness', promptHash: keccak256Utf8('hogee/loop/prompt') },
    compilerVersion: '0.1.0',
  });
}

/** facilities + platform payees rows (the facility names the deployment it signs against). */
export async function seedFacility(db: Db, facilityId: string, deployment: DeploymentManifest, lender: Address, payees: readonly PlatformPayee[] = PLATFORM_PAYEES): Promise<void> {
  await db.insert(facilities).values({
    facilityId,
    capMinor: RINA_CAP_MINOR.toString(),
    currency: 'MYR',
    reserveFloorBps: RINA_RESERVE_FLOOR_BPS,
    lenderAddress: lender.toLowerCase(),
    deploymentId: deployment.deploymentId,
    chainId: deployment.chainId,
  });
  for (const p of payees) {
    await db.insert(payeesTable).values({
      id: p.id,
      facilityId,
      kind: 'platform',
      displayName: p.displayName,
      // The exact account fields the rail pays; the worker re-hashes them against the on-chain binding (T1).
      xenditAccountRef: payoutAccountRef(p.account),
      payoutAccountHash: payoutAccountHash(p.account),
      boundLineIds: [toBytes32Tag(p.lineKey)],
      status: 'BOUND',
    });
  }
}

export interface RinaSetup {
  readonly facilityId: string;
  readonly manifest: PlanManifest;
  readonly planHash: Hex;
}

export interface RinaSetupInput {
  readonly db: Db;
  readonly client: HogeePublicClient;
  readonly deployment: DeploymentManifest;
  readonly signers: WorkerSigners;
  readonly founder: HDAccount;
  readonly facilityId: string;
  readonly capWei: bigint;
  readonly windowCapMinor?: RinaManifestInput['windowCapMinor'];
  /** Platform payees as deployed (their payout hashes are fixed in Treasury). */
  readonly payees?: readonly PlatformPayee[];
}

async function settled(client: HogeePublicClient, hash: Hex): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`setup transaction reverted: ${hash}`);
}

/** Seeds the DB and runs steps 0, 3 and 4 on chain; returns the committed manifest. */
export async function setupRina(i: RinaSetupInput): Promise<RinaSetup> {
  const { db, client, deployment, signers, facilityId } = i;
  const ctx: ActionContext = { db, client, deployment, chainId: deployment.chainId, capWei: i.capWei };
  const contracts = deployment.contracts;
  const step = async (id: string, call: HogeeCall, account: TxSigner) => {
    const { stored } = await sendAction(ctx, { facilityId, id: `setup:${id}`, kind: call.kind, request: toTxRequest(call, contracts) }, account);
    await settled(client, stored.txHash);
  };

  await seedFacility(db, facilityId, deployment, signers.lender.address, i.payees);
  await step('register-founder', buildRegisterFounderKey({ qx: ZERO_HEX32 as Hex, qy: ZERO_HEX32 as Hex, ownerEOA: i.founder.address }), signers.lender);
  await step('open-facility', buildOpenFacility({ capMinor: RINA_CAP_MINOR, reserveFloorBps: RINA_RESERVE_FLOOR_BPS }), signers.lender);

  const t0 = (await client.getBlock({ blockTag: 'latest' })).timestamp;
  const planId = keccak256Utf8(`hogee/loop/plan/${facilityId}`) as Hex;
  const manifest = rinaManifest({ planId, facilityId, agent: signers.agent.address, t0, ...(i.windowCapMinor ? { windowCapMinor: i.windowCapMinor } : {}) });
  const planHash = hashObject(manifest) as Hex;
  const lines = manifestToLines(manifest);
  const stages = manifestToStages(manifest);
  const approval: PlanApprovalMessage = {
    planId,
    version: 1,
    prevPlanHash: ZERO_HEX32 as Hex,
    planHash,
    countryPackHash: manifest.countryPackHash as Hex,
    linesHash: hashLines(lines),
    stagesHash: hashStages(stages),
    totalMinor: RINA_CAP_MINOR,
    reserveBps: manifest.reserveBps,
    agent: signers.agent.address,
    agentExpiry: BigInt(manifest.agent.expiresAt),
    deploymentId: toBytes32Tag(deployment.deploymentId),
    nonce: 1n,
    expiry: t0 + DAY,
  };
  const domain = hogeeDomain({ verifyingContract: contracts.PlanRegistry.address, chainTag: toBytes32Tag(deployment.chainTag), deploymentId: toBytes32Tag(deployment.deploymentId) });
  const signature = await i.founder.signTypedData(hogeeTypedData('PlanApproval', domain, approval) as never);
  const planRowId = `plan:${facilityId}:v1`;
  await db.insert(plans).values({
    id: planRowId,
    facilityId,
    planId,
    version: 1,
    prevPlanHash: ZERO_HEX32,
    planHash,
    manifestJson: manifest,
    countryPackHash: manifest.countryPackHash,
    status: 'SUBMITTED',
    signedAt: new Date(),
  });
  for (const l of manifest.lines) {
    await db.insert(planLines).values({
      planId: planRowId,
      facilityId,
      lineKey: l.lineKey,
      lineId: l.lineId,
      purpose: l.purpose,
      amountMinor: l.amountMinor,
      perTxCapMinor: l.perTxCapMinor,
      windowCapMinor: l.windowCapMinor,
      windowSeconds: Number(l.windowSeconds),
      validUntil: BigInt(l.validUntil),
      escrowOnly: l.escrowOnly,
      pacingAmountMinor: l.pacing?.amountMinor ?? null,
      payeeIds: [...l.payeeIds],
    });
  }
  const commit = buildCommitPlan({ approval, lines, stages, founder: { kind: 0, data: signature } });
  const { stored } = await sendAction(ctx, { facilityId, id: 'setup:commit-plan', kind: commit.kind, refId: planRowId, request: toTxRequest(commit, contracts) }, signers.relayer);
  await settled(client, stored.txHash);
  await db.$client.query(`update plans set status = 'COMMITTED', tx_hash = $1 where facility_id = $2 and id = $3`, [stored.txHash.toLowerCase(), facilityId, planRowId]);
  await step('fund', buildFund({ amountMinor: RINA_CAP_MINOR }), signers.lender);
  return { facilityId, manifest, planHash };
}
