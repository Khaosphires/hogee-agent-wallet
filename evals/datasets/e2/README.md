# E2 plan-quality dataset

E2 measures plan quality (project.md §15). Each founder prompt goes through the shipped planner and compiler (`POST /api/eval/plan`), and the plan's compliance fields are scored against labels written before any run. The rules for every label are in [`LABELING.md`](LABELING.md).

All prompts are synthetic. No row comes from a real founder.

## Files

| File | Rows | Contents |
|---|---|---|
| `prompts.jsonl` | 40 | One frozen `E2PromptRow` per line: `{promptId, country, lang, vague, hiddenSlot?, text}` (`data/schemas/e2-prompt-row.schema.json`). `e2-sg-001`–`e2-sg-024` are Singapore and `e2-my-001`–`e2-my-016` are Malaysia (P1's Q4: 24 SG / 16 MY, no ID). 20 are vague, and each hides exactly one plan-changing slot |
| `labels.jsonl` | 40 | One frozen `E2LabelRow` per prompt, in the same order: the 8 scored fields, so 320 labels |
| `hidden-answers.jsonl` | 20 | `{promptId, slot, answer}` for each vague prompt: the true value of its hidden slot, written the way the founder would type it. `packages/api/src/runtime/eval-data.ts` reads it to answer the planner's question (LABELING §2.4) |
| `prompts.meta.jsonl` | 40 | Sidecar, outside the frozen schema: the case `key`, `zh` (the text mixes in Chinese), and `truth`, the founder's facts (residency, partner, limited liability, category, product count, buy-from country, budget, channel, horizon). Use it for breakdowns. The API never reads it |
| `LABELING.md` | | The labelling rules (P1, approved 17 Oct), with the SG rows added on 18 Oct |

`pnpm validate:data` checks `prompts.jsonl` and `labels.jsonl` against the frozen zod schemas.

## Regenerate and check

From the repository root (Node 24; the generator has no dependencies):

```sh
node evals/scripts/gen-e2.mjs                    # write the four .jsonl files
node evals/scripts/gen-e2.mjs --check            # rebuild in memory; exit 1 if any committed byte differs
node --test evals/scripts/gen-e2.test.mjs        # schema, split, hidden slots, hand-checked rows, fail-closed labeller, wording
pnpm exec tsx evals/scripts/e2/compiler-check.ts # compile every ground-truth intent with the real compiler (see below)
```

The generator uses one fixed seed (`20261018`) and no clock. The seed picks only how each budget is written (`S$8,000`, `SGD 8,000`, `S$8k`, `RM8 ribu` and so on). The texts, the facts and the hidden slots are written by hand in `evals/scripts/e2/cases-sg.mjs` and `cases-my.mjs`.

## How the labels are made

`evals/scripts/e2/label.mjs` turns each prompt's facts into the 8 fields using only LABELING.md and the pack JSON (`data/country-packs/SG.json`, `MY.json`). It never imports `@hogee/core` and never calls the compiler, because E2 measures the compiler and the planner, and the test enforces that. When a label would need a fact that the pack doesn't have, or a case LABELING leaves out, it throws instead of guessing. So the prompts stay inside what can be labelled:
- **SG approvals bind the importer**, so every regulated SG category is imported. Only apparel is bought locally (`EXEMPT`).
- **SG cosmetics** are single products in HSA's general tier (S$13). Electrical goods are single SAFETY Mark controlled goods (S$180). SG `other` has no pack entry, so it is left out.
- **MY.json has approvals for drinkware only.** MY prompts sell drinkware (pack: `NONE`) or apparel (LABELING §3.6: `NONE`, no fee). NPRA, ST_SIRIM and KKM_FOOD need fees the pack lacks, so the Singapore prompts cover those categories.
- **Only MY drinkware is bought from China.** The pack models the Form E rate for the tumbler line alone.
- **Every prompt is at launch scale and sells online.** So no prompt is GST-, SST- or e-invoicing-registered, and none needs a premises licence.

A vague prompt states every plan-changing fact except its hidden slot. The generator refuses a text that gives the slot away, and an answer that doesn't state the true value.

## What the set covers

| | SG (24) | MY (16) |
|---|---|---|
| Residency | 14 citizen, 5 PR, 5 foreigner | 10 citizen, 3 PR, 3 foreigner |
| Entity (label) | 17 `sg_sole_prop`, 4 `sg_partnership`, 3 `pte_ltd` | 10 `sole_prop`, 2 `partnership`, 4 `sdn_bhd` |
| Category | 8 drinkware, 4 cosmetics, 4 electrical, 3 food, 5 apparel | 11 drinkware, 5 apparel |
| Buy from | CN 16, KR 2, TW 1, JP 1, US 1, local 3 | CN 9, US 1, local 6 |
| Duty route | 21 `MFN`, 3 `EXEMPT` | 9 `FORM_E`, 1 `MFN`, 6 `EXEMPT` |
| Hidden slot (vague) | 3 each: residency, product, buy-from, budget | 3 residency, 2 product, 2 buy-from, 1 budget |
| Channel | Shopee, TikTok Shop, Lazada, own site | Shopee, TikTok Shop, Lazada, own site |
| Language | 21 en (3 mixed with Chinese), 3 ms | 11 en (2 mixed with Chinese), 5 ms |

`e2-sg-001` is the main demo case (Mei: tumblers, Shopee SG, S$10,000) and `e2-my-001` is Rina's. The frozen `lang` enum has no Chinese, so Chinese-mixed prompts are `en`, with `zh: true` in the sidecar.

## Compiler cross-check

`evals/scripts/e2/compiler-check.ts` builds the intent a perfect planner would emit for each prompt (the facts, with the hidden slot answered, and the labelled entity). It compiles that intent with `compilePlan` on the real pack, reads the fields back with `deriveE2Fields`, and compares them with the labels. Every disagreement has to be classified in its `KNOWN` table, and a new one fails the run. It also loads the committed files through the API's own `e2PromptLoader`.

The result on this commit:
- All 24 SG prompts and 8 MY prompts compile, and all of their fields agree with the labels.
- The other 8 MY prompts fail closed with `PACK_FACT_MISSING`:
  - `registrations.LHDN_TIN[sdn_bhd].cost` on the 4 Sdn Bhd prompts;
  - `productApprovals.apparel` on the 5 apparel prompts;
  - one prompt hits both.
- These are gaps in MY.json, not label errors. Re-run with those two leaves filled as the labels assume (in memory only), all 8 compile and agree on every field. Details are in `evals/docs/evals-e2.md`.

## Freezing

LABELING §4 freezes the labels at gate G4 with the git tag `labels-frozen`, which P1 creates. After that, rows may only be added. If a pack value changes before G4, fix the pack, regenerate, and re-run the cross-check. A label that changes then is a pack correction, not a label edit.
