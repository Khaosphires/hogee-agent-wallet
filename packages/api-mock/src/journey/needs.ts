/**
 * The mock's needs card (core-needs §6, as the live API builds it): core buildNeeds over a draft the REAL compiler
 * made with the country pack in data/country-packs/<CC>.json, for the facility's reserve floor.
 *
 * The mock's own draft carries a mock pack hash (it was never compiled), so buildNeeds refuses it (PACK_MISMATCH).
 * The demo founder's compile input (core's, e.g. meiCompileInput, the input core-needs pins) is compiled instead,
 * and its checklist is re-issued under the mock draft's id ONLY when that compiled plan has exactly the mock draft's
 * lines (amounts, caps, pacing, payees, escrow-only), total, reserve and currency: the card then lists what the plan
 * card shows. Anything else (no compile input for the country, an unreadable pack, a different plan) leaves the card
 * out, as live does when it cannot vouch for it; nothing is invented.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CountryPack, buildNeeds, compilePlan, jcs, meiCompileInput, type CompileInput, type CountryCode, type NeedsChecklist, type PlanDraft } from "@hogee/core";
import type { MockEnv } from "../env";
import type { MockState } from "../store";

/** The demo founder's compile input per country (core's own); a country without one gets no needs card. */
const DEMO_COMPILE: Partial<Record<CountryCode, (pack: CountryPack) => CompileInput>> = { SG: meiCompileInput };

/** The country pack as it ships in data/ (the file the live catalog serves), parsed; undefined when unreadable. */
function packOf(env: MockEnv, country: CountryCode): CountryPack | undefined {
  try {
    const parsed = CountryPack.safeParse(JSON.parse(readFileSync(join(env.repoRoot, "data", "country-packs", `${country}.json`), "utf8")));
    return parsed.success && parsed.data.countryCode === country ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** What the needs card is built from: the intent's founder and shop facts, and the plan's lines, total, reserve and currency. */
const statedBy = ({ intent: i, manifest: m }: PlanDraft): string =>
  jcs({
    founder: [i.countryCode, i.residency, i.entityType, i.productCategory, i.buyFrom, i.sellChannel],
    totalMinor: m.totalMinor,
    reserveBps: m.reserveBps,
    currency: m.displayCurrency,
    lines: m.lines.map((l) => ({ lineKey: l.lineKey, amountMinor: l.amountMinor, perTxCapMinor: l.perTxCapMinor, windowCapMinor: l.windowCapMinor, windowSeconds: l.windowSeconds, pacing: l.pacing ?? null, payeeIds: l.payeeIds, escrowOnly: l.escrowOnly })),
  });

/** The needs checklist for the mock draft `draft`, or undefined when the mock cannot vouch for one (see the header). */
export function mockNeeds(st: MockState, env: MockEnv, draft: PlanDraft): NeedsChecklist | undefined {
  const country = draft.manifest.countryCode;
  const compileInput = DEMO_COMPILE[country];
  const pack = compileInput ? packOf(env, country) : undefined;
  if (!compileInput || !pack) return undefined;
  try {
    const compiled = compilePlan(compileInput(pack));
    if (statedBy(compiled) !== statedBy(draft)) return undefined;
    return { ...buildNeeds(compiled, pack, { reserveFloorBps: st.facility.reserveFloorBps }), draftId: draft.draftId };
  } catch {
    return undefined;
  }
}
