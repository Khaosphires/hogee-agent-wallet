# Security audit — hogee run-11

## 1. Run, scope and limits
- **Profile:** `quick`, **scoped** to the diff `3420445..7db6058` minus the generated pack `evidence/fisco/fm-6861d1d5e991f1f2`
  (68 paths): the FISCO BCOS mirror — deploy-script chain/clock checks, the `scripts/fisco` ops scripts and macOS sandbox
  profiles, the `scripts/redteam` FISCO replay and Sepolia code capture, and the `tools/verify-evidence` FISCO pack checker.
  **This is a partial pass**, not a full audit.
- **Source ref:** `7db6058` (int-ux after the FISCO merges), read from a clean detached worktree. **Budget:** none set.
  **Agents:** 4 reconnaissance, 3 hunters (17 planned units: 10 new, 7 run-10 units whose starting paths the range touches),
  4 candidate verifiers (Phase 3 and Phase 5 merged, as the quick profile allows), 1 final coverage critic.
- **Execution:** sandboxed source-and-local-only policy, and **no target code was executed**: the macOS host cannot enforce
  the required memory and disk limits and no reviewed artifact-promotion code exists. Every check is source-only, so no
  record can reach `confirmed`.
- **Prior runs:** run-10 read (runs 1–10 have no confirmed records). Run-10's 6 leads were fixed in PR #15 and are outside
  this range. 160 prior units are `out_of_scope` (source unchanged); the 7 touched units closed as covered.
- **Critic:** one final post-wave critic. It accepted 3 in-scope gaps, recorded `deferred` (no second wave in `quick`):
  Foundry RPC clients following redirects, terminal/shell injection of node- or pack-controlled text, and the node sandbox's
  inherited rules, wildcard loopback bind and selftest coverage. It reassigned nothing. No clean-coverage claim is made.

## 2. Posture
The mirror's design holds up where it matters most for signatures: every real-key transaction is EIP-155 chain 20200 and
every real-key EIP-712 signature uses the `fisco` salt, so nothing it signs carries Sepolia authority; the env file is
parsed for exactly four names; the replay refuses non-loopback URLs and checks chain 20200 before every send; the release
pins fail closed; the checker recomputes signatures, plan hash, refusals and the cross-chain replay against the pinned
Sepolia bundle. The four leads cluster in two places: **containment of the unauditable FISCO binary** (it may write all of
the chain dir that later unsandboxed steps trust; it may read the real keys from the launch-time environment of the
replay; it can redirect the replay's HTTP client off loopback) and **one trust-root gap in the checker** (the pack chooses,
and can skip, the only pin of the final-2 deploy broadcast).

## 3. Confirmed findings
None. (Source-only pass; see §1.)

## 5. NEEDS VALIDATION (leads, no severity)
| # | Lead | Trace (start → sink) | Blocker | Bounded local next step | Owner check |
|---|---|---|---|---|---|
| 1 | Unsandboxed FISCO scripts follow links inside the node-writable chain dir, so a sandboxed node could redirect their writes outside it | `chain-up.sh:149` → `deploy.sh:161` | Whether node.sb lets a sandboxed process create a link in D pointing outside D | `ln` under a copy of node.sb in scratch, then an unsandboxed redirect (record v-1) | `find <D> -type l` before deploy |
| 2 | The FINAL role keys stay in the launch-time environment of pnpm and node, readable by a same-uid sandboxed node via kern.procargs2 | `chain-up.sh:149` → `writer.ts:84` | Whether node.sb (and bsd.sb/system.sb) lets a sandboxed process read another process's procargs env | Dummy-env holder + sysctl probe under node.sb (record v-2) | Same-uid check of nodes vs replay (no -E on real processes) |
| 3 | The replay's RPC transport follows HTTP redirects, so the loopback guard does not bind where signed txs are sent | `chain-up.sh:150` → `rpc.ts:60` | Node 24 fetch following a cross-origin 307 not observed | Two loopback fixtures, 307/302 to a recorder (record v-3) | None needed |
| 4 | A FISCO pack chooses, and can skip, the only pin of the final-2 deploy broadcast | `fisco/cli.ts:120` → `fisco/cli.ts:84` | A crafted pack was not built or run | Re-indexed copy with a missing broadcastFile; altered-constructor fixture (record v-4) | Fresh-clone `make verify-fisco` on the altered copy |
Full traces, evidence and plans: `NEEDS-VALIDATION.md`.

## 6. Hardening and positive patterns
32 hardening notes from hunters and the critic are in `hardening.generated.md`. The most useful: run cast/forge from a
trusted cwd with a dead proxy for non-loopback hosts; bind only the chain ports; keep node pid files and the genesis
facts outside the node-writable tree; add a lower-case form to the key secret scan; refuse `localhost` in favour of
`127.0.0.1`; require https and exclusive writes in the Sepolia capture; escape control characters in every printed
node- or pack-supplied string; quote `PACK` in the Makefile; fail the checker when the folder name differs from packId;
model the unmodelled refusal guards or reject `rpc-refused` with an unrelated error; add a P1 CODEOWNERS rule for the
FISCO paths. Positive patterns: digest pins checked before and after copy; marker-guarded wipe; fail-closed date guard;
probe-before-send refusals; per-step keccak(raw) = hash; O_NOFOLLOW single-link pack reads; strict pack schemas with a
two-way hash index. Out of this audit's verdicts but worth noting to the owner: the repo's `.claude/settings.json` deny
rules cover only some dotenv names and only the Read/Edit tools.

## 7. Coverage
180 ledger units: 10 covered, 7 candidate (4 fingerprints), 3 deferred (critic), 160 out_of_scope. Both validators pass
(`validate-coverage-ledger.cjs`: 180 units valid; `validate-findings.cjs`: 4 findings valid). The scoped diff is the only
code reviewed; earlier code is covered only by runs 1–10's own (partial) passes.

## Remediation (outside the audit's verdicts)
P1 is fixing all four leads and the critic gaps in `fix11-ops`, `fix11-replay` and `fix11-check` (brief
`~/hogee-wt/FIX11-BRIEF.md`): narrowed sandbox write scope (nodes only) with pid files and genesis facts outside it, no
symlink-following writes into D, re-hash of the binary before start; keys handed to node on a file descriptor (never in
any environment) plus a kern.procargs/kern.proc. sysctl deny after the bsd.sb import; `redirect: "error"` in the replay
transport and a dead proxy for Foundry; the final-2 broadcast path and keccak pinned in the checker's source identity
with a failing line when the tracked copy is absent; plus the hardening above. A post-fix skills re-check follows.
