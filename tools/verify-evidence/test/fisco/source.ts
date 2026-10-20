/**
 * The "Sepolia" source bundle of the FISCO fixture: the verify-evidence bundle fixture (test/fixture.ts, Anvil ids)
 * shaped like final-2 (openFacility, registerFounderKey, commitPlan, fund, bindPayee, two milestone fundings, a
 * founder-released milestone 1, pause, two settlement confirmations), with the milestone-1 release re-signed as a real
 * passkey MilestoneRelease (its signatures.json entry added), so T28 has a real foreign-domain signature to replay.
 * Built with @hogee/chain and viem, never the verifier's own helpers.
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseTransaction, toHex, type Hex } from "viem";
import { hashObject } from "@hogee/core";
import { hashHogeeTypedData, hogeeDomain, hogeeTypes, iMilestoneEscrowAbi, iTreasuryAbi, toBytes32Tag } from "@hogee/chain";
import { summaryMarkdown, type SummarySource } from "../../src/index";
import { ADDR, buildFixture, CHAIN_ID, CHAIN_TAG, DEPLOYMENT_ID, KEYS, pauseTx, passkeyAssert, rehash, treasuryCall, treasuryLog, type Fixture } from "../fixture";

export const SOURCE = { runId: "run-test-1", chainId: CHAIN_ID, chainTag: CHAIN_TAG, deploymentId: DEPLOYMENT_ID } as const;
export const ORDER_ID = "order-mirror-001";
export const SUPPLIER = "supplier-mirror";
export const SCHEDULE = [75_000n, 175_000n] as const;
export const settlementIdOf = (idx: number): Hex => keccak256(toHex(`settlement:${ORDER_ID}:${idx}`));
export const PAYOUT_REF = (idx: number): Hex => keccak256(toHex(`payout-ref:${idx}`));

export const webAuthnData = (a: ReturnType<typeof passkeyAssert>): Hex =>
  encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }, { name: "challengeIndex", type: "uint256" }, { name: "typeIndex", type: "uint256" }, { name: "authenticatorData", type: "bytes" }, { name: "clientDataJSON", type: "string" }] }],
    [{ r: a.r, s: a.s, challengeIndex: BigInt(a.challengeIndex), typeIndex: BigInt(a.typeIndex), authenticatorData: a.authenticatorData, clientDataJSON: a.clientDataJSON }],
  );

const confirm = (id: string, after: number, idx: number) => ({
  id, kind: "Treasury.confirmSettlement", after, from: "relayer" as const, to: "Treasury" as const,
  data: treasuryCall("confirmSettlement", [settlementIdOf(idx), PAYOUT_REF(idx)]),
  logs: [treasuryLog("SettlementConfirmed", { settlementId: settlementIdOf(idx), payoutRefHash: PAYOUT_REF(idx) })],
});

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const lowerMessage = (m: Record<string, unknown>): Record<string, string | boolean> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "boolean" ? v : typeof v === "string" ? v.toLowerCase() : String(v)]));

/** Trace hash chains recomputed (a swapped tx hash sits in a TX event's refs). */
function rechain(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const last = new Map<string, string>();
  return events.map((e) => {
    const { hash: _old, ...body } = e;
    const next = { ...body, prevHash: last.get(String(e.traceId)) ?? `0x${"0".repeat(64)}` };
    const hash = hashObject(next);
    last.set(String(e.traceId), hash);
    return { ...next, hash };
  });
}

/** SUMMARY.md regenerated from the edited files, as the exporter writes it. */
function summaryOf(files: Record<string, string>): string {
  const read = (p: string): unknown => JSON.parse(files[p] as string) as unknown;
  const count = (p: string): number => (read(p) as unknown[]).length;
  return summaryMarkdown({
    manifest: read("manifest.json"), contracts: read("contracts.json"), rows: read("evidence.json"), payments: read("payments.json"), chainActions: read("chain-actions.json"),
    counts: { plans: count("plans.json"), signatures: count("signatures.json"), traces: count("traces.json"), llmCalls: count("llm-calls.json"), rationales: count("rationales.json"), receipts: Object.keys(files).filter((p) => p.startsWith("receipts/")).length },
    countryPackIncluded: true,
  } as unknown as SummarySource);
}

