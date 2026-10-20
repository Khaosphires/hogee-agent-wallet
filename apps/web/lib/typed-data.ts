/**
 * Independent check of a signing request (project.md §13.1 principle 5, T27), before anything is signed:
 * - the typed data is the frozen struct for the kind the user asked to sign (hogeeTypes, mirrored from @hogee/chain);
 * - its domain and deploymentId are this session's deployment, and it hasn't expired;
 * - a LoosenRequest's fields that its change kind doesn't use are zero (loosen-fields.ts mirrors the contract);
 * - it hashes to the server's digest, and the passkey challenge is that digest;
 * - for a web supplier's SupplierApproval, the holder, whole account number and milestones the server shows hash to the
 *   message's payoutAccountHash and scheduleHash (run-9), so they can be shown as signed rows;
 * - for a catalog supplier's SupplierApproval, the milestones the server shows hash to scheduleHash and add up to
 *   totalMinor (re-check review LOW 2; the payout account stays a fingerprint: the panel shows only its last digits).
 * A check that throws on hostile rows refuses the signature; it never crashes the dialog (re-check keccak LOW 2).
 * The panel's rows are then decoded from this same message (signed-rows.ts), so what you read is what you sign.
 */
import { hashTypedData, type TypedDataDefinition } from "viem";
import {
  WEB_PAYOUT_CHANNEL,
  isPlainName,
  isWebSupplierId,
  payoutAccountHash,
  readCatalogScheduleRows,
  readWebOrderRows,
  type SignatureKind,
  type SignatureRequestResponse,
  type TypedData,
  type WebOrderPreimage,
} from "@hogee/core";
import { chainTagOf, hogeeDomain, hogeeTypes, scheduleHash, toBytes32Tag } from "@hogee/api-mock/eip712";
import { bytesToBase64Url, hexToBytes, type Hex } from "./passkey-encode";
import { strayLoosenField } from "./loosen-fields";
import { loosenChange, tagText } from "./signed-rows";

/** API typed data (decimal strings) → the values EIP-712 encodes (bigint for uint fields). */
function viemMessage(td: TypedData): Record<string, unknown> {
  const fields = td.types[td.primaryType] ?? [];
  return Object.fromEntries(fields.map((f) => [f.name, f.type.startsWith("uint") ? BigInt(String(td.message[f.name])) : td.message[f.name]]));
}

export function digestOf(td: TypedData): Hex {
  // The typed data is dynamic (any of six structs), so viem's literal-type inference does not apply.
  const definition = {
    domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as Hex, salt: td.domain.salt as Hex },
    types: td.types,
    primaryType: td.primaryType,
    message: viemMessage(td),
  } as unknown as TypedDataDefinition;
  return hashTypedData(definition) as Hex;
}

export interface DigestCheck {
  readonly ok: boolean;
  readonly recomputed: Hex;
  readonly reason?: string;
  /** A web supplier's account and schedule, verified against the message (shown as signed rows). */
  readonly webOrder?: WebOrderPreimage;
  /** A catalog supplier's schedule, verified against scheduleHash and totalMinor (shown as signed rows). */
  readonly schedule?: Schedule;
}

type Schedule = WebOrderPreimage["schedule"];

/** What the browser expects to sign: the kind it asked for, on the session's deployment. */
export interface SigningContext {
  readonly kind: SignatureKind;
  readonly chainId: number;
  readonly deploymentId: string;
}

const sameFields = (a: readonly { name: string; type: string }[], b: readonly { name: string; type: string }[]): boolean =>
  a.length === b.length && a.every((f, i) => f.name === b[i]?.name && f.type === b[i]?.type);

/** Why the typed data isn't the struct, domain and deployment the user expects, or undefined when it is. */
function structProblem(req: SignatureRequestResponse, ctx: SigningContext, nowMs: number): string | undefined {
  const td = req.typedData;
  if (td.primaryType !== ctx.kind || req.displayModel.kind !== ctx.kind) return `This is a different kind of approval from the one you opened (${td.primaryType}, not ${ctx.kind})`;
  const fields = hogeeTypes[ctx.kind];
  const names = Object.keys(td.types);
  if (names.length !== 1 || !sameFields(td.types[ctx.kind] ?? [], fields)) return "This request isn't in the expected format";
  const keys = Object.keys(td.message).sort();
  if (keys.length !== fields.length || keys.join() !== fields.map((f) => f.name).sort().join()) return "This request has extra parts it shouldn't have";
  const deploymentTag = toBytes32Tag(ctx.deploymentId);
  const expected = hogeeDomain({ verifyingContract: td.domain.verifyingContract as Hex, chainTag: toBytes32Tag(chainTagOf(ctx.chainId)), deploymentId: deploymentTag });
  if (td.domain.salt !== expected.salt) return "This request is for a different blockchain or app version";
  if (td.domain.verifyingContract.toLowerCase() !== req.displayModel.contract.toLowerCase()) return "This request names a different rule program than the one shown";
  if (req.displayModel.chainId !== ctx.chainId || req.displayModel.deploymentId !== ctx.deploymentId) return "These lines are for a different blockchain or app version";
  if (td.message.deploymentId !== deploymentTag) return "This request is for a different app version";
  if (td.message.expiry !== req.expiresAt) return "The expiry time doesn't match";
  if (Number(req.expiresAt) * 1000 <= nowMs) return "This request has expired. Close it and start again";
  if (ctx.kind === "LoosenRequest" && !loosenChange(td.message)) return "Hogee can't show this kind of change, so you can't sign it";
  // A field this change kind doesn't use is still signed: it must be zero, never an unseen value (loosen-fields.ts).
  const stray = ctx.kind === "LoosenRequest" ? strayLoosenField(td) : undefined;
  if (stray) return `This request has a value in a part this change doesn't use (${stray}), so you can't sign it`;
  return undefined;
}

