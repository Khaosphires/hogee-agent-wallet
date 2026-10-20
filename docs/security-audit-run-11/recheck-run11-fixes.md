# Run-11 fixes and post-fix skills re-check (20 Oct 2026)

Security audit run-11 (quick, scoped `3420445..7db6058`, source-only) reviewed the FISCO BCOS mirror and left 4
`needs_validation` leads and 3 deferred critic gaps (see `REPORT.md`, `NEEDS-VALIDATION.md`). All were fixed in two rounds,
re-checked with the `security-review`, `nodejs-keccak256` and `llm-trading-agent-security` skills, and then exercised on
a freshly built chain.

## Leads and gaps

| Item | Fix | Re-check | Live check |
|---|---|---|---|
| L1 chain-dir link entries followed by unsandboxed writers | `node.sb` writes only `D/nodes`; `build.sb` only `build`, `nodes`, `home`, `tmp`; pid files, logs, genesis facts, keys and deploy files outside any sandbox's write scope; every unsandboxed write refuses links and non-regular targets; binary re-hashed before start (fix11-ops) | closed | selftest: node writes to `keys/`, `deploy/`, `bin/`, `logs/`, `run/`, `facts/`, `tools/`, `D/` denied; a symlink to an outside file can be created in `D/nodes` but not read through; a hard link is denied |
| L2 role keys readable from the launch environment | keys handed to node on fd 3 (never in any process's argv or environment, no pnpm), read once, bounded, closed; `replay.sh` refuses `*_PRIVATE_KEY*` in its own environment; `node --disable-sigusr1`; `kern.procargs*`/`kern.proc.*` sysctl reads denied in both profiles after the `bsd.sb` import (fix11-ops, fix11-replay, fix11b) | closed | replay ran end to end on fd 3; `ps -E` probe not testable on this macOS (no process shows its environment even outside the sandbox). **Run-12 note:** that sysctl deny did not stop a numeric `kern.procargs2.<pid>` read (the kernel checks it as `process-info-pidinfo`); `(deny process-info*)` + `(allow process-info* (target self))` in both profiles now closes it (see `docs/decisions/fix12-chain.md`) |
| L3 replay HTTP client followed redirects | `redirect: "error"`, any 3xx refused, only the literal `127.0.0.1` accepted; the Sepolia capture uses the same transport, requires https off loopback and writes exclusively (fix11-replay) | closed | unit tests with real 127.0.0.1 servers: 301/302/303/307/308 all refused, the redirect target receives nothing |
| L4 pack chose (and could skip) the final-2 broadcast pin | `FINAL_2` pins `contracts/broadcast/DeployFinal.s.sol/11155111/run-1792385076465.json` and keccak256 `0xd729b12a…f0f52a`; the library entry enforces it; a missing or different tracked copy is a FAIL line (fix11-check) | closed | the audit's forged pack (one constructor value changed everywhere) passed all checks before and fails "deploy inputs" now |
| Gap: Foundry clients follow redirects | every forge/cast call goes through `foundry_in` (dead proxy `127.0.0.1:9` for any host but `127.0.0.1`, empty trusted cwd); `foundry_egress_check` runs before the first RPC call of `chain-up.sh` and `deploy.sh` and fails closed unless a request to `192.0.2.1` dies at the dead proxy (fix11-ops, fix11b) | partial → closed with runtime evidence | tested with loopback servers (Foundry 1.8.5): cast follows a 307 to another 127.0.0.1 port (residual, below); a redirect to `192.0.2.1` and a direct request both fail at the dead proxy |
| Gap: terminal and shell injection | node- and pack-controlled text cleaned of control and bidi characters before printing or recording; the FISCO checker escapes its text and JSON output; `PACK` reaches the shell as one quoted value (fix11-check, fix11-replay, fix11-ops) | closed | tests with `ESC]0;x BEL`, CR/LF and `;`/backticks/`$(shell …)` in a pack path |
| Gap: node.sb inherited rules, wildcard bind, selftest | binds limited to ports 30300-30304, 20200-20204 and 8545; selftest adds read, listen, symlink, hard-link and `ps -E` probes; README states the inherited residuals (fix11-ops, fix11b) | partial (residuals documented) | selftest: listen on an unlisted port denied; reads outside `D/nodes` denied |

## Other re-check items fixed (fix11b)
The checker compares the served transaction's hash, `to`, value, gas and chain id with the signed bytes; the replay writes
`sepolia-broadcast.json` from the same bytes it hashed; the secret scan covers base64url and unpadded base64; a comment
explains why an expected-success step whose probe fails is still sent (the receipt decides); `build_chain.sh` runs as its
own process group and nothing of it may survive before the script writes into `D/nodes`; CODEOWNERS gives P1 the FISCO
paths, `scripts/redteam/package.json` and `scripts/redteam/src/safety.ts`.

The `nodejs-keccak256` re-check recomputed every hash of the recorded pack independently (Keccak-256 via pycryptodome):
the pinned broadcast keccak, the packId, all 47 `hashes.json` entries, all 27 transaction hashes, the bloom rule on 27/27
receipts, the EIP-712 type hashes, the approval digest and the plan hash all match.

## Accepted residuals
- forge/cast follow a redirect to another port on 127.0.0.1; only throwaway deployer/admin-signed transactions and read
  calls take that path, never the final-2 role keys.
- The node sandbox inherits from Apple's `bsd.sb`/`system.sb`: metadata (stat) reads of any path, data writes to files
  named `*.CFUserTextEncoding`, file creation under `/cores/`, and `/dev/fd`.
- The FISCO binary is prebuilt by FISCO's CI and stripped; containment, not audit, is the control.
- FISCO block headers are taken as served (the checker says so).

## Final run
The chain was rebuilt from scratch with the final scripts (`~/fisco-hogee/chain3`): `verify-release`, `chain-up` (5
nodes, node4 observer), `chain-check --selftest` (37 PASS, 3 notes), `chain-check` (loopback only, 20 peer links, 0
network denials), `deploy` (VerifyFinal PASS), and the final-2 replay (23 steps, 27 transactions). The pack
`evidence/fisco/fm-c2b22fa376a165da` reports VERIFIED with all 15 checks, with and without a local contracts build.
