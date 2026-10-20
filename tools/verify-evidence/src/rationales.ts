/**
 * "rationale commitments": every decision's rationaleHash is recomputed from its stored preimage —
 * keccak256(utf8(JCS(rationale))) (every writer today), or keccak256(utf8(JCS(rationale)) ‖ salt) when a salt is
 * present (§7.2) — and must equal the payment row's hash and the hash the chain recorded (Spent / MilestoneFunded
 * rationaleHash, Denied proposalHash), with the same decisionId. Every submitted deployment post-dates task 1.16, so
 * every decision must ship its preimage: an entry marked `unavailable` fails (run-6 v-4: the marker was
 * self-declared, so it could withhold any decision's justification), and so does a wrong or tampered preimage.
 */
import { concatBytes, keccak256 } from "viem";
import { hashObject, jcs } from "@hogee/core";
import type { ParsedBundle, RationaleEntry } from "./bundle";
import type { ChainEvent } from "./chain";
import { decisionIdToBytes32, hexToBytesOrNull, Problems, utf8Bytes, type VerifyCheck } from "./util";

/** The commitment of a preimage; null when it is not plain JSON data. */
export function commitmentOf(rationale: unknown, salt: string | null): string | null {
  try {
    if (salt === null) return hashObject(rationale);
    return keccak256(concatBytes([utf8Bytes(jcs(rationale)), hexToBytesOrNull(salt) as Uint8Array]));
  } catch {
    return null;
  }
}

type Ref = { readonly what: string; readonly hash: string; readonly decisionId: string | null };

function refsOf(b: ParsedBundle, events: readonly ChainEvent[]): Ref[] {
  const refs: Ref[] = [];
  for (const { payment } of b.payments) {
    if (payment.rationaleHash) refs.push({ what: `payment ${payment.paymentId}`, hash: payment.rationaleHash, decisionId: payment.decisionId });
  }
  for (const ev of events) {
    if (ev.name === "Spent" || ev.name === "MilestoneFunded") {
      refs.push({ what: `${ev.name} in ${ev.txHash.slice(0, 10)}…`, hash: String(ev.args.rationaleHash).toLowerCase(), decisionId: String(ev.args.decisionId).toLowerCase() });
    } else if (ev.name === "Denied") {
      refs.push({ what: `Denied in ${ev.txHash.slice(0, 10)}…`, hash: String(ev.args.proposalHash).toLowerCase(), decisionId: String(ev.args.decisionId).toLowerCase() });
    }
  }
  return refs;
}

/** A ref's decisionId is a UUID (rows) or its bytes32 form (events). */
const sameDecision = (entry: RationaleEntry, ref: Ref): boolean =>
  entry.decisionId === null || ref.decisionId === null || ref.decisionId === entry.decisionId || ref.decisionId === decisionIdToBytes32(entry.decisionId);

export function checkRationales(b: ParsedBundle, events: readonly ChainEvent[]): VerifyCheck {
  const p = new Problems("rationale commitments");
  const byHash = new Map<string, RationaleEntry>();
  let recomputed = 0;
  for (const e of b.rationales) {
    if (byHash.has(e.rationaleHash)) p.add(`rationale ${e.rationaleHash.slice(0, 10)}… is listed twice`);
    byHash.set(e.rationaleHash, e);
    if (e.status !== "available") {
      p.add(`rationale ${e.rationaleHash.slice(0, 10)}…: the preimage is withheld (marked unavailable); every decision must ship it`);
      continue;
    }
    const got = commitmentOf(e.rationale, e.salt);
    if (got !== e.rationaleHash) p.add(`rationale ${e.rationaleHash.slice(0, 10)}…: the preimage hashes to ${got ?? "nothing (not JSON data)"}`);
    else recomputed += 1;
  }
  for (const ref of refsOf(b, events)) {
    const entry = byHash.get(ref.hash);
    if (!entry) {
      p.add(`${ref.what}: no preimage entry for rationaleHash ${ref.hash.slice(0, 10)}…`);
      continue;
    }
    if (!sameDecision(entry, ref)) p.add(`${ref.what}: the preimage belongs to another decision`);
  }
  return p.result(`${recomputed} rationale preimages re-hash to their commitments`);
}