const same = (a: string, b: unknown): boolean => a.toLowerCase() === String(b).toLowerCase();

type Message = TypedData["message"];

/** Why the milestones shown are not the signed scheduleHash (the chain's abi encoding) and totalMinor, or undefined. */
function scheduleProblem(schedule: Schedule, m: Message): string | undefined {
  const amounts = schedule.map((x) => x.amountMinor);
  if (!same(scheduleHash(amounts, schedule.map((x) => x.autoRelease)), m.scheduleHash)) return "The payments shown are not the ones you would sign";
  if (amounts.reduce((a, b) => a + b, 0n).toString() !== String(m.totalMinor)) return "The payments shown don't add up to the order total you would sign";
  return undefined;
}

/**
 * A web supplier: the account and milestones the server shows, recomputed here (payoutAccountHash = keccak256 of the
 * JCS preimage with the fixed MOCK_ONLY channel; scheduleHash = the chain's abi encoding) and checked against the message.
 */
function webOrderCheck(req: SignatureRequestResponse, m: Message): SupplierApprovalCheck {
  const order = readWebOrderRows(req.displayModel.rows);
  if (!order) return { problem: "This screen doesn't show the full account name, account number and payments" };
  if (!isPlainName(order.holderName)) return { problem: "The account name has hidden characters in it" };
  const account = { channel: WEB_PAYOUT_CHANNEL, accountNumber: order.accountNumber, holderName: order.holderName };
  if (!same(payoutAccountHash(account), m.payoutAccountHash)) return { problem: "The bank account shown is not the one you would sign" };
  const problem = scheduleProblem(order.schedule, m);
  return problem ? { problem } : { order };
}

/** A catalog supplier: every milestone shown in its built form, hashing to scheduleHash and adding up to totalMinor. */
function catalogOrderCheck(req: SignatureRequestResponse, m: Message): SupplierApprovalCheck {
  const schedule = readCatalogScheduleRows(req.displayModel.rows);
  if (!schedule) return { problem: "This screen doesn't show all the payments" };
  const problem = scheduleProblem(schedule, m);
  return problem ? { problem } : { schedule };
}

interface SupplierApprovalCheck {
  readonly problem?: string;
  readonly order?: WebOrderPreimage;
  readonly schedule?: Schedule;
}

/**
 * A SupplierApproval's rows recomputed against its message (web: account and schedule; catalog: schedule). `problem`
 * refuses the signature, including when the rows make a hash throw (an amount past uint256, an unencodable name);
 * any other kind returns {}.
 */
function supplierApprovalCheck(req: SignatureRequestResponse): SupplierApprovalCheck {
  if (req.typedData.primaryType !== "SupplierApproval") return {};
  try {
    const m = req.typedData.message;
    return isWebSupplierId(tagText(String(m.supplierId ?? ""))) ? webOrderCheck(req, m) : catalogOrderCheck(req, m);
  } catch {
    return { problem: "Hogee couldn't check the bank account or payments shown, so you can't sign this" };
  }
}

/** True only for the expected struct on this deployment, hashing to the digest, with the digest as the challenge. */
export function checkSignatureRequest(req: SignatureRequestResponse, ctx: SigningContext, nowMs = Date.now()): DigestCheck {
  let recomputed: Hex;
  try {
    recomputed = digestOf(req.typedData);
  } catch (e) {
    return { ok: false, recomputed: "0x", reason: `Your browser couldn't check this request (${e instanceof Error ? e.message : String(e)})` };
  }
  const problem = structProblem(req, ctx, nowMs);
  if (problem) return { ok: false, recomputed, reason: problem };
  if (recomputed !== req.digest) return { ok: false, recomputed, reason: "The code to sign doesn't match what you're shown" };
  if (req.displayModel.digest !== req.digest) return { ok: false, recomputed, reason: "These lines were made for a different code" };
  if (req.challengeB64url !== bytesToBase64Url(hexToBytes(req.digest))) return { ok: false, recomputed, reason: "Your passkey would sign something different from this code" };
  const approval = supplierApprovalCheck(req);
  if (approval.problem) return { ok: false, recomputed, reason: approval.problem };
  if (approval.order) return { ok: true, recomputed, webOrder: approval.order };
  return approval.schedule ? { ok: true, recomputed, schedule: approval.schedule } : { ok: true, recomputed };
}

/** typedData for MetaMask eth_signTypedData_v4 (needs EIP712Domain listed explicitly). */
export function metaMaskTypedData(td: TypedData): string {
  return JSON.stringify({
    domain: td.domain,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "verifyingContract", type: "address" },
        { name: "salt", type: "bytes32" },
      ],
      ...td.types,
    },
    primaryType: td.primaryType,
    message: td.message,
  });
}
