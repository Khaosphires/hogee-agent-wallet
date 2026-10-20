/** Plain-English labels for the loan officer's requests (project.md §4 step 10, §26.5; REWRITES B29–B30). */
import type { ExceptionKind, ExceptionRequester, ExceptionStatus } from "@hogee/core";

export const REQUESTER_LABEL: Record<ExceptionRequester, string> = {
  agent: "Hogee's AI",
  founder: "the founder",
  officer: "the loan officer",
  worker: "the system",
};

export const KIND_LABEL: Record<ExceptionKind, string> = {
  RAISE_CAP: "Raise a limit",
  ADD_PAYEE: "Add someone to pay",
  EXTEND_EXPIRY: "Extend a deadline",
  MOVE_POCKETS: "Move between pockets",
  UNPAUSE: "Restart payments",
  WITHDRAW_RESERVE: "Pay tax from tax money",
  RELEASE_ESCROW_BALANCE: "Pay the supplier the balance",
  RELEASE_STAGE: "Release the next budget part",
  REPLAN: "New version of the plan",
  POLICY_ESCALATION: "Payment passed to the loan officer",
};

export const STATUS_LABEL: Record<ExceptionStatus, string> = {
  OPEN: "Waiting for signatures",
  FOUNDER_SIGNED: "Founder signed",
  APPROVED: "Officer approved",
  QUEUED: "Waiting",
  EXECUTABLE: "Wait over",
  EXECUTED: "Done",
  DENIED: "Denied",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
};

export type QueueGroup = "needs-decision" | "timelock" | "closed";

export const STATUS_GROUP: Record<ExceptionStatus, QueueGroup> = {
  OPEN: "needs-decision",
  FOUNDER_SIGNED: "needs-decision",
  APPROVED: "needs-decision",
  QUEUED: "timelock",
  EXECUTABLE: "timelock",
  EXECUTED: "closed",
  DENIED: "closed",
  CANCELLED: "closed",
  EXPIRED: "closed",
};

/**
 * Who can cancel a change during its wait (UX-PLAN D21, REWRITES B21), on the officer's console: on the blockchain only
 * the founder's own key, the lender or a set observer may cancel a queued loosening (TreasuryGovernance.cancelLoosen,
 * L142-147). Never "anyone".
 */
export const WAIT_NOTE =
  "Changes that loosen the rules wait before they happen (a short wait in the demo, 24 hours in real use). You or the founder can cancel them during the wait.";
