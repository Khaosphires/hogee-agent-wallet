# Security audit run-7: Hogee G2 schema batch, replan fix, task 1.15 harness, dev-live, mock mount

## 1. Run, scope and limits
- **Profile:** `quick`, scoped. **This is a partial pass.**
- **Scope:** `a33ea08..b1f869b`, minus the run-6 fix paths, which get the post-fix skills re-check instead. The scope covers:
  - **the G2 schema batch:**
    - officer-issued one-time enrolment codes;
    - the officer founder-key routes (pending, reject, enrolment-code);
    - `orderId` on `GET /api/suppliers/:id`;
    - `Shortlist.failureReason`;
    - `POLICY_ESCALATION` removed from `ExceptionCreate`;
    - SCHEMA_VERSION 2.0.0;
    - migration `0002_founder_enrolment`;
    - mock conformance;
  - the replan tighten-only fix;
  - the task 1.15 red-team runner;
  - `pnpm dev:live` and `LOCAL_RPC_URL`;
  - the mock mount in `route.ts`.
- **Source ref:** `b1f869b` (`wip/g2-merge`, which is p1/dev `e8d95fe` plus the G2 batch), read from a clean, detached, read-only worktree.
- **Execution:** source only. **No target code was executed**, because macOS cannot enforce the required sandbox limits.
- **Agents:** 4 hunters in one wave (`h-g2-auth`, `h-g2-data`, `h-replan`, `h-harness`), 2 verifiers (one per candidate) and 1 final coverage critic. No budget was set.
- **Prior runs:** runs 1–6 have no confirmed records. Run-4 lead 5 (first-come founder-key enrolment) is closed by the G2 enrolment code; `h-g2-auth` found that every enrolment invariant holds. Five prior units were reassigned because their source changed: passkey registration, supplier shortlist, exception approval, compilePlan and the route.ts mount.

## 2. Security posture
As far as the source shows:
- **Enrolment:**
  - Codes are 144-bit, stored only as keccak256, never logged and compared in constant time, with one answer for every failure.
  - Each code is single-use, revoked when a new one is issued, and consumed in the same founder-locked transaction as the key.
  - The registration challenge is HMAC-bound to the facility, the founder and the open code.
- **Officer routes:** only the officer reaches them. Approve registers exactly the reviewed pending key. Reject serialises with approve and never touches an on-chain key.
- **Replan:** the API baseline matches what PlanReplan reads, field by field. A wrong or stale `currentIntent` can only produce a draft that is flagged or tighter than asked, never a loosening that passes, because code 14 is computed independently against the on-chain current.
- **`orderId` and `failureReason`:** `orderId` is facility-scoped and informational. `failureReason` is a fixed server sentence.
- **Red-team runner:**
  - Real FINAL keys never reach argv, logs or the bundle.
  - It never sends to a non-deployment address.
  - Sepolia runs refuse a shared database or an opened facility before any transaction.
- **Mount and dev:live:**
  - Mode selection is unambiguous, every mode passes the request guard, and the persona is the same in every mode.
  - dev:live uses dummy keys, per-run secrets and a minimal child env.

## 3. Confirmed findings
None.

## 4. Needs validation (2; `NEEDS-VALIDATION.md`)
| Fingerprint | Lead |
|---|---|
| `api:founder-persona-trace-writers-unbounded` | Anonymous shortlist, exception (UNPAUSE with an empty payload) and inspection-upload writers grow `traces` without bound, so the whole-history evidence export can be refused for good (a variant of run-6 v-1). The exception flood also pushes worker- and server-opened requests out of the officer's 200-row list. The API's PolicyContext never sets `ctx.loosens`, so core's live-loosen bound never refuses. |
| `redteam/bundle-unredacted-error-text-rpc-url` | The runner writes raw case error text into `errors/<id>.json` and `report.json`. viem errors from the runner's own chain reads carry the RPC URL, possibly with its API key, and the post-run secret scan does not look for loaded URLs. The verifier ruled out the plug child as a vector and warned against redacting generically in `Bundle.write`. |

## 5. Hardening (26 notes; `hardening.generated.md`)
The ones being fixed:
- reject also revokes an open enrolment code;
- rejected keys are checked by (qx, qy) as well;
- mock enrolment parity: the code is bound to the challenge, marked used synchronously, there is one pending key, and approve refuses once a key is REGISTERED;
- `stillCurrent` re-checks code 14;
- compileEnv uses the validated plan row;
- the RELEASE_STAGE approve checks rowCount;
- Sepolia preflight runs before migrations, and compares the chain and Treasury address;
- the anvil target refuses a non-31337 database;
- the T29 fee cap;
- dev:live: Anvil `--no-cors`, no trust-auth TCP superuser, a blanked web-child env, and `--block-time 1 --slots-in-an-epoch 1`;
- route.ts throws on REPLAY together with MOCK_API=0.

Accepted:
- the plan-signing panel lacks payee-diff rows;
- the facility cap is read from the DB row;
- the mock's exception lifecycle differs;
- `evaluateReplan` is stricter than PlanReplan for bound but unlisted payees.

## 6. Coverage
- **Ledger:** 113 units: 7 covered, 3 candidate, 7 deferred, 96 out of scope.
- **Final critic:** `stop: false`. It accepted 7 missing units, all deferred:
  1. mock and replay evidence reads (P2's PR #6 already hardens them);
  2. Next dev-server framework endpoints under dev:live (`allowedDevOrigins`, P2's `next.config.ts`);
  3. `dev-mock.mjs` inheriting `MOCK_API=0` and the parent env (P2);
  4. first-plan agent provenance from `hogee_worker.roles` (a DATABASE_URL holder);
  5. the browser signing panel (P2);
  6. the MCP server's authority (P2, task 2.16);
  7. the new P2 dependencies (supply chain).

  Items 2, 3 and 5–7 go to P2 as notes.
- **Validators:** both pass (`validate-findings.cjs`: 2 records; `validate-coverage-ledger.cjs`: 113 units).
- **Scope limit:** this run covers only the scoped diff and does not exhaust the target.

## 7. Fixes in progress
- `wip/run7-api`: item 1 above, plus the API, DB and mock hardening, plus a windowed trace export, so that unreferenced old traces can no longer block the export.
- `wip/run7-scripts`: item 2 above, plus the runner and dev:live hardening.
