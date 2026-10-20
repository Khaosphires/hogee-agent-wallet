# Security audit — hogee run-10

## 1. Run, scope and limits
- **Profile:** `quick`, **scoped** to the diff `6dc22f0..38e552b` (everything merged since run-9's base: the CFO
  "Couldn't load" fix, the UX revamp and apple-design pass, UX rounds 2–3, the Sample business mock scenario and its demo
  switch, the mock evidence tenant change, chat quick intents). **This is a partial pass**, not a full audit.
- **Source ref:** `38e552b` (main after PR #14), read from a clean detached worktree. **Budget:** none set.
  **Agents:** 4 reconnaissance, 9 hunters (47 planned units), 6 candidate verifiers (Phase 3 and Phase 5 merged, as the
  quick profile allows), 1 final coverage critic.
- **Execution:** sandboxed source-and-local-only policy, and **no target code was executed**: the macOS host cannot enforce
  the required memory, disk and file-size limits and no reviewed artifact-promotion code exists. Every check is
  source-only, so no record can reach `confirmed`.
- **Prior runs:** runs 1–9 read. No prior confirmed records. Run-9's two `needs_validation` leads whose source changed were
  revalidated and the critic marked both **resolved** (mock catalog SupplierApproval binding; cfo-guard all-history reads
  under the job lock). Run-9's three deferred gaps were reassigned and closed as covered. 114 units are `out_of_scope`
  (source unchanged in this range, plus one critic gap that predates it).
- **Critic:** one final post-wave critic ran (quick profile). It accepted 6 in-scope gaps, recorded `deferred` (no second
  wave in `quick`), and 1 out-of-scope gap; it reassigned nothing. No clean-coverage claim is made.

## 2. Posture
The changed code adds no new server-side authority and no injection sink: no raw HTML, every link is pinned or checked,
signing still binds what the founder sees to what is signed, officer actions stay server-checked, and the worker's single
lock still prevents double settlement. The six leads cluster in two places: **demo-mode integrity** (who may rebuild the
shared mock, a GET that now creates state, sample labels that can be lost or faked as real, a tampered recorded pack shown
as a harmless sample, a "Recorded on" label read from an unbound field) and **one worker liveness regression** (the urgent
pause relay is no longer first in line for the job lock).

## 3. Confirmed findings
None. (Source-only pass; see §1.)

## 5. NEEDS VALIDATION (leads, no severity)
| # | Lead | Trace (start → sink) | Blocker | Bounded local next step | Owner check |
|---|---|---|---|---|---|
| 1 | Open tab shows the Sample business's made-up plan seal as this browser's passkey signature, no Sample tag | `api-mock/demo-data.ts:54` → `sign-host.tsx:241` | No browser execution; needs a store rebuild while a tab stays open | Two-tab browser run in an isolated mock (record v-1) | Is a mock demo ever shared between visitors? |
| 2 | In mock mode a recorded proof pack that fails the browser check is shown as a harmless "Sample proof pack" | `api-mock/evidence.ts:316` → `verify-panel.tsx:119` | No execution of the Proof page against an altered copy | `proof-model.test.ts` + altered copy of `ev-74756ea61a72ae7c` | None needed |
| 3 | "Every check passed · Recorded on <chain>" names the first manifest deployment, which the verifier does not bind | `api-mock/evidence.ts:256` → `verify-panel.tsx:128` | `verifyBundle` not run on a crafted two-deployment pack | Prepend a Sepolia entry to a copy of `ev-cdc4cc7916471c1e`, re-hash, verify | None needed |
| 4 | settle-spend/reconcile lock waits can beat the urgent relay of a Treasury.pause past its 30 s wait | `api/routes/control.ts:25` → `relay-wake.ts:42` | Real pass durations and pg-boss phase on Sepolia | Fake-timer test, three waiters behind one holder (record v-4) | Worker logs: `job_skipped_lock_busy` for `relay`, pause latency |
| 5 | The mock Sample business switch lets any caller rebuild the shared demo store, bypassing the officer-only reset | `web/app/api/[...route]/route.ts:42` → `api-mock/store.ts:226` | No execution; reachability of a shared/tunnelled mock | vitest against the mock app (record v-5) | Is any mock demo reachable by non-operators? |
| 6 | Cross-site or remote GETs of unseen chat ids use up the 200 seeded histories, so later sessions start without the sample | `web/app/api/[...route]/route.ts:42` → `api-mock/store.ts:241` | Browser local-network policy; no execution | 201 GETs in a vitest harness (record v-6) | Judges' browsers; mock exposure |
Full traces, evidence and plans: `NEEDS-VALIDATION.md`.

## 6. Hardening and positive patterns
48 hunter hardening notes are in `hardening.generated.md` (not findings). Notable: the chat's "Signed. The balance is paid
once it's saved." text is not gated on a server fact; the quick-intent digit guard is ASCII-only; the mock is looser than
the chain in places (ADD_PAYEE never re-cools or expires, duplicate RELEASE_STAGE approval, pacing slots, catalog
funding); `final-1` and `final-2` share the FINAL key set and the worker preflight does not check `Treasury.registry()`;
the sign sheet title shows the listing name; `dev:mock` keeps an inherited `MOCK_API=0`.
Positive: single-use chat actions under an advisory lock; templated chat replies with no model text and `data-sign`
filtered; pinned explorer links and contained evidence reads (realpath, O_NOFOLLOW, inode match, size caps); browser
re-derivation of every signed row and digest; the new mock outflow bound mirrors the Treasury; the sample builder fails
closed on any step the chain would refuse.

## 7. Coverage
167 ledger units: 40 covered, 5 candidate (6 leads), 2 blocked (external facts: pnpm's default release-age gate and
Next 16.4.0's dev cross-origin default), 6 deferred (critic gaps: non-waiting worker jobs under the new waiters; the
officer exception row no longer showing the target and values it approves; mock MilestoneRelease submit binding; mock
catalog funding outside the outflow bound; Sample labels on the Plan signature and receipts; mock autonomy counts),
114 out_of_scope. Deferred units go to the post-fix skills re-check.

## Remediation (outside the audit's verdicts)
All six leads are fixed (user decision: the Sample business switch is loan-officer only), each with a regression test
seen failing first: fix10-worker (v-4), fix10-seal (v-1), fix10-proof (v-2, v-3; plus the optional verifier check that
a manifest lists only contracts.json's deployment) and fix10-mock (v-5, v-6). The deferred officer-row gap was fixed by
fix10-officer (every request shows what is approved, from the typed payload). The post-fix skills re-check
(`security-review`, `nodejs-keccak256`, `llm-trading-agent-security`, see `recheck-run10-fixes.md`) found 0 critical,
0 high, 3 medium and 13 distinct low items, including one regression of fix10-worker; all medium and all but the
accepted low items are fixed on `wip/int-ux` (rcfix-mock, -seal, -proof, -officer, -autonomy, -worker, -journey). The
deferred critic units resolve as: officer row fixed; mock MilestoneRelease binding fixed (W-2); mock catalog funding
fixed (W-1); Plan signature and receipts Sample labels not a defect (page-level Sample labels; no browser method or
time claimed); mock autonomy counts fixed (W-4); non-waiting worker jobs: cfo-guard now waits (A-5), the others cost
liveness only.
