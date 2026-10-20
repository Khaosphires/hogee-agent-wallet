/**
 * Check 8 "mirror parity": each catalogue step with a source counterpart names that source tx (links.sepoliaTx), found
 * in the source bundle by the catalogue's rule (a chain action by kind and order, or a payment by kind and milestone),
 * and its calldata matches: byte for byte (calldata), the same signed struct and arguments except nonce, expiry and
 * the signature (envelope), or the same order, milestone and amount (order). The two settlement confirmations confirm
 * settlements the mirror itself opened (its MilestoneReleased events).
 */
import { decodeFunctionData, type Hex } from "viem";
import { hogeeCallsAbi } from "../abi";
import { parseSignedTx } from "../crypto";
import { Problems, sameHex, type VerifyCheck } from "../util";
import type { SepoliaMirror } from "./catalogue";
import { sameJson, type Ctx } from "./context";
import { stepLabel } from "./pack";

export const PARITY_CHECK = "mirror parity";

/** The source tx a mirror spec names in the source bundle: hash and calldata. */
export function sourceTxOf(ctx: Ctx, m: SepoliaMirror): { hash: string; raw: string; data: Hex } | null {
  const b = ctx.bundle?.parsed;
  if (!b) return null;
  const row =
    m.source === "action"
      ? b.chainActions.filter((a) => a.kind === m.kind)[m.nth ?? 0]
      : b.payments.filter((x) => x.payment.kind === m.kind && x.milestoneIdx === (m.milestoneIdx ?? null))[m.nth ?? 0];
  const hash = row ? ("payment" in row ? row.payment.txHash : row.txHash) : null;
  const raw = row?.rawSignedTx ?? null;
  if (!hash || !raw) return null;
  const tx = parseSignedTx(raw as Hex);
  return typeof tx === "string" || tx.hash !== hash.toLowerCase() ? null : { hash: hash.toLowerCase(), raw, data: tx.data };
}

const ENVELOPE = new Set(["nonce", "expiry"]);
const SIG_INDEX: Readonly<Record<string, number>> = { commitPlan: 3, bindPayee: 3, releaseMilestone: 1 };

function decode(data: Hex): { name: string; args: readonly unknown[] } | null {
  try {
    const c = decodeFunctionData({ abi: hogeeCallsAbi, data });
    return { name: c.functionName, args: (c.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

/** Same call except nonce/expiry of the signed struct (arg 0) and the Sig. */
function sameEnvelope(a: { name: string; args: readonly unknown[] }, b: { name: string; args: readonly unknown[] }): boolean {
  if (a.name !== b.name || a.args.length !== b.args.length) return false;
  const sig = SIG_INDEX[a.name];
  return a.args.every((x, i) => {
    if (i === sig) return true;
    if (i !== 0) return sameJson(x, b.args[i]);
    const [s, t] = [x as Record<string, unknown>, b.args[0] as Record<string, unknown>];
    return Object.keys(s).length === Object.keys(t).length && Object.keys(s).every((k) => ENVELOPE.has(k) || sameJson(s[k], t[k]));
  });
}

function compare(kind: SepoliaMirror["compare"], fisco: Hex, source: Hex): string | null {
  if (kind === "calldata") return fisco.toLowerCase() === source.toLowerCase() ? null : "calldata is not byte-identical to the source tx's";
  const [a, b] = [decode(fisco), decode(source)];
  if (!a || !b) return "calldata does not decode";
  if (kind === "envelope") return sameEnvelope(a, b) ? null : "the signed struct or arguments differ from the source tx's (beyond nonce, expiry and signature)";
  return a.name === b.name && sameJson(a.args.slice(0, 3), b.args.slice(0, 3)) ? null : "order, milestone or amount differ from the source tx's";
}

export function checkParity(ctx: Ctx): VerifyCheck {
  const p = new Problems(PARITY_CHECK);
  if (!ctx.bundle?.parsed) {
    p.add("no parsed source bundle to compare with");
    return p.result("");
  }
  let n = 0;
  for (const s of ctx.view.steps) {
    const m = s.entry?.sepolia;
    if (!m) continue;
    const label = stepLabel(s.step);
    const src = sourceTxOf(ctx, m);
    if (!src) {
      p.add(`${label}: the source bundle has no ${m.kind} tx for it`);
      continue;
    }
    if (!sameHex(s.step.links.sepoliaTx, src.hash)) p.add(`${label}: links to ${s.step.links.sepoliaTx ?? "(none)"}, not the source ${m.kind} tx ${src.hash.slice(0, 12)}…`);
    const data = s.tx?.parsed?.data;
    const why = data ? compare(m.compare, data, src.data) : "no FISCO calldata";
    if (why) p.add(`${label}: ${why}`);
    else n += 1;
  }
  const opened = new Set(ctx.view.events.filter((e) => e.name === "MilestoneReleased").map((e) => String(e.args.settlementId).toLowerCase()));
  for (const s of ctx.view.steps.filter((x) => x.step.function === "confirmSettlement")) {
    const id = String(s.tx?.call?.args[0] ?? "").toLowerCase();
    if (!opened.has(id)) p.add(`${stepLabel(s.step)}: confirms a settlement the mirror never opened`);
  }
  return p.result(`${n} steps match their source txs`);
}
