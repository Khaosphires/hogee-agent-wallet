/** Operational examples (payments, exceptions, traces, balances, escrow, invoices) from the Rina numbers. */
import { RINA_IDS, RINA_PLAN, RINA_SUPPLIER_A_SCHEDULE } from "../../demo/rina";
import type { AutonomyStats, Balances } from "../balances";
import type { EscrowSchedule } from "../escrow";
import type { Exception, ExceptionCreate } from "../exception";
import type { Invoice } from "../invoice";
import type { Payment, SpendProposal, SpendProposalResult } from "../payment";
import { ZERO_HEX32 } from "../primitives";
import type { TraceEvent } from "../trace";
import { fakeAddress, fakeHex32, fakeUuidV7 } from "./fake";

export const examplePayment: Payment = {
  paymentId: "pay-0001",
  kind: "FUND_MILESTONE",
  intentId: fakeHex32("intent:sample"),
  lineKey: "SUPPLIER",
  payeeId: RINA_IDS.supplierAPayeeId,
  amountMinor: "30000",
  invoiceHash: fakeHex32("invoice:supplier-a:sample"),
  planVersion: 1,
  state: "SETTLED",
  txHash: fakeHex32("tx:fundMilestone:0"),
  block: 9_412_345,
  payout: { payoutId: "disb-0001", attempt: 0, status: "SUCCEEDED" },
  decisionId: fakeUuidV7(1),
  rationaleHash: fakeHex32("rationale:sample"),
  traceId: "trace-0001",
  updatedAt: "2026-10-16T03:00:00Z",
};

/** Pacing proposal: the server derives payee (shopee-ads) and amount (pacing 7,500) from the manifest. */
export const exampleSpendProposal: SpendProposal = {
  lineKey: "ADS",
  pacingSlot: 3,
  reason: "Daily ads pacing slot",
};

/** Invoice proposal: the server derives payee and amount from the bound invoice. */
export const exampleInvoiceSpendProposal: SpendProposal = {
  lineKey: "LOGISTICS",
  invoiceId: "inv-0002",
  reason: "Pay the inbound freight invoice",
};

/** Owner's manual fallback spend (no agent decision). */
export const exampleOwnerSpendPayment: Payment = {
  ...examplePayment,
  paymentId: "pay-owner-0001",
  kind: "OWNER_SPEND",
  intentId: fakeHex32("intent:owner-spend"),
  lineKey: "LOGISTICS",
  payeeId: RINA_IDS.logisticsPayeeId,
  amountMinor: "8000",
  invoiceHash: fakeHex32("invoice:spx:owner"),
  txHash: fakeHex32("tx:ownerSpend"),
  payout: { attempt: 0, status: "REQUESTED" },
  state: "SETTLEMENT_REQUESTED",
  decisionId: null,
  rationaleHash: null,
  traceId: "trace-0003",
};

/** Settlement of a reserve withdrawal (no line, no invoice, no agent decision). */
export const exampleWithdrawReservePayment: Payment = {
  ...examplePayment,
  paymentId: "pay-reserve-0001",
  kind: "WITHDRAW_RESERVE",
  intentId: fakeHex32("loosenId:withdraw-reserve"),
  lineKey: null,
  payeeId: RINA_IDS.taxPayeeId,
  amountMinor: "5000",
  invoiceHash: ZERO_HEX32,
  txHash: fakeHex32("tx:executeLoosen:withdraw-reserve"),
  decisionId: null,
  rationaleHash: null,
  traceId: "trace-0004",
};

export const exampleSpendProposalResult: SpendProposalResult = {
  verdict: "AUTO",
  reasonCode: "WITHIN_PLAN",
  traceId: "trace-0002",
  paymentId: "pay-0002",
};

export const exampleInvoice: Invoice = {
  invoiceId: "inv-0001",
  payeeId: RINA_IDS.supplierAPayeeId,
  orderId: RINA_IDS.supplierAOrderId,
  milestoneIdx: 1,
  amountMinor: "120000",
  invoiceHash: fakeHex32("invoice:supplier-a:deposit"),
  extracted: {
    total: { value: "1200.00", unit: "MYR", snippetHash: fakeHex32("snippet:invoice:total") },
    quantity: { value: 1000, unit: "pcs", snippetHash: fakeHex32("snippet:invoice:qty") },
  },
  taint: { trust: "untrusted", sensitivity: "private" },
  flags: [],
  receivedAt: "2026-10-17T02:00:00Z",
};

