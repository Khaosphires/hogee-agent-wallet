# Security audit run-5: Hogee task 1.13 eval endpoints

## 1. Run, scope and limits
- **Profile:** `quick`, scoped. **This is a partial pass.**
- **Scope:** the diff `6c0c52e..43641cc`. That covers the task 1.13 eval endpoints:
  - `POST /api/eval/case` (E1);
  - `POST /api/eval/plan` (E2/E4, with the `no_pack` ablation);
  - `POST /api/eval/shortlist` (E3, `hogee` vs the naive `llm_rank` baseline);
  - their dataset readers and the planner-tool ablation.

  Task 1.14 in the same range changed docs only.
- **Source ref:** `43641cc` on `p1/dev`, read from a clean, detached, read-only worktree.
- **Execution:** sandboxed, source-and-local only. **No target code was executed**: macOS cannot enforce the required sandbox limits, so every check is source-only.
- **Agents:** 2 hunters (one wave), no verifiers (there were no candidates), and 1 final coverage critic. No budget was set.
- **Prior runs:** runs 1–4 had no confirmed records. Run-4's leads were fixed in PR #8 at or before `6c0c52e`. Its open lead 5 (first-come passkey enrolment) is deferred to the G2 schema batch and gains no new path here. Run-4's chat and supplier-shortlist units were re-covered because their files changed.
- **Deferred:** one unit, total anonymous model spend and shared provider quota across the eval routes. Per-request bounds exist (E2 makes at most 24 guarded calls; E3 makes one reader call over at most 12 × 20,000 chars). No rate or concurrency cap backs them beyond DEMO_MODE, CHAIN=local and the localhost bind. This is latent while the privacy redactor and checks stubs fail closed.
- **Out of scope:** 83 units. That count includes the critic's trace-reader gap (autonomy stats, the timeline window and the future evidence export), whose readers are unchanged in this range.

## 2. Security posture
The eval routes keep the invariants they claim, as far as the source shows:
- **No signing or state change:** they never sign, enqueue, or write `chain_actions`, `payments`, invoices, drafts or shortlists.
- **No key:** "would execute" is an `eth_call` from the agent address on a keyless public client.
- **Gated:** they are reachable only with DEMO_MODE=1 on Anvil with an opened facility.
- **Contained untrusted text:** caller text cannot reach the planner (E2 requires the dataset text); listing text reaches only a tool-less guarded reader whose output is filtered to known ids; dataset ids are pattern-validated before they reach the filesystem.

## 3. Confirmed findings
None.

## 4. Needs validation
None.

## 5. Hardening (14 hunter notes; `hardening.generated.md`)
The ones being fixed now on the task 1.13 branch:
1. **Eval traces counted as decisions.** Eval traces carry a `policy_verdict`, so they skew `GET /api/stats/autonomy` and would enter the 1.16 evidence export. A case refused by a revert is stored as AUTO.
2. **`rawTextRef` containment.** It is resolved against the repo root rather than `data/suppliers`, follows symlinks, reads whole files, and throws on unreadable files. A rejected catalog load is cached until restart.
3. **Missing listing text ranks as clean**, contrary to the shortlist's "never ranked on missing facts" rule.
4. **Registry checks lose their `supplierId`**, so registry-id trust is never awarded in the product or E3 scorer.
5. **E3 `hogee` mode skips the shipped `spec.buyFrom` filter**, an eval-only fork.
6. **`planOrder` does not check the payout hash.** It does not assert that `payoutAccountHash(account)` equals the signed candidate hash. The worker fails closed on a mismatch, but the API should not let the founder sign a hash for a different account than the one shown.
7. **No eval concurrency cap.** This is the deferred spend unit.
8. **The shortlist holds a pooled DB client** across supplier checks.

Information only: the E1 webhook and memory vectors reveal specific verification failure codes in traces, and the evals measure the reader/binding library composition, since no product route ingests invoices yet.

## 6. Coverage
- **Ledger:** 90 units: 6 covered, 0 candidate, 1 deferred, 83 out of scope.
- **Final critic:** `stop: false`; 1 accepted missing unit deferred, 1 recorded out of scope, no reassignments.
- **Validators:** both pass (`validate-findings.cjs`: 0 records; `validate-coverage-ledger.cjs`: 90 units).
- **Scope limit:** this run covers only the task 1.13 eval endpoints and does not exhaust the target.
