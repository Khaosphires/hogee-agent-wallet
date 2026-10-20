# evals-e2 decisions (E2 plan-quality dataset, 2026-10-18)

**Owner:** agent `evals-e2`, branch `wip/evals-e2`. For P1 to fold into `docs/G0-DECISIONS.md` after the merge.

**Delivered:**
- In `evals/datasets/e2/`:
  - `prompts.jsonl`: 40 rows, 24 SG then 16 MY, 20 of them vague;
  - `labels.jsonl`: 40 rows × 8 fields, so 320 labels;
  - `hidden-answers.jsonl`: 20 rows;
  - a `prompts.meta.jsonl` sidecar and a README.
- `evals/scripts/gen-e2.mjs`, its modules in `evals/scripts/e2/`, and the test `gen-e2.test.mjs`.
- `evals/scripts/e2/compiler-check.ts`.
- SG rows in `LABELING.md`, at the places SG-DESIGN §3 "evals (E2)" names.

## 1. Label rules

| Gap | Choice |
|---|---|
| Source of a label | `e2/label.mjs`, written from LABELING.md and the pack JSON only. It has no `@hogee` import and calls no compiler; the test enforces this. The compiler is compared afterwards (§4), and a label never changes to match it |
| LABELING had no SG rules | Added from SG-DESIGN §3 and SG-DECISIONS: entity → `ACRA_BUSINESS`/`ACRA_PTE_LTD`; `IRAS_GST` only above SGD 1M; InvoiceNow follows GST; CN → `MFN` (never `EXEMPT`); approvals from `productApprovals.<category>`; reserve 500 (Q2). The change log in LABELING records it |
| SG foreigner, solo | `sg_sole_prop`, because SG.json lists foreigners as eligible (P1 23:25: pack eligibility first, `FOREIGNER_ENTITY` only as fallback). Practical caveats (local authorised representative, work-pass consent) are not E2 fields |
| SG business name with no name given | D8 applied to SG: register (`ACRA_BUSINESS`, S$115), since a marketplace shop sells under a name. The exemption for the owner's own NRIC name is never assumed |
| SG approval for goods bought locally | The SG approvals (SFA importer registration, HSA notification, CPSO registered supplier) bind the importer. The pack has no rule for a local reseller, so regulated SG categories are always imported in the set, and only apparel is bought locally. The labeller throws on the other case |
| Product count | `PlanIntent` has no product count, and the compiler charges one product. Every prompt with a fee-bearing approval names one product. Cosmetics are HSA's general tier (S$13; eye, lip, oral and hair-dye products are S$28); electrical goods are single SAFETY Mark controlled goods (S$180); SG food is processed food (SFA, free) |
| MY categories | MY.json has `productApprovals` for drinkware only. NPRA, ST_SIRIM and KKM_FOOD need a fee leaf that doesn't exist, so MY prompts are drinkware (pack: `NONE`) and apparel (LABELING §3.6: `NONE`, no fee, not `[VERIFY]`). Singapore carries cosmetics, electrical and food |
| MY CN imports | Drinkware only: the pack models the Form E 0% for the tumbler line (my-pack decision 2), and says nothing on ACFTA cover for other goods. MY apparel is bought locally (`EXEMPT`); one prompt imports from the US (`MFN`) |
| MY Sdn Bhd `LHDN_TIN` fee | 0. LABELING §3.2 requires the TIN for every MY entity. MY.json's 0 is scoped to individuals (my-pack decision 3), and LHDN states no fee for a company TIN. Recorded in LABELING §3.8. The compiler disagrees (§4) |
| MY Sdn Bhd fee | `"101000"`, the pack's cost leaf, as LABELING says ("use the pack's exact figure"). The RM50 name reservation is not added; see §5 |
| Thresholds | Every prompt is at launch scale (LABELING §2.1) and online only (§2.2). So `indirectTaxRegistered` and `eInvoicing` are false in all 40 rows, and no prompt is labelled `PBT_LICENCE`. An above-threshold prompt would need fees the packs lack (`IRAS_GST`, `MYINVOIS`, `SST`); the labeller fails closed on them, and the test pins this |
| Fail closed | A missing pack leaf, an ASEAN origin (D5), SG `other`, a local SG purchase of a regulated category, MY CN non-drinkware, or an unknown country all throw. None is guessed |

## 2. Prompts