const exceptionBase = {
  requestedBy: "founder" as const,
  requires: { founder: true, lender: true },
  status: "OPEN" as const,
  timelock: null,
  txs: {},
  blastRadiusMinor: "0",
  traceId: "trace-0100",
};

/** One example per exception kind. */
export const exampleExceptions: readonly Exception[] = [
  {
    ...exceptionBase,
    exceptionId: "exc-raise-cap",
    kind: "RAISE_CAP",
    title: "Raise ADS per-transaction cap to 40,000",
    payload: { lineKey: "ADS", cap: "perTx", newCapMinor: "40000" },
    status: "QUEUED",
    timelock: { queuedAt: "1792202400", executableAt: "1792202520" },
    txs: { queue: fakeHex32("tx:queueLoosen:raise-cap") },
    blastRadiusMinor: "10000",
  },
  {
    ...exceptionBase,
    exceptionId: "exc-add-payee",
    kind: "ADD_PAYEE",
    title: "Add a packaging printer as payee",
    payload: { payeeId: RINA_IDS.packagingPayeeId, lineKey: "PACKAGING" },
    blastRadiusMinor: "75000",
  },
  {
    ...exceptionBase,
    exceptionId: "exc-extend-expiry",
    kind: "EXTEND_EXPIRY",
    title: "Extend the agent key by 30 days",
    payload: { target: "agent", newExpiresAt: String(Number(RINA_PLAN.agentExpiresAt) + 30 * 86_400) },
  },
  {
    ...exceptionBase,
    exceptionId: "exc-move-pockets",
    kind: "MOVE_POCKETS",
    title: "Move 20,000 from CONTINGENCY to ADS",
    payload: { fromLineKey: "CONTINGENCY", toLineKey: "ADS", amountMinor: "20000" },
    blastRadiusMinor: "20000",
  },
  {
    ...exceptionBase,
    exceptionId: "exc-unpause",
    kind: "UNPAUSE",
    title: "Unpause the ADS line (closes its circuit breaker)",
    payload: { lineKey: "ADS" },
    status: "EXECUTED",
    timelock: { queuedAt: "1792202400", executableAt: "1792202520" },
    txs: { queue: fakeHex32("tx:queueLoosen:unpause"), execute: fakeHex32("tx:executeLoosen:unpause") },
  },
  {
    ...exceptionBase,
    exceptionId: "exc-withdraw-reserve",
    kind: "WITHDRAW_RESERVE",
    // G2: within exampleBalances.reserveMinor (2,500 minor); the title is the live API's (services/exceptions titleOf).
    title: `Withdraw 20 BU from the reserve to ${RINA_IDS.taxPayeeId}`,
    payload: { amountMinor: "2000", taxPayeeId: RINA_IDS.taxPayeeId },
    blastRadiusMinor: "2000",
  },
  {
    ...exceptionBase,
    exceptionId: "exc-release-balance",
    kind: "RELEASE_ESCROW_BALANCE",
    title: "Release the 70% balance to Supplier A",
    payload: { orderId: RINA_IDS.supplierAOrderId, idx: 2, evidenceHash: fakeHex32("evidence:inspection") },
    requires: { founder: true, lender: false },
    status: "FOUNDER_SIGNED",
    blastRadiusMinor: "280000",
  },
  {
    ...exceptionBase,
    exceptionId: "exc-release-stage",
    kind: "RELEASE_STAGE",
    title: "Release stage 2 (sales target met)",
    payload: { stageId: RINA_IDS.stage2Id },
    requestedBy: "worker",
    requires: { founder: false, lender: true },
    blastRadiusMinor: "600000",
  },
  {
    ...exceptionBase,
    exceptionId: "exc-replan",
    kind: "REPLAN",
    // G0-AUDIT (v-1): founder-only, so tighten-only (caps, expiries, payees; amounts and stages stay). Moving budget
    // between lines is MOVE_POCKETS (lender + timelock).
    title: "Replan: lower the ADS caps after weak ad returns (tighten-only)",
    payload: { draftId: "draft-rina-002" },
    requires: { founder: true, lender: false },
  },
  {
    ...exceptionBase,
    exceptionId: "exc-escalation",
    kind: "POLICY_ESCALATION",
    title: "Agent spend above the officer threshold",
    payload: {
      // Server-derived from invoice inv-0003 (bound payee spx-logistics), never from the caller.
      proposal: { lineKey: "LOGISTICS", payeeId: RINA_IDS.logisticsPayeeId, amountMinor: "20000", invoiceId: "inv-0003" },
    },
    requestedBy: "agent",
    requires: { founder: false, lender: true },
    status: "DENIED",
    blastRadiusMinor: "25000",
  },
];

