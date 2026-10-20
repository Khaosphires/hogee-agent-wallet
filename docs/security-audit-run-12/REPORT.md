# Security audit: hogee run-12

## 1. Run, scope and limits
- **Profile:** `quick`, **scoped** to the diff `2590ae0..6b0913e`, minus generated packs under `evidence/fisco/` (97 paths).
  **This is a partial pass, not a full audit.** The diff covers:
  - FISCO auth mode, with a regulator committee key, node4 joined by proposal, and node4 Web3 on 8546;
  - the fifth regulator key line on fd 3;
  - native TLS receipts;
  - the regulator replay steps;
  - the v2 pack checker (regulator ledger and regulator powers);
  - the Sepolia anchor (the `anchor.sh` signing script and the sidecar check);
  - three FISCO evidence routes, on both the real and the mock API;
  - the Proof page FISCO section.
- **Source ref:** `6b0913e`, the int-ux head after the merges plus two dry-run fixes, read from a clean detached worktree.
  **Budget:** none set.
- **Agents:**
  - 6 hunters, covering 33 planned units: 11 new units, plus 22 earlier units whose relevant source this range changes;
  - 4 candidate verifiers (Phase 3 and Phase 5 merged, as the quick profile allows);
  - 1 final coverage critic.
- **Execution:** the sandboxed source-and-local-only policy. **No target code was executed**: the macOS host cannot enforce
  the required memory and disk limits, and no reviewed promotion code exists. Every check is source-only, so no record
  can reach `confirmed`.
  - One bounded validation was attempted for v-3, using Apple tools only and a 127.0.0.1 listener. Its positive control
    produced no fetch even without a sandbox, so the test was void and the lead stays `needs_validation`.
- **Prior runs:** run-11 was read. Runs 1–11 have no confirmed records.
  - The critic marked all four run-11 leads resolved in current source.
  - 157 prior units are `out_of_scope`: their relevant source is unchanged. The shared files they list, such as
    api-contract `routes.ts`, changed only by adding the FISCO routes.
- **Critic:** one final post-wave critic. It accepted 1 in-scope gap, recorded as `deferred` (the quick profile runs no
  second wave): passing Proof page rows and the timestamp card state more than the browser proved, and the caveats in
  the checker's ok details are dropped. It reassigned nothing. No clean-coverage claim is made.

## 2. Posture
The new code keeps run-11's containment, and the high-stakes paths hold in source:
- **The four real FINAL keys and the new regulator key** reach the replay only on fd 3, and the pack secret scan covers
  every form of them.
- **The replay** reaches only loopback, refuses redirects, and checks chain 20200 before every send. node4's client
  allow-lists reads. The native TLS client trusts only the chain CA.
- **The regulator steps** are the only system calls allowed. Each must take effect, or the run stops.
- **The checker** derives AccountFrozen and PermissionDenied offline from signed calldata, native outputs and block order.
  F1, M1 and R17 are bound to one calldata. node4's copy is bound tx by tx.
- **The API's FISCO reader** is contained (realpath, `O_NOFOLLOW`, inode match, caps) and is tenancy-bound to the source
  bundle.
- **The anchor script** binds chain, recipient, value and input twice before the user's `[y/N]`.

The four leads fall in three places:
- **What the user consents to when publishing the one Sepolia transaction:** the fee caps and the nonce are chosen by the
  RPC.
- **What the Proof page claims:** a not-anchored state is shown as a passing "Timestamped on Sepolia".
- **Two containment edges:** the build sandbox inherits system-helper lookups, and an RPC-text sink is unfiltered.

## 3. Confirmed findings
None (source-only pass; see §1).

## 5. Needs validation (leads, no severity)
| # | Lead | Trace (start → sink) | Blocker | Bounded local next step |
|---|---|---|---|---|
| 1 | The Proof page shows a passing "Timestamped on Sepolia" check for a pack with no Sepolia anchor | `fisco-store.ts:167` → `fisco-cards.tsx:221` | Rendering not observed (no execution) | vitest/@testing-library render of FiscoChecks on an unanchored listing (record v-1) |
| 2 | The anchor tx's nonce, gas limit and fee caps are filled by the untrusted Sepolia RPC, never bounded, and the fees are not shown before `[y/N]` | `anchor.sh:68` → `anchor.sh:168` | Whether Foundry cast puts a ceiling on RPC fee estimates | Loopback fixture RPC with 10,000-gwei answers and a throwaway keystore, answering `n` (record v-2) |
| 3 | `build.sb` blocks only its own sockets; the inherited trustd and XPC-service lookups may give the sandboxed `build_chain.sh` an out-of-sandbox network channel | `chain-up.sh:124` → `build.sb:13` | Whether trustd or framework XPC services fetch for a caller confined by sandbox-exec | Loopback AIA-fetch probe under build.sb with a working positive control (record v-3; the attempted probe was void) |
| 4 | `fisco:sepolia-code` prints Sepolia-RPC-controlled text to the terminal without the `nodeText` filter | `rpc.ts:103` → `sepolia-code.ts:126` | V8 and viem error text and the terminal emulator's behaviour | In-memory Transport returning ESC bytes; assert a raw 0x1b on stderr (record v-4) |

Full traces, evidence and plans are in `NEEDS-VALIDATION.md`.

## 6. Hardening and positive patterns
45 hardening notes from the hunters are in `hardening.generated.md`. The most useful:
- **Ledger digest:** `node0Keccak` is computed over the same array written as the ledger, so the offline node4 = node0
  comparison is vacuous. Write node4's copy and digest node0's separately.
- **parseSignedTx:** require low-s and a canonical round trip.
- **Anchor display:** label the sidecar's block and time "confirm on Etherscan".
- **FISCO routes:** serve only allow-listed pack paths; filter by tenancy before the listing cap.
- **Stop cards:** show the chain's words only when they match FISCO's known texts.
- **Sandbox and chain-up:** tie the listeners to node pids; require link count 1; refuse adopting a non-empty `--dir`;
  pass `--chain 20200` to Foundry.
- **Checker:** require regulator ≠ the other roles; wrap `privateKeyToAccount` for the regulator key.
- **CODEOWNERS:** add P1 lines for the browser code that decides the FISCO pass.

Accepted residual: the published packs carry the FINAL keys' raw txs for chain 20200, FISCO's default chain id. These have
zero value and zero gas price, and Sepolia is unaffected.

Positive patterns:
- probe-before-send for governance calls, with a stop on any non-zero int return;
- a client-side read allow-list for node4;
- one SPEND calldata reused by construction;
- the strict anchor text regex, checked by both TS and bash;
- the exclusive no-follow sidecar write;
- the decode-twice-then-confirm flow before the one outward transaction.

## 7. Coverage
191 ledger units: 28 covered, 5 candidate (4 fingerprints), 1 deferred (critic), 157 out_of_scope. Both validators pass:
`validate-coverage-ledger.cjs` reports 191 units valid, and `validate-findings.cjs` reports 4 findings valid. The scoped
diff is the only code reviewed; earlier code is covered only by the (partial) passes of runs 1–11.

## Remediation (outside the audit's verdicts)
P1 is fixing all four leads, the critic gap and the useful hardening notes in `fix12-anchor`, `fix12-check`, `fix12-web`
and `fix12-chain` (brief: `~/hogee-wt/FIX12-BRIEF.md`). A post-fix skills re-check follows (`security-review`,
`nodejs-keccak256`, `llm-trading-agent-security`). Its result is recorded in the repo copy of this run
(`docs/security-audit-run-12/recheck-run12-fixes.md`).