| Gap | Choice |
|---|---|
| Split | 24 SG / 16 MY / 0 ID (Q4). 20 vague, each hiding one plan-changing slot (LABELING §2.3): SG 3 each of residency, product, buy-from and budget; MY 3 residency, 2 product, 2 buy-from, 1 budget |
| Text | Written by hand, with founder-style variety: Mei (`e2-sg-001`) and Rina (`e2-my-001`); Singlish and Manglish; 8 Malay prompts. The seed only picks how a budget is written |
| Chinese | `LANGS` is `en/ms/id`, so the 5 prompts that mix in Chinese are `lang: "en"`, with `zh: true` in the sidecar (as E1 and E5 do). None uses the banned Chinese terms |
| Hidden answers | One row per vague prompt, in the founder's words ("I'm a Singapore PR.", "S$6,000", "从 KL Jalan TAR 的批发商拿货…"). The generator refuses a vague text that gives its slot away, and an answer that doesn't state the true value. A clear prompt must state its budget |
| Sidecar | `prompts.meta.jsonl` holds the ground-truth facts. `compiler-check.ts` reads them, and so can report breakdowns. The API reads only `prompts.jsonl` and `hidden-answers.jsonl` |

## 3. Generation

Seed `20261018`, using E1's sfc32 stream (`e1/rng.mjs`, one stream per prompt id). No clock and no network. `--check` rebuilds the files and compares them byte for byte. The generator throws on:
- a split other than 24 SG / 16 MY;
- a vague count other than 20;
- a duplicate key;
- a slot that isn't plan-changing;
- any row-check problem.

## 4. Compiler cross-check (`pnpm exec tsx evals/scripts/e2/compiler-check.ts`)

The ground-truth intent for each prompt is built from its facts, with the hidden slot answered and the labelled entity. It is compiled with `compilePlan` on the real SG.json or MY.json, on Mei's or Rina's demo facility, and read back with `deriveE2Fields`.

**Result:**
- The 24 SG prompts and 8 of the MY prompts agree with their labels on all 8 fields.
- 8 MY prompts don't compile, so all 8 of their fields disagree.

There are 0 labelling bugs.

| Prompt | Label | Compiler | Classification |
|---|---|---|---|
| e2-my-003, -007, -008 (foreigner or Sdn Bhd) | `sdn_bhd`, `SSM_SDN_BHD`+`LHDN_TIN`, `"101000"` | `PACK_FACT_MISSING registrations.LHDN_TIN[sdn_bhd].cost` | **Pack gap.** MY.json scopes the TIN fee to individuals. The compiler is right to fail closed. The label stands |
| e2-my-011, -012, -014, -016 (apparel) | `NONE`, `"6000"` | `PACK_FACT_MISSING productApprovals.apparel` | **Pack gap.** LABELING §3.6 fixes MY apparel at `NONE`, but the compiler only takes approvals from the pack, by design (SG-DESIGN §1.3). The label stands |
| e2-my-013 (foreigner, apparel) | `sdn_bhd`, `NONE`, `"101000"` | both leaves missing | Both gaps above |

**What-if (in memory, not data):** fill the two leaves as the labels assume. That means widening the LHDN_TIN record to `sdn_bhd`, and giving apparel drinkware's sourced `NONE` entry. Then all 8 prompts compile and agree on every field.

**Fix, outside my scope, for `my-pack`:** source both leaves in MY.json:
- a company TIN fee: LHDN e-Daftar, no fee;
- `productApprovals.apparel = NONE`.

Until then, 8 of the 40 prompts can only score as fail-closed refusals. The labels need no change when the pack is fixed.

Two limits on the check:
- It uses the labelled entity in the intent, so entity agreement only shows that the compiler kept it. It does not show that a planner would pick it.
- Non-Shopee prompts compiled on the Shopee-only platform registry, and the compiler accepted them.

## 5. Open for P1

- **Second labeller.** LABELING §4.2 asks for two independent labellers (P3 plus P1 or P2). This set has one: the rule code. The compiler check is not independent, because it is the system under test. A human pass over `labels.jsonl` is still needed before G4.
- **Packs are `RESEARCHED`, not verified** (LABELING says "verified"). If the user's sign-off changes a value, regenerate and re-run the check.
- **RM50 name reservation.** MY.json says it is "separate". If P1 counts it as mandatory, MY Sdn Bhd labels become `"106000"`, and the pack needs a fee leaf.
- **Tag.** Labels are final for this pack state. P1 creates `labels-frozen` at G4; I did not create any tag.
- **Trivial fields.** `indirectTaxRegistered` and `eInvoicing` are false in every row (launch scale). They inflate field accuracy; the report should say so.
