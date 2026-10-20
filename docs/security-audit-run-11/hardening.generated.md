# Hardening notes — hogee run-11

Hunter hardening notes kept in ledger bookkeeping (not findings; no verdicts). Grouped by hunter.

**h-checker**

- tools/verify-evidence/src/fisco/cli.ts / src/read-dir.ts: the pack is read with the general bundle caps (5,000 entries x 32 MiB) before loadPack applies the pack caps (400 files, 4 MiB, about 49 KiB per code file). Pass the pack caps into the directory walk.
- tools/verify-evidence/src/fisco/cli.ts: the folder name is never compared with pack.json's packId, although the docs call the packId the folder name. Fail when basename(dir) !== packId.
- tools/verify-evidence/src/read-dir.ts: recursion and the path-based lstat/readFileSync follow a subdirectory that is swapped for a symlink after readdir. Use descriptor-relative no-follow opens if concurrent local writers matter.
- tools/verify-evidence/src/fisco/deploy.ts: artifacts.json deployedBytecode is never tied to its creation bytecode. Without --artifacts the code-identity line compares three pack-supplied runtime blobs. Require the creation bytecode to contain the deployedBytecode (immutables zeroed), or require --artifacts for VERIFIED.
- tools/verify-evidence/src/fisco/refusals.ts: spendRule omits AgentExpired/LineExpired (timeWindow against the manifest's agent.expiresAt and validUntil), line pause and CircuitOpen; ownerRule omits _useEnvelope nonce reuse. rpc-refused is accepted with any rpcError, although FISCO 3.17.1 mines reverts (docs/fisco/README.md). Reads need no specific labels. Model these guards, or reject rpc-refused unless the rpcError names the derived error.
- tools/verify-evidence/src/fisco/view.ts blockOrder: steps sharing a block are not ordered by transactionIndex; logsBloom is optional, and a receipt that omits it skips the bloom check (only noted).
- .github/workflows/ci.yml: third-party actions are pinned by mutable major tags; gitleaks is downloaded without checksum verification; foundry-toolchain has no version input. All jobs have read-only GitHub permissions and no secrets.
- .github/CODEOWNERS: '/scripts/ @Pvio98' covers scripts/fisco/* and scripts/redteam/src/fisco/*, the real-key replay and sandbox profiles that P1 runs. Add a P1-owned rule for these paths.

**h-ops**

- lib.sh prepare_chain_dir runs chmod 700 (line 121) before the pwd -P equality check (line 122). A --dir with '.' or '..' components or different letter case (for example <home>/<subdir>/..) passes the lexical home, Desktop and Documents guards in refuse_unsafe_dir and gets chmod 700 on the resolved operator-owned directory before the script dies. Reject '.' and '..' components and move the canonical-path check ahead of mkdir and chmod.
- lib.sh foundry_in runs cast with the node-writable D as its working directory (chain-up.sh:171, deploy.sh:79,91,130-133,143,174,177,190). Foundry reads project config and dotenv files from its working directory, so sandboxed code could influence cast's environment (for example proxy settings) for the throwaway admin and deployer sends. Run cast from a fixed trusted directory instead.
- The fix for the candidate could also narrow node.sb's writable subpath to D/nodes (or per-node folders) and keep keys/, deploy/, logs/, bin/ and observer.block outside the sandbox's write scope. D/bin/fisco-bcos stays node-writable after install; it is re-hashed at each chain-up, but making it immutable to the sandbox removes the gap the architecture notes.
- chain-check.sh has no positive sandbox attestation for the running pids. It relies on pid-file provenance, and the pid files live in node-writable D. Consider recording the start pids outside D and checking the sandbox status of each pid.
- DeployLoop._checkChain now accepts a fisco tag with FISCO_MS=false on any chain other than 31337 and 11155111; it does not pin chain id 20200. Sepolia and Anvil are unaffected, and EIP-712 domains include chainId, so signatures cannot be reused across chains. Consider an explicit FISCO chain-id allow-list.
- deploy.sh only prints a NOTE when the eth_call block.timestamp probe is not served, and relies on the genesis file check. Consider failing closed, since the forge simulation cannot see the EVM clock unit.
- chain-up.sh removes /private/tmp/secp256k1.param, then build_chain.sh recreates or reuses it. Another local user could place a file in the gap. The post-build content check and the per-node secp256k1 OID check bound this; a param path inside D would remove the race.
- refuse_unsafe_dir does not refuse other synced folders such as ~/Library/CloudStorage/*.
- verify-release.sh calls gh, tar, file, codesign, otool and strings through PATH, unlike the scripts' absolute-path policy. The pinned digests still decide.
- The unauthenticated loopback Web3 RPC runs with permission checks off, so any local process can send transactions, including system-contract calls, to the throwaway chain. This stays within the accepted throwaway-chain boundary. Whether a browser page can reach it (simple POST or DNS rebinding) is a runtime fact.

**h-replay**

- sign.ts:75-80 keySecretForms has no lower-case form, and the scan in safety.ts:159 is case-sensitive. An upper- or mixed-case key in the env file would leave the lower-case form, which is what viem emits, unscanned. Compare case-insensitively or add k.toLowerCase().
- replay.sh:85 accepts keys without 0x, but cli.ts:72 and keys.ts:29 require 0x. This is a fail-closed inconsistency; normalise in replay.sh.
- Before loadSigners runs, the keys are in the env of pnpm, its script shell, node and any child spawned during module loading, such as tsx's esbuild service when not cached. Prefer running node directly and reading the keys from an fd.
- replay.sh runs the --repo worktree's code with the real keys (replay.sh:45,98,103), not necessarily the worktree replay.sh came from. Consider requiring REPO == FISCO_REPO_DIR or printing its commit before reading keys.
- pnpm with packageManager pnpm@12.11.2 may self-provision a matching pnpm while holding the keys in its env. Launching node directly avoids running the package manager with the keys.
- rpc.ts:32 accepts 'localhost', which resolves via the system resolver and may connect to [::1]:8545, which another local user can bind while the node listens on 127.0.0.1 only. replay.sh uses the 127.0.0.1 literal; dropping localhost closes direct invocations too.
- runner.ts:148-152 treats a JsonRpcError from the pre-send eth_chainId guard (rpc.ts:144) as the node refusing the send and records rpc-refused for a tx that never left the process. The late-receipt path also does not validate status. Separate guard errors from send errors.
- cli.ts:118 and :149 print node-controlled text (probe errors, RPC messages) raw to the operator's terminal. Strip control characters to avoid terminal escape injection by a hostile node.
- sepolia-code.ts:30/55: the existsSync check and recursive mkdirSync are separated by network calls. Use a non-recursive mkdir that fails on an existing path, and open files with exclusive no-follow flags so a symlink planted under a shared --out cannot redirect the writes.
- sepolia-code.ts:78 accepts plain http for a remote Sepolia RPC. The capture authenticates neither block nor code (the Sepolia bundle pins no runtime code hash), so a MITM or lying RPC with chainId 0xaa36a7 controls code-sepolia. Require https for non-loopback hosts; code identity currently rests on the checker's --artifacts comparison.
- sepolia-code takes the provider URL, which can carry an API key, on argv (--rpc <url>). Other local users can see it via setuid /bin/ps, and pnpm's script banner likely echoes it, contrary to the header's 'never printed'. Accept the URL via env or stdin.
- docker-compose.yml:7,27,33 pins images by tag only (postgres:16 is a floating major tag). Pin by digest. The Postgres default password 'hogee' is loopback-only and documented as override-on-shared-host.
- .claude/settings.json denies Read and Edit for only some dotenv variants (not other suffixes, and not the Bash tool), so an AI assistant can still read env files with other names, including a HOGEE_ENV_FILE elsewhere, through the shell.
- Unresolved note moved from a covered unit: Registry provenance and digests of ghcr.io/data-privacy-stack images and postgres:16 cannot be checked offline
