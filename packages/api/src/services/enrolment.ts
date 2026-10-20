/**
 * Founder-key enrolment codes (G2, closes security-audit run-4 lead 5). Before G2 any client that reached the API
 * between `facility/open` and the founder's registration could take the PENDING_LENDER slot. Now:
 *   - the loan officer issues a one-time code: 18 random bytes as base64url (144 bits), valid 15 minutes on the API's
 *     WALL clock (`deps.clock()`, the time base of the WebAuthn registration challenge it is bound to; chain time is for
 *     what the contracts check). Issuing revokes the facility's open code. Only keccak256(utf8(code)) is stored
 *     (Ethereum Keccak-256 through @hogee/core, never NIST SHA3-256) and the code is never logged or traced;
 *   - /register/options compares the presented code's hash with the open code's in constant time and binds the
 *     challenge to that hash; /register/verify consumes the code in the transaction that stores the key.
 * A missing, wrong, used, revoked or expired code is FORBIDDEN, with one message for all of them.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ENROLMENT_CODE_BYTES, ENROLMENT_CODE_TTL_SECONDS, keccak256Utf8, type Hex32 } from "@hogee/core";
import { issueEnrolmentCode, openEnrolmentCode, type OpenEnrolmentCode } from "@hogee/db";
import type { EnrolmentCodeResult } from "@hogee/api-contract";
import type { ApiDeps, Scope } from "../context";
import { fail, type ApiProblem } from "../http/problem";
import { newId } from "./ids";
import { inTx, pool } from "./sql";
import { appendTrace } from "./traces";

/** keccak256(utf8(code)): the only form of a code that is stored or compared. */
export const enrolmentCodeHash = (code: string): Hex32 => keccak256Utf8(code);

/** Constant-time equality of two 32-byte hashes (false for anything else). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a.toLowerCase().replace(/^0x/, ""), "hex");
  const y = Buffer.from(b.toLowerCase().replace(/^0x/, ""), "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

export const noOpenCode = (): ApiProblem =>
  fail("FORBIDDEN", "This enrolment code is not valid (wrong, already used, replaced or expired); ask your loan officer for a new one");

/** The officer's open, unexpired code for this founder at the API's wall clock, or FORBIDDEN. */
export async function requireOpenCode(deps: ApiDeps, scope: Scope): Promise<OpenEnrolmentCode> {
  const open = await openEnrolmentCode(pool(deps.db), scope.facilityId, new Date(deps.clock()));
  if (!open || open.founderId !== scope.founderId) throw noOpenCode();
  return open;
}

/** The open code, only if `presented` is it (hash compared in constant time); else FORBIDDEN. */
export async function requirePresentedCode(deps: ApiDeps, scope: Scope, presented: string): Promise<OpenEnrolmentCode> {
  const presentedHash = enrolmentCodeHash(presented);
  const open = await openEnrolmentCode(pool(deps.db), scope.facilityId, new Date(deps.clock()));
  // Hash and compare even when no code is open, so the answer takes the same work either way.
  const matches = sameHash(presentedHash, open?.codeHash ?? `0x${"00".repeat(32)}`);
  if (!open || !matches || open.founderId !== scope.founderId) throw noOpenCode();
  return open;
}

/** Issues the founder's code (revoking the open one) and returns it, the only time it is ever shown. */
export async function issueCode(deps: ApiDeps, scope: Scope): Promise<EnrolmentCodeResult> {
  const code = randomBytes(ENROLMENT_CODE_BYTES).toString("base64url");
  const now = new Date(deps.clock());
  const expiresAt = new Date(now.getTime() + ENROLMENT_CODE_TTL_SECONDS * 1000);
  await inTx(deps.db, async (q) => {
    const revoked = await issueEnrolmentCode(q, { facilityId: scope.facilityId, founderId: scope.founderId, id: newId("enr"), codeHash: enrolmentCodeHash(code), now, expiresAt });
    await appendTrace(q, {
      facilityId: scope.facilityId,
      traceId: newId("trace"),
      actor: "officer",
      kind: "SIGNATURE",
      summary: `Loan officer issued a one-time passkey enrolment code for the founder, valid until ${expiresAt.toISOString()}${revoked > 0 ? " (the previous code is revoked)" : ""}`,
    });
  });
  return { code, expiresAt: expiresAt.toISOString() };
}
