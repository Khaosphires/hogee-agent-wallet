/** The DB side of a facility the worker serves: its row, its committed plan and its payments (raw, parameterised SQL). */
import { PlanManifest, type LineKey } from '@hogee/core';
import type { Address, Hex } from 'viem';
import type { CommittedPlan } from '../chain/context';
import { rows, type Pg } from '../store/pg';
import type { PaymentRow } from './inflight';

export interface FacilityRow {
  readonly facilityId: string;
  readonly deploymentId: string;
  readonly chainId: number;
  readonly lenderAddress: Address;
}

/** Facilities whose `deployment_id` / `chain_id` name this deployment (one worker serves one deployment). */
export async function facilitiesFor(q: Pg, d: { deploymentId: string; chainId: number }): Promise<FacilityRow[]> {
  const out = await rows<{ facility_id: string; deployment_id: string; chain_id: number; lender_address: string }>(
    q,
    'select facility_id, deployment_id, chain_id, lender_address from facilities where deployment_id = $1 and chain_id = $2 order by facility_id',
    [d.deploymentId, d.chainId],
  );
  return out.map((r) => ({ facilityId: r.facility_id, deploymentId: r.deployment_id, chainId: Number(r.chain_id), lenderAddress: r.lender_address as Address }));
}

/**
 * The facility's latest COMMITTED plan version. Its planId is the one signAndStore needs (PlanApproval.planId of the
 * committed plan, never a value from a proposal); the policy context checks it against the chain.
 */
export async function loadCommittedPlan(q: Pg, facilityId: string): Promise<CommittedPlan | null> {
  const [r] = await rows<{ plan_id: string; version: number; plan_hash: string; manifest_json: unknown }>(
    q,
    `select plan_id, version, plan_hash, manifest_json from plans where facility_id = $1 and status = 'COMMITTED' order by version desc limit 1`,
    [facilityId],
  );
  if (!r) return null;
  return { planId: r.plan_id as Hex, version: Number(r.version), planHash: r.plan_hash as Hex, manifest: PlanManifest.parse(r.manifest_json) };
}

interface PaymentDbRow {
  id: string;
  kind: string;
  state: string;
  line_key: LineKey | null;
  payee_id: string;
  amount_minor: string;
  intent_id: string;
  invoice_hash: string;
  plan_version: number;
  decision_id: string | null;
  rationale_hash: string | null;
  signed: boolean;
  tx_hash: string | null;
  superseded_tx_hashes: string[] | null;
  block: string | null;
}

export async function loadPayments(q: Pg, facilityId: string): Promise<PaymentRow[]> {
  const out = await rows<PaymentDbRow>(
    q,
    `select id, kind, state, line_key, payee_id, amount_minor::text as amount_minor, intent_id, invoice_hash, plan_version, decision_id,
            rationale_hash, raw_signed_tx is not null as signed, tx_hash, superseded_tx_hashes, block::text as block
       from payments where facility_id = $1 order by created_at, id`,
    [facilityId],
  );
  return out.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    lineKey: r.line_key,
    payeeId: r.payee_id,
    amountMinor: r.amount_minor,
    intentId: r.intent_id as Hex,
    invoiceHash: r.invoice_hash as Hex,
    planVersion: Number(r.plan_version),
    decisionId: r.decision_id,
    rationaleHash: r.rationale_hash as Hex | null,
    signed: r.signed,
    txHash: r.tx_hash as Hex | null,
    supersededTxHashes: (r.superseded_tx_hashes ?? []) as Hex[],
    block: r.block === null ? null : BigInt(r.block),
  }));
}
