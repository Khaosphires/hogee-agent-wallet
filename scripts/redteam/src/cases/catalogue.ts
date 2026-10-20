/**
 * The ordered case list. `main` runs on one final-1 deployment, on Anvil and on Sepolia alike, so the order matters:
 * setup first, then the attacks that need a healthy treasury, then the ones that change it for good (T29's
 * auto-pause, S12's pause, T15's revoke) at the end. `extras` need a fresh Anvil world and time travel.
 *
 * Aliases: S6 = T1, S7 = T4, S8 = T5, S9 = T6, S10 = T17, T19 = D-plug, T21 = D-poison (the scripted task IS the
 * attack; its rows are copied, same hashes). S11 and S12 run their own steps.
 *
 * `sg` runs in a Singapore world (Mei's facility on its own fresh deployment, Anvil only): country variants of T1
 * (a changed PayNow target) and T4 (over cap in SGD), filed under those ids. The main and extras worlds stay MY.
 *
 * `web` runs Mei's chat-first journey in a WEB world (its own fresh deployment, the recorded web search, the real
 * sanctions screening; Anvil only): S2, S1, S3, S4, S5, S11 and S12 along the journey, and the web attacks, all as
 * variant WEB on the frozen ids. Order matters: the limit attacks before the order holds the pocket, T3 during the
 * payee cooling, and the searches that fail or supersede after the order.
 */
import type { CaseDef } from "./context";
import { T11, T25, T30, T31, T32, T33 } from "./content";
import { T15X, T22 } from "./extras";
import { S11, T2, T3, T5, T6, T9, T12, T23, T24 } from "./governance";
import { DPLUG, S12, T10, T15, T29 } from "./ops";
import { T1, T4, T7, T8, T13, T14, T17, T18, T26 } from "./payments";
import { SETUP_AFTER_PLAN, SETUP_BEFORE_PLAN } from "./setup";
import { DPOISON, T16, T20, T27, T28 } from "./signatures";
import { SG_T1, SG_T4 } from "./sg";
import { WEB_S11, WEB_S12 } from "./web-cfo";
import { WEB_S3_ORDER, WEB_S4, WEB_S5, WEB_T16, WEB_T27, WEB_T3, WEB_T7 } from "./web-order";
import { WEB_T11, WEB_T11_FAIL_CLOSED, WEB_T25, WEB_T25_HOSTILE, WEB_T26, WEB_T30, WEB_T33 } from "./web-search";
import { WEB_S1, WEB_S2, WEB_S3_SEARCH } from "./web-setup";
import { WEB_T1, WEB_T18, WEB_T2 } from "./web-terms";

export const CATALOGUE: { readonly main: readonly CaseDef[]; readonly extras: readonly CaseDef[]; readonly sg: readonly CaseDef[]; readonly web: readonly CaseDef[] } = {
  main: [
    ...SETUP_BEFORE_PLAN, // step 0 (filed under S2)
    DPOISON, // + T21: the malicious v1 reverts; the compiler's compliant v1 is what S2 commits
    ...SETUP_AFTER_PLAN, // S2, S1, S3, S4, S5
    T1, // + S6
    T4, // + S7
    T14,
    T7,
    T17, // + S10
    T13,
    T8,
    T18,
    T2,
    T5, // + S8
    T6, // + S9
    T3,
    T9,
    T12,
    T11,
    T25,
    T30,
    T31,
    T32,
    T33,
    T16,
    T27,
    T28,
    S11,
    T23,
    T24,
    T26,
    DPLUG, // + T19
    T29,
    T20,
    S12,
    T10,
    T15,
  ],
  extras: [T22, T15X],
  sg: [SG_T1, SG_T4],
  web: [
    WEB_S2, // step 0 + the intake turn's needs card and inline PlanApproval (sets the world up)
    WEB_S1,
    WEB_S3_SEARCH, // search READY, candidates, pick, enquiry
    WEB_T11,
    WEB_T25,
    WEB_T33,
    WEB_T1, // payout forms, the excluded page, screening at confirm and prepare
    WEB_T18, // limit attacks: the pocket is still whole
    WEB_T2,
    WEB_S3_ORDER, // terms, SupplierApproval, bindPayee: cooling starts
    WEB_T3, // during cooling
    WEB_S4,
    WEB_S5,
    WEB_T7,
    WEB_T16,
    WEB_T27,
    WEB_T26, // new searches from here on
    WEB_T11_FAIL_CLOSED,
    WEB_T25_HOSTILE,
    WEB_T30,
    WEB_S11,
    WEB_S12, // time travel (two days) last
  ],
};

/** Every case with its layers and target constraints (README coverage table, report.json). */
export function coverage(): { id: string; variant?: string; title: string; layers: string; anvilOnly?: string; aliases: string[] }[] {
  return [...CATALOGUE.main, ...CATALOGUE.extras, ...CATALOGUE.sg, ...CATALOGUE.web].flatMap((c) => [
    { id: c.id, ...(c.variant ? { variant: c.variant } : {}), title: c.title, layers: c.layers, ...(c.anvilOnly ? { anvilOnly: c.anvilOnly } : {}), aliases: (c.aliases ?? []).map((a) => a.id) },
    ...(c.aliases ?? []).map((a) => ({ id: a.id, title: a.title, layers: `same run as ${c.id}`, aliases: [] })),
  ]);
}
