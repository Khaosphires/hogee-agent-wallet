/**
 * Founder signature requests (§26.6 signatures/request → submit):
 *   "EIP-712 digests": canonical types, the deployment's domain (salt from chainTag + deploymentId, the struct's
 *     verifying contract), message.deploymentId, and the stored digest recomputed from the JSON message;
 *   "founder signatures": every submitted signature verifies over that digest against the founder key the lender
 *     registered on-chain (its signed registerFounderKey calldata): P-256 for a passkey, ECDSA for the backup owner EOA.
 */
import type { Hex } from "viem";
import type { ParsedBundle, SignatureEntry } from "./bundle";
import type { ChainView } from "./chain";
import { passkeyProblem, recoverEcdsa } from "./crypto";
import { digestOf, domainSalt, typesAreCanonical, VERIFYING_CONTRACT } from "./eip712";
import { Problems, sameHex, tagToBytes32, type VerifyCheck } from "./util";

export interface FounderKey {
  readonly ownerEOA: string;
  readonly qx: Hex;
  readonly qy: Hex;
}

/**
 * The founder key the lender registered: the arguments of the one successful, lender-signed registerFounderKey tx
 * (run-6 v-6: never the FounderKeyRegistered log alone, whose qx / qy are unindexed and outside the bloom; the
 * "event sources" check requires the log to equal this calldata). The lender is the one FacilityOpened event's: with
 * none or several, the key is not trusted (run-6 re-check L6: a bundle that drops openFacility must not skip the lender
 * check and ship a self-registered key). Null when the bundle has no trusted key.
 */
export function founderKeyOf(chain: ChainView, p: Problems): FounderKey | null {
  const regs = [...chain.txs.values()].filter((t) => t.call?.name === "registerFounderKey" && t.receipt?.status === "0x1");
  if (regs.length > 1) p.add(`${regs.length} successful registerFounderKey txs (PlanRegistry allows one)`);
  const reg = regs[0];
  if (!reg?.call || !reg.tx) return null;
  const opened = chain.events.filter((e) => e.name === "FacilityOpened");
  const lender = opened.length === 1 ? opened[0]?.args.lender : undefined;
  if (typeof lender !== "string") {
    p.add(`${opened.length} FacilityOpened events: exactly one must name the lender who signs registerFounderKey`);
    return null;
  }
  if (!sameHex(reg.tx.from, lender)) p.add(`registerFounderKey ${reg.hash.slice(0, 12)}… is not signed by the facility's lender`);
  const [qx, qy, ownerEOA] = reg.call.args as readonly [string, string, string];
  return { ownerEOA: ownerEOA.toLowerCase(), qx: qx.toLowerCase() as Hex, qy: qy.toLowerCase() as Hex };
}

function checkDigest(b: ParsedBundle, s: SignatureEntry, p: Problems): boolean {
  const td = s.typedData;
  const id = `${s.kind} ${s.requestId}`;
  if (td.primaryType !== s.kind) p.add(`${id}: typed data is a ${td.primaryType}`);
  if (!typesAreCanonical(td)) p.add(`${id}: the types are not the canonical HogeeTypes layout`);
  if (td.domain.salt !== domainSalt(b.contracts.chainTag, b.contracts.deploymentId)) p.add(`${id}: the domain salt is not keccak256(chainTag, deploymentId)`);
  const verifying = b.contracts.contracts[VERIFYING_CONTRACT[s.kind]];
  if (!verifying || !sameHex(td.domain.verifyingContract, verifying.address)) p.add(`${id}: the verifying contract is not ${VERIFYING_CONTRACT[s.kind]}`);
  if (td.message.deploymentId !== tagToBytes32(b.contracts.deploymentId)) p.add(`${id}: message.deploymentId is not this deployment`);
  const digest = digestOf(td);
  if (!digest.startsWith("0x")) {
    p.add(`${id}: ${digest}`);
    return false;
  }
  if (digest !== s.digest) {
    p.add(`${id}: the stored digest is not the EIP-712 digest of the message`);
    return false;
  }
  return true;
}

function checkSignature(s: SignatureEntry, key: FounderKey | null, p: Problems): void {
  const id = `${s.kind} ${s.requestId}`;
  const sub = s.submission;
  if (!sub) {
    p.add(`${id} is SUBMITTED without a signature`);
    return;
  }
  if (!key) {
    p.add(`${id}: no lender-signed registerFounderKey in the bundle to verify against`);
    return;
  }
  if ("passkey" in sub) {
    if (s.method !== "passkey") p.add(`${id}: a passkey assertion on an ${s.method} request`);
    const why = passkeyProblem(s.digest as Hex, sub.passkey, key);
    if (why) p.add(`${id}: ${why}`);
    return;
  }
  if (s.method !== "eip712") p.add(`${id}: an ECDSA signature on a ${s.method} request`);
  const signer = recoverEcdsa(s.digest as Hex, sub.ecdsa.signature);
  if (!signer) p.add(`${id}: the ECDSA signature is malformed or high-s`);
  else if (/^0x0{40}$/.test(key.ownerEOA) || !sameHex(signer, key.ownerEOA)) p.add(`${id}: the ECDSA signer ${signer} is not the founder's owner EOA`);
}

export function checkSignatures(b: ParsedBundle, chain: ChainView): VerifyCheck[] {
  const digests = new Problems("EIP-712 digests");
  const sigs = new Problems("founder signatures (ECDSA, P-256)");
  const key = founderKeyOf(chain, sigs);
  let passkeys = 0;
  let ecdsa = 0;
  for (const s of b.signatures) {
    const digestOk = checkDigest(b, s, digests);
    if (s.status !== "SUBMITTED" && s.submission === null) continue;
    if (!digestOk) {
      sigs.add(`${s.kind} ${s.requestId}: not checked (its digest does not verify)`);
      continue;
    }
    checkSignature(s, key, sigs);
    if (s.submission && "passkey" in s.submission) passkeys += 1;
    else ecdsa += 1;
  }
  return [digests.result(`${b.signatures.length} digests recomputed`), sigs.result(`${passkeys} P-256 passkey and ${ecdsa} ECDSA signatures verify`)];
}