export const exampleException: Exception = exampleExceptions[0] as Exception;

export const exampleExceptionCreate: ExceptionCreate = {
  kind: "RAISE_CAP",
  payload: { lineKey: "ADS", cap: "perTx", newCapMinor: "40000" },
  reason: "Campaign week needs larger single ad top-ups",
};

export const exampleTraceEvent: TraceEvent = {
  traceId: "trace-0001",
  seq: 0,
  ts: "2026-10-16T02:59:58Z",
  actor: "policy",
  kind: "POLICY_VERDICT",
  summary: "Fund sample milestone 0 for Supplier A: within the signed schedule",
  verdict: "AUTO",
  reasonCode: "WITHIN_SCHEDULE",
  refs: { planVersion: 1, paymentId: "pay-0001", decisionId: fakeUuidV7(1) },
  prevHash: ZERO_HEX32,
  hash: fakeHex32("trace:0001:0"),
};

export const exampleBalances: Balances = {
  fundedMinor: "1000000",
  releasedMinor: "400000",
  revenueMinor: "50000",
  reserveMinor: "2500",
  escrowMinor: "150000",
  pockets: [
    { lineKey: "SUPPLIER", allocated: "500000", spent: "0", available: "350000", perTxCap: "125000", windowCap: "250000", windowSpent: "0", validUntil: RINA_PLAN.validUntil, paused: false, circuitOpen: false },
    { lineKey: "PACKAGING", allocated: "150000", spent: "0", available: "150000", perTxCap: "37500", windowCap: "75000", windowSpent: "0", validUntil: RINA_PLAN.validUntil, paused: false, circuitOpen: false },
    { lineKey: "LOGISTICS", allocated: "80000", spent: "12000", available: "68000", perTxCap: "20000", windowCap: "40000", windowSpent: "12000", validUntil: RINA_PLAN.validUntil, paused: false, circuitOpen: false },
    { lineKey: "ADS", allocated: "120000", spent: "30000", available: "90000", perTxCap: "30000", windowCap: "60000", windowSpent: "30000", validUntil: RINA_PLAN.validUntil, paused: false, circuitOpen: false },
    { lineKey: "PLATFORM_FEES", allocated: "50000", spent: "3550", available: "46450", perTxCap: "12500", windowCap: "25000", windowSpent: "3550", validUntil: RINA_PLAN.validUntil, paused: false, circuitOpen: false },
    { lineKey: "CONTINGENCY", allocated: "100000", spent: "0", available: "100000", perTxCap: "25000", windowCap: "50000", windowSpent: "0", validUntil: RINA_PLAN.validUntil, paused: false, circuitOpen: false },
  ],
  agent: { address: fakeAddress("agent:final-1"), expiresAt: RINA_PLAN.agentExpiresAt, revoked: false },
  paused: false,
  drift: 0,
};

export const exampleAutonomyStats: AutonomyStats = {
  agentTxs: 104,
  humanSigs: 3,
  autoPct: 92.3,
  escalatedPct: 7.7,
  startedAt: "2026-10-16T01:00:00Z",
  hours: 70.5,
  drift: 0,
};

export const exampleEscrowSchedule: EscrowSchedule = RINA_SUPPLIER_A_SCHEDULE.map((m) => ({
  idx: m.idx,
  amountMinor: m.amountMinor,
  funded: m.autoRelease ? m.amountMinor : "0",
  released: m.autoRelease,
  autoRelease: m.autoRelease,
}));
