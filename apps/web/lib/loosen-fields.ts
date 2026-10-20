/**
 * What each LoosenRequest change kind does with its three free fields, mirrored from the contract that executes it
 * (contracts/src/TreasuryLoosenRules.sol `_checkLoosen` / `_applyLoosen`; kinds in contracts/src/interfaces/HogeeKinds.sol,
 * mirrored in @hogee/api-mock/eip712 LOOSEN_KINDS). A field a kind uses is shown as its own row (signed-rows.ts); a
 * field it doesn't use is signed too, so the browser requires it to be zero (typed-data.ts) instead of letting an
 * unseen value through. loosen-fields.test.ts fails if a kind is added here or there without the other.
 */
import type { TypedData } from "@hogee/core";
import { LOOSEN_KINDS } from "@hogee/api-mock/eip712";

/** How a field is read: a pocket (lineId), a payee id, a pocket or 0 for "all", an amount, a date, an account check code, or unused (must be zero). */
export type LoosenFieldUse = "pocket" | "payee" | "pocketOrAll" | "amount" | "date" | "accountCode" | "zero";

export type LoosenKindName = keyof typeof LOOSEN_KINDS;

export const LOOSEN_FIELD_USE: { readonly [K in LoosenKindName]: { readonly target: LoosenFieldUse; readonly aux: LoosenFieldUse; readonly newValue: LoosenFieldUse } } = {
  // target lineId; newValue the new cap.
  LOOSEN_RAISE_PER_TX_CAP: { target: "pocket", aux: "zero", newValue: "amount" },
  LOOSEN_RAISE_WINDOW_CAP: { target: "pocket", aux: "zero", newValue: "amount" },
  // _addPayee(target payeeId, aux lineId, bytes32(newValue) payoutAccountHash).
  LOOSEN_ADD_PAYEE: { target: "payee", aux: "pocket", newValue: "accountCode" },
  // The contract reverts unless target is 0; newValue the new agentExpiry.
  LOOSEN_EXTEND_AGENT_EXPIRY: { target: "zero", aux: "zero", newValue: "date" },
  // target lineId; newValue the new validUntil.
  LOOSEN_EXTEND_LINE_EXPIRY: { target: "pocket", aux: "zero", newValue: "date" },
  // target the pocket it leaves, aux the pocket it goes to, newValue the amount.
  LOOSEN_MOVE_POCKETS: { target: "pocket", aux: "pocket", newValue: "amount" },
  // _unpause(target): 0 = every payment, else one pocket. newValue is never read.
  LOOSEN_UNPAUSE: { target: "pocketOrAll", aux: "zero", newValue: "zero" },
  // target the tax payee (fixed at deployment); newValue the amount.
  LOOSEN_WITHDRAW_RESERVE: { target: "payee", aux: "zero", newValue: "amount" },
};

const KIND_BY_NUMBER = new Map<string, LoosenKindName>(Object.entries(LOOSEN_KINDS).map(([name, n]) => [String(n), name as LoosenKindName]));

/** The change kind a LoosenRequest message names, or undefined for one the contract doesn't know. */
export const loosenKindOf = (message: TypedData["message"]): LoosenKindName | undefined => KIND_BY_NUMBER.get(String(message.kind ?? ""));

/** The fields of `td` the browser requires to be zero instead of showing them: a LoosenRequest's unused ones, else none. */
export function checkedZeroFields(td: TypedData): string[] {
  if (td.primaryType !== "LoosenRequest") return [];
  const kind = loosenKindOf(td.message);
  if (!kind) return [];
  const use = LOOSEN_FIELD_USE[kind];
  return (["target", "aux", "newValue"] as const).filter((f) => use[f] === "zero");
}

/** True for a bytes32 of zeros or a uint of 0; anything unreadable is not zero (fail closed). */
function isZero(value: unknown): boolean {
  const v = String(value ?? "");
  if (/^0x[0-9a-f]{64}$/i.test(v)) return /^0x0{64}$/i.test(v);
  try {
    return /^[0-9]+$/.test(v) && BigInt(v) === 0n;
  } catch {
    return false;
  }
}

/** The first field this change kind doesn't use that isn't zero, or undefined. */
export function strayLoosenField(td: TypedData): string | undefined {
  return checkedZeroFields(td).find((f) => !isZero(td.message[f]));
}