export interface Source {
  readonly files: Record<string, string>;
  readonly fixture: Fixture;
  /** The milestone-1 release (passkey) as the source bundle now holds it. */
  readonly release: { readonly hash: Hex; readonly raw: Hex; readonly data: Hex; readonly requestId: string };
}

/** Re-signs the milestone-1 release with a passkey Sig and swaps the tx everywhere (hash and raw are unique strings). */
async function passkeyRelease(fx: Fixture): Promise<Source> {
  const payments = JSON.parse(fx.files["payments.json"] as string) as { payment: { kind: string; txHash: string }; nonce: string; rawSignedTx: string }[];
  const row = payments.find((p) => p.payment.kind === "RELEASE_MILESTONE");
  if (!row) throw new Error("fixture: no RELEASE_MILESTONE row");
  const old = decodeFunctionData({ abi: iMilestoneEscrowAbi, data: parseTransaction(row.rawSignedTx as Hex).data as Hex });
  const req = (old.args as unknown as readonly [Record<string, unknown>])[0];
  const domain = hogeeDomain({ verifyingContract: ADDR.MilestoneEscrow, chainTag: toBytes32Tag(CHAIN_TAG), deploymentId: toBytes32Tag(DEPLOYMENT_ID) });
  const digest = hashHogeeTypedData("MilestoneRelease", domain, req as never);
  const assertion = passkeyAssert(digest);
  const data = encodeFunctionData({ abi: iMilestoneEscrowAbi, functionName: "releaseMilestone", args: [req as never, { kind: 1, data: webAuthnData(assertion) }] });
  const raw = await KEYS.relayer.signTransaction({ chainId: CHAIN_ID, type: "eip1559", nonce: Number(row.nonce), to: ADDR.MilestoneEscrow, data, gas: 900_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n });
  const hash = keccak256(raw);
  const oldHash = row.payment.txHash;
  const files: Record<string, string> = {};
  for (const [path, body] of Object.entries(fx.files)) {
    const newPath = path.replace(oldHash.toLowerCase(), hash.toLowerCase());
    files[newPath] = body.replaceAll(oldHash, hash).replaceAll(oldHash.toLowerCase(), hash.toLowerCase()).replaceAll(row.rawSignedTx, raw);
  }
  const requestId = "sig-release-1";
  const signatures = JSON.parse(files["signatures.json"] as string) as unknown[];
  signatures.push({
    requestId, kind: "MilestoneRelease", refId: ORDER_ID, method: "passkey",
    typedData: { domain: { name: "Hogee", version: "1", verifyingContract: ADDR.MilestoneEscrow, salt: domain.salt }, types: { MilestoneRelease: hogeeTypes.MilestoneRelease.map((t) => ({ ...t })) }, primaryType: "MilestoneRelease", message: lowerMessage(req) },
    digest, status: "SUBMITTED", submission: { passkey: assertion }, chainActionId: null,
  });
  files["signatures.json"] = json(signatures);
  files["traces.json"] = json(rechain(JSON.parse(files["traces.json"] as string) as Record<string, unknown>[]));
  files["SUMMARY.md"] = summaryOf(files);
  return { files: rehash(files), fixture: fx, release: { hash, raw, data, requestId } };
}

/** The source bundle (memoised: building it signs ~20 txs). */
let cached: Promise<Source> | null = null;
export function buildSource(): Promise<Source> {
  cached ??= buildFixture({
    spends: [],
    bind: { orderId: ORDER_ID, payee: SUPPLIER, after: 10, coolingSeconds: 120, schedule: SCHEDULE },
    milestones: [{ idx: 0, amount: SCHEDULE[0], after: 200 }, { idx: 1, amount: SCHEDULE[1], after: 300 }],
    releases: [{ idx: 1, after: 400 }],
    extra: [pauseTx("act-pause", 500, "agent"), confirm("act-confirm-0", 600, 0), confirm("act-confirm-1", 700, 1)],
  }).then(passkeyRelease);
  return cached;
}

export { iTreasuryAbi };
