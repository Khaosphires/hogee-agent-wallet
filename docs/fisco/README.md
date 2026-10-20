# FISCO BCOS mirror (local, offline-verifiable)

Hogee runs on Sepolia: deployment `final-2`, verified bundle `evidence/ev-74756ea61a72ae7c`. The FISCO mirror deploys the **same contracts** on a local FISCO BCOS 3.17.1 chain, then replays the final-2 run and its refusals there. The result is a **FISCO mirror pack** (`evidence/fisco/fm-<16hex>/`) that anyone can check offline with `make verify-fisco`.

The app (API, worker, web) stays on Sepolia. Only the contracts, the replay and the pack touch FISCO.

On this chain a **regulator** governs through FISCO's own permission system: it can freeze the AI agent's account and
ban one contract method for it, and it keeps its own copy of the ledger on node4 (see "The regulator" below).

## What it is, and what it is not

- **A local chain.** It has five nodes on 127.0.0.1: node0–node3 seal blocks (PBFT) and node4, the regulator's node, is an observer. FISCO's chain id is 20200. Permission checks are on. The Web3 RPC is on node0 at `http://127.0.0.1:8545` and on node4 at `http://127.0.0.1:8546`.
- **Not publicly verifiable.** No one else can query this chain, and there is no explorer. Trust comes from the pack:
  - the signed raw transactions, receipts and blocks;
  - the deployed code, compared byte for byte with the Sepolia code and the compiler output;
  - the plan hash, which equals Sepolia's.

  `make verify-fisco PACK=<pack dir>` recomputes all of it offline. It also re-verifies the Sepolia bundle the pack points to.
- **The same contracts.** `scripts/fisco/deploy.sh` decodes the constructor values from the tracked Sepolia broadcast; nothing is typed by hand. It first checks that the Sepolia creation code equals today's build. Only two inputs change:
  - the chain tag (`fisco`, so every EIP-712 domain differs from Sepolia's);
  - the contract links (new addresses).

  The deployer is a throwaway key.

Facts of this FISCO build that the scripts and the pack rely on (the team lead's smoke test and live test, 20 Oct 2026):

| Topic | On the mirror |
|---|---|
| Chain id | 20200 (`0x4ee8`), also `block.chainid` inside the EVM |
| Clock | `block.timestamp` and block headers in seconds (genesis `feature_evm_timestamp=1`), so `FISCO_MS=false` |
| EVM | Cancun opcodes (`feature_evm_cancun=1`), Ethereum-style CREATE addresses (`feature_evm_address=1`), no P256 precompile |
| Transactions | legacy (type 0) with EIP-155, gas price 0, no balance needed |
| Blocks | no empty blocks: the head moves only when a transaction arrives |
| Reverts | a reverting transaction is mined with status `0x0`, and the sender's nonce moves |
| Served `v` | `eth_getTransactionByHash` serves `v` as the bare y-parity (0 or 1) even for an EIP-155 transaction; the replay re-encodes it before checking keccak(raw) = hash |
| `logsBloom` | Ethereum's bloom, except a log's address enters as keccak256 of its lowercase hex text without `0x`; the checker recomputes that rule |
| Certificates | with Homebrew OpenSSL 3.6 standing in for TASSL, `build_chain.sh` makes a CA without `CA:TRUE`; `chain-up.sh` reissues it (same key and subject) |
| Permissions | auth mode on (`build_chain.sh -a <regulator>`): genesis `[executor] is_auth_check=true`, `auth_admin_account` = the regulator (lower case), the committee's only governor (the team lead's live test, 20 Oct 2026) |
| Native RPC | `https://127.0.0.1:20200` (node0, `[rpc] enable_ssl=true` as generated), with the CA and the RSA-2048 sdk certificate and key; the certificates carry no IP name, so the client checks the chain against the CA only |
| System contracts | an account status change takes effect from the next block; a method ban takes effect at once; the observer proposal and the admin reset proposal each log one event from `0x…10001` |

## The regulator (auth mode)

The chain runs with FISCO's permission checks on. The regulator is a local account: `chain-up.sh` makes its keystore,
`D/keys/regulator.json`, before the build and passes its address to `build_chain.sh -a`. So the genesis names it
`auth_admin_account`, and it is the only governor of FISCO's committee (`CommitteeManager` at `0x…10001`). Any
proposal it creates passes and runs inside that same transaction. It also runs node4.

What it can do, through FISCO's own system contracts (the replay records each step; the step list and its checks are
in `scripts/redteam/src/fisco` and `tools/verify-evidence/src/fisco`):

- **Freeze the agent's account** (`AccountManager` at `0x…10003`, `setAccountStatus(agent, 1)`). From the next block
  on, the chain refuses the agent's transactions before any Hogee contract runs. Such a transaction is still mined:
  Web3 status `0x0`, native status 22 (AccountFrozen), and the agent's nonce moves. Status 0 unfreezes. Status 2
  (abolish) is never used. Because a status change counts only from the next block, the replay follows each freeze
  and unfreeze with a confirm step: the regulator reads the status in a transaction of its own.
- **Ban one method for the agent** (`ContractAuth` at `0x…1005`). A committee proposal first makes the regulator
  Treasury's admin. The regulator then puts `Treasury.spend` in blacklist mode and closes it for the agent. The
  chain refuses the agent's `spend` at once (native status 18, PermissionDenied), while the agent's other Treasury
  calls still pass. Opening the method again lifts the ban.
- After both are lifted, Hogee's own officer pause refuses the same `spend` inside the contract. The result is three
  independent stops on byte-identical calldata.

**Register first.** The agent's account must be registered with `setAccountStatus(agent, 0)` before the agent sends
anything at all. Otherwise a later freeze returns −51900, freezes nothing, and its receipt still says success. The
replay's first step does this, and every governance step's return value is checked: an `eth_call` first (must be 0),
then the native receipt's output.

**Its own ledger.** node4 serves Web3 on `http://127.0.0.1:8546`. Our side only reads from it: the replay's client
allows read methods only, because the node itself does not refuse a transaction (it would forward it). `chain-check.sh` checks that node4
has node0's head (number and hash); the replay compares every block and receipt.

**How node4 joins.** With permission checks on, a direct `addObserver` call is refused. Instead, `chain-up.sh` has
the regulator send `createSetConsensusWeightProposal(node4 id, 0, true, 1000)` to `CommitteeManager` (the team lead's live
test: block 1, status `0x1`). This is the regulator's only transaction before the replay. Its hash is in
`D/facts/observer.proposal`.

**Its key.** The keystore is local to the chain dir, with the same random password file as the deployer's
(`D/keys/pw`). A wipe removes it, so every new chain dir has a new regulator; the pack records its address.
`replay.sh` decrypts it and hands it to the replay as the fifth key line (see "Keys" below).

## Ports (all on 127.0.0.1)

| Port | Used for |
|---|---|
| 30300–30304 | p2p between the five nodes (TLS) |
| 20200–20204 | native JSON-RPC (TLS); the replay reads native receipts, with their FISCO status codes, from node0's 20200 using `D/facts/sdk` |
| 8545 | Web3 RPC of node0: deploy and replay |
| 8546 | Web3 RPC of node4: the regulator's copy of the ledger (read only from our side) |

`node.sb` lets a node listen on exactly these ports and connect only to the p2p ports.

## The regulator run (v2, final)

- Pack: `evidence/fisco/fm-6abe83e663a2471b` (60 files, format `hogee.fisco-mirror/2`), made on 20 Oct 2026 from commit
  `1556707` with the final scripts (the run-12 security audit fixes and their re-check; see
  `docs/security-audit-run-12/`). `make verify-fisco PACK=evidence/fisco/fm-6abe83e663a2471b` reports VERIFIED with all
  18 checks, with or without a local `contracts/out`; a one-character edit makes it fail. Its public Sepolia timestamp
  is described in `ANCHOR.md`.
- Public timestamp: Sepolia tx `0xd38cd129ee4082117436f1f9fbef93bd72862eb5f26b7f6a15dee0c0d2d36d5a` (block 11951818, 2026-10-20 00:47:48 UTC), a value-0 self-send from the
  hogee-deployer `0x46405e378F5AC837b8E18a96105e3ff3CCB22251` whose input names this pack and keccak256(hashes.json)
  (https://sepolia.etherscan.io/tx/0xd38cd129ee4082117436f1f9fbef93bd72862eb5f26b7f6a15dee0c0d2d36d5a, View input as UTF-8). Sidecar: `evidence/fisco/anchors/fm-6abe83e663a2471b.sepolia.json`;
  `make verify-fisco` requires it.
- Chain: 5 nodes on 127.0.0.1, auth checks on, the regulator `0xe2e37c3e148bf34e1e25587cec9354b7a7564ae3` as the genesis
  committee governor; node0-node3 sealers and node4 an observer joined by the regulator's committee proposal (block 1).
  Contracts: PlanRegistry `0xd6f22c5f56c66c2477ffad9f0e058db01cb9c0c4`, Treasury
  `0x57c6ad72217c66f447790fd5462f19441919250a`, MilestoneEscrow `0xe2753360b05951726727df7ad912a8357393a286`,
  SalesOracle `0x49771ec015f3ba94cb5a288a8cd33cebb7a7b23c`.
- 37 steps, 38 transactions (4 deploys + 34 sent steps; C1-C3 are eth_call checks, never sent). Every expected success
  mined. Nine refusals: seven refused by Hogee's contracts (CapExceeded, MilestoneLocked, NotOwner twice,
  SignatureExpired, InvalidSignature, Paused) and two **refused by the chain itself**: F1 AccountFrozen (FISCO status 22)
  and M1 PermissionDenied (status 18). F1, M1 and R17 carry byte-identical calldata. node4's copy of blocks 0..39 equals
  node0's.

## Earlier run (v1, replaced)

The v1 pack `fm-c2b22fa376a165da` (format `hogee.fisco-mirror/1`, 23 steps, made before the regulator existed) was
removed from the tree when the regulator run above was recorded; it stays in git history (run-11, PR #16). Earlier
runs (`fm-6861d1d5e991f1f2` pre-audit, `fm-17fb2dd18a0bd267` pre-re-check) are in git history only.

## Safety model

| Concern | How it is handled |
|---|---|
| What gets downloaded | Only the team lead downloads, by hand, two release files: `build_chain.sh` and `fisco-bcos-macOS-arm.tar.gz`. `verify-release.sh` checks their exact sizes and their SHA-256 against `scripts/fisco/SHA256SUMS` and against GitHub's own asset digests. The tarball must hold exactly one file, `fisco-bcos`, which is checked again by size and digest. |
| What the binary links | `otool -L` must list exactly eight system libraries: five frameworks under `/System` and three under `/usr/lib`. Anything else fails. The URLs inside the binary are printed for review: AWS SDK and curl documentation links, and no Chinese cloud hosts. |
| The build script's own downloads | `build_chain.sh` would fetch two things: TASSL (an OpenSSL fork) and `get_account.sh`. Two local stubs replace them before it runs. `HOME/.fisco/tassl-1.1.1b` is a link to Homebrew's OpenSSL 3. `HOME/.fisco/get_account.sh` only exits 1: `chain-up.sh` passes `-a <regulator>`, so `build_chain.sh` never runs it (the team lead's live test), and if it ever did, the build would stop. The file stays so that its absence can never lead to a download. On top of the stubs, the build runs under `build.sb`, a sandbox with no network at all. It runs from an empty `D/build` and may write only `D/build`, `D/nodes`, `D/home` and `D/tmp` (plus `/tmp/secp256k1.param`); it may read the copied script in `D/tools` and the binary. Beyond that, only what the imported `bsd.sb`/`system.sb` allow every process (see "What the profiles still allow"). Like the nodes, it cannot look up the Mach services that act for their caller outside the sandbox (trustd, analyticsd, nsurlsessiond, unmanaged XPC activities) or any XPC service, and it cannot read other processes' arguments, environment or details (see "Other processes and Mach services"). It runs as its own process group: once `build_chain.sh` exits, `chain-up.sh` stops if any process of that group, or any process with `D/tools/build_chain.sh` or `D/build` in its arguments, is still running, so nothing from the build can change `D/nodes` while the scripts check and rewrite it. |
| The nodes | Every node runs under `node.sb`. It may only: read and write `D/nodes` (the node folders, its `HOME` and `TMPDIR`); read and run its own binary; listen on the chain's own loopback ports (30300–30304, 20200–20204, 8545, 8546); connect to the five loopback p2p ports; and do what the imported `bsd.sb`/`system.sb` allow every process (see "What the profiles still allow"). It cannot read or write anything else in the chain folder (`keys/`, `deploy/`, `logs/`, `run/`, `facts/`, `bin/`). It cannot look up trustd, analyticsd, nsurlsessiond, unmanaged XPC activities or any XPC service, and cannot read other processes' arguments, environment or details (see "Other processes and Mach services"). Each config is rewritten before the first start: all listeners to `127.0.0.1`, CORS off, Web3 RPC on node0 (8545) and node4 (8546) only; the native RPC keeps TLS. Nodes start with `AWS_EC2_METADATA_DISABLED=true` and a minimal environment. Just before the start, `chain-up.sh` checks the binary's digest again and makes `D/bin` read-only. |
| Writes by the scripts | The scripts write only where no sandbox can write (D itself, `keys/`, `deploy/`, `logs/`, `run/`, `facts/`, `cwd/`, `tools/`, `bin/`), or before any sandboxed code runs. They refuse to write through a symlink or onto anything but a regular file they own with a single hard link (link count 1; the keystore and password file the replay reads must pass the same test), and every folder they use must be a real folder they own. The node pid files and start records are in `D/run`; node output goes to `D/logs/<node>.out`. The replay reads `D/deploy` and, from `D/facts`, files taken before any node starts and made read-only: the genesis copy `config.genesis`, `regulator.address`, and the native RPC's TLS files `sdk/ca.crt`, `sdk/sdk.crt` and `sdk/sdk.key` (mode 400). |
| `forge` and `cast` | They follow HTTP redirects. Every call runs with all proxy variables (upper and lower case) pointing at a closed loopback port (`127.0.0.1:9`) and only `127.0.0.1` exempt. With that dead proxy, any redirect or request to a host other than 127.0.0.1 fails (tested 20 Oct with Foundry 1.8.5). A redirect to another port on 127.0.0.1 is still followed; only transactions signed by the throwaway deployer and by the regulator (the observer proposal), and read calls, go this way. Before its first RPC call, `chain-up.sh` (for the observer proposal) and `deploy.sh` run `foundry_egress_check`: `cast chain-id` against `192.0.2.1` (a TEST-NET address) must fail within 20 s with "Connection refused" from the dead proxy, and nothing may listen on port 9; a success, a hang or any other error stops the script. Every foundry run (including the keystore subshells) checks again that nothing listens on port 9. The two signed sends name chain 20200 themselves (`cast send --chain 20200` for the observer proposal, `forge script --chain 20200` for DeployFinal, and for VerifyFinal), so the signatures are valid on no other chain whatever the RPC reports. They run from an empty `D/cwd`, never from the chain folder, so no `foundry.toml` or `.env` a node could place is read. |
| Checking it | `chain-check.sh` checks: every node runs `D/bin/fisco-bcos` and was started with the command recorded in `D/run` (node.sb with `NODES_DIR=D/nodes`, same profile digest); no symlink in the chain folder except the TASSL stub; `lsof` shows only `127.0.0.1` sockets; the listeners on 8545 and 20200 are node0's pid and on 8546 node4's, and nothing else listens there; the macOS sandbox log shows no network denial for `fisco-bcos`; the configs are as written (permission checks on, the regulator as genesis admin); the regulator's facts in `D/facts` are regular files with the right modes and `sdk.crt` verifies against `ca.crt`; the chain id is right; `isGovernor(regulator)` is true; node4 is an observer, and its Web3 on 8546 has node0's chain id, head number and head hash. Text the node serves is printed with control characters removed. |
| Self-test | `chain-check.sh --selftest` runs system tools under the two profiles. Both deny outbound connections (TEST-NET and LAN) and writes on the Desktop and in the chain folder itself. `build.sb` may write `D/tmp`, but no other existing folder outside its four. Under `node.sb`: loopback p2p connects are allowed; other loopback connects are denied; listening on an unlisted loopback port (30399, 8547) is denied and on a free chain port (20204, 8546) allowed (with the chain running, its own ports are in use and skipped; `scripts/fisco/test/profiles.sh` runs the 8546 and 8547 probes without a chain and checks no probe is left listening); reading a dummy file outside the chain folder (directly, or through a symlink in its nodes folder) and reading the chain folder's marker are denied; creating a hard link in its nodes folder to that outside file is denied; writes are allowed only in its nodes folder. Under `build.sb`, a hard link in `D/tmp` to the outside file or to a file in `D/logs` cannot be created. Under both: a sleeping process carries a canary in its arguments, which `ps` shows outside the sandbox; inside, a small perl reader asks the kernel for that process's arguments and table entry by number, as `ps` does, and must get the sandbox's "Operation not permitted" for both. (`/bin/ps` is setuid and cannot run in a sandbox at all, so the earlier `ps -E` probe proved nothing.) And `security verify-cert` of an Apple root certificate, which goes through trustd, succeeds outside and must fail inside. `scripts/fisco/test/profiles.sh` runs all of these on a throwaway folder without a chain. It also runs the run-12 probes under copies of the profiles with the rule removed, and there each probe must fail, so none passes vacuously (20 Oct: 65 checks). |
| Other processes and Mach services | Both profiles deny the Mach services that `system.sb` allows every process and that act or fetch for their caller outside the sandbox: `com.apple.trustd` and `.agent` (certificate checks can fetch CRLs, OCSP answers and missing CA certificates), `com.apple.analyticsd` and `.messagetracer`, `com.apple.nsurlsessiond` (background downloads) and `com.apple.xpc.activity.unmanaged`. The two lists are equal (`profiles.sh` checks). Both also deny every XPC service lookup (`xpc-service-name-prefix ""`): `system.sb` allows those for a version-1 profile, and an XPC service runs in its own process outside the sandbox. Other processes: the `kern.proc`/`kern.procargs*` sysctl-read deny stays, but on macOS 27 it does not stop the same reads asked for by number (`kern.procargs2.<pid>`, `kern.proc.pid.<pid>`); a sandboxed process read another process's arguments that way. The kernel checks those reads as `process-info-pidinfo`, so both profiles now deny every `process-info*` operation except on the process itself. The team lead tested them live on 20 Oct (fresh chain4): `build_chain.sh` and five nodes ran the full replay under these rules, and the self-test's trustd, other-process and hard-link probes were denied. |
| What the profiles still allow | `bsd.sb` and `system.sb`, which both profiles import, still allow: file metadata (`stat`) on every path, reads and data writes of existing files named `.CFUserTextEncoding`, creating regular files in `/cores/`, and `/dev/fd`; and lookups of the remaining system services in `system.sb`'s list (logging, preferences, directory and user lookups, notifications, runningboard, secinitd), none of which fetches anything for its caller. No other file contents outside the allowed folders, and no network beyond the rules above. A symlink a node makes in `D/nodes` is only a name: reads through it are checked against the file it points to. A hard link would carry an allowed path, so the self-test checks that a node cannot create one to a file outside the chain folder. |
| Privileges | No `sudo`, nothing installed system-wide, no launch agents. The binary lives in the chain folder (mode 555). The scripts refuse to run as root. |
| Where it lives | The chain folder D (default `~/fisco-hogee`) is mode 700 and carries a `.hogee-fisco` marker. The scripts refuse a D inside this repo or any git work tree, or in `~/hogee-wt`, `~/Desktop`, `~/Documents`, iCloud Drive or `~/Library/CloudStorage`. They also refuse a D that is or contains one of those folders, or home (D is made mode 700 and `--wipe` removes all of it). An existing D is taken over only if it is empty or already carries its own marker, so a folder with other contents is never marked, and so never wipeable. They also refuse `.` or `..` in the path, and a D whose real path (letter case included) differs from the one given, before any change to it. |
| Keys | The deployer (throwaway) and the regulator (local to the chain dir) are keystores in `D/keys` (mode 600, one random password file). The replay's four role keys come from the file the team lead names in `HOGEE_ENV_FILE`. `replay.sh` reads only those four names, line by line. The fifth key line, `REGULATOR_PRIVATE_KEY_FISCO`, comes from `D/keys/regulator.json`: `cast wallet decrypt-keystore` runs in a scrubbed subshell from the empty `D/cwd`, with the password in that subshell's environment only, and the key comes back on cast's output into a shell variable that is never exported. Before that, the keystore's address must equal `D/facts/regulator.address` and the genesis admin. `replay.sh` runs the replay with `node` directly (no `pnpm`), only from its own checkout, and hands all five keys over on file descriptor 3 (`--keys-fd 3`), from a pipe the shell writes itself. So they are never in any process's environment or command line, and never printed. |
| CA certificate | OpenSSL 3, standing in for TASSL, issues the chain CA without `basicConstraints`, so node TLS fails. `chain-up.sh` reissues only the CA certificate, with the same key and subject, adding the CA extensions. It then checks that every node and SDK certificate verifies. |

## How to run (the team lead)

All scripts are in `scripts/fisco/`. Each one except `anchor.sh` prints its usage with `--help`, and each fails closed: any failed check stops it with `FAIL: …`.

D must be new, empty, or a chain dir these scripts made (it carries its own marker); keep the downloads outside it.

```sh
S=scripts/fisco; D=~/fisco-hogee/chain; DL=~/fisco-hogee/dl   # D: new, empty or ours; DL outside D
$S/verify-release.sh $DL --dir $D                          # sizes, digests, tar listing, otool; installs D/bin/fisco-bcos
$S/chain-up.sh --build-chain $DL/build_chain.sh --binary $D/bin/fisco-bcos --dir $D   # 5 nodes, auth on
$S/chain-check.sh --dir $D --selftest                      # sandbox self-tests
$S/chain-check.sh --dir $D                                 # PASS needed before deploy and replay
$S/deploy.sh --dir $D --repo "$PWD" --dry-run              # optional: print the decoded Sepolia inputs, offline
$S/deploy.sh --dir $D --repo "$PWD"                        # DeployFinal + VerifyFinal on chain 20200
SEPOLIA_RPC_URL_CAPTURE=<url> pnpm --filter @hogee/redteam fisco:sepolia-code -- --out <dir>   # Sepolia code capture
HOGEE_ENV_FILE=<path> $S/replay.sh --dir $D --repo "$PWD" --sepolia-code <dir>
make verify-fisco PACK=evidence/fisco/fm-<16hex>
```

- `chain-up.sh` first makes (or reuses) the regulator keystore and writes `D/facts/regulator.address`. It builds with
  `-l 127.0.0.1:5 -p 30300,20200 -a <regulator>`. It refuses if:
  - `D/nodes` already exists;
  - any of the ports 30300–30304, 20200–20204, 8545 or 8546 is in use;
  - `~/.fisco` exists.

  After the build it checks that no symlink appeared, fixes the CA certificate, copies the sdk TLS files to `D/facts/sdk`
  (`ca.crt` and `sdk.crt` mode 444, `sdk.key` 400), rewrites the configs and then:
  1. appends `[features]` to every genesis file and removes node4 from the sealer list;
  2. checks that all genesis files are byte-identical, and keeps a read-only copy in `D/facts/config.genesis`;
  3. checks the binary's digest again and makes `D/bin` read-only;
  4. starts each node from its own folder (never the generated `start.sh`) and records its pid and start command in `D/run`;
  5. waits for `eth_chainId`;
  6. checks `isGovernor(regulator)`, then has the regulator send the observer proposal for node4 (see "The
     regulator"), and writes `D/observer.block` and `D/facts/observer.proposal`.
- `chain-check.sh` with five nodes also checks that node4's log reports `type=OBSERVER_NODE`, that node4 has committed the head block, and that node4's Web3 on 8546 serves the head with node0's hash. There are no empty blocks, so right after the observer proposal it reports "not yet synced" (a NOTE) until the next block arrives.
- `replay.sh` passes `--native-tls D/facts/sdk --ledger-rpc http://127.0.0.1:8546` to the replay, besides the five keys on file descriptor 3.
- `deploy.sh` writes these files to `D/deploy/`:
  - `fisco-final-2.json`, the manifest DeployFinal prints;
  - `run-<ts>.json`, the forge broadcast;
  - `deploy-info.json`, with the deployer, the governance module, the Sepolia source file and its digest, and the constructor inputs;
  - the forge logs.

  It refuses a second deployment on the same chain. It needs no change for auth mode: deploying is open on this
  chain (the team lead's live test: VerifyFinal passes), and the deployer is each contract's default admin until the replay's
  governance step makes the regulator Treasury's admin.

## How to stop and wipe

```sh
scripts/fisco/chain-down.sh --dir ~/fisco-hogee           # TERM by pid file, KILL after 30 s; fisco-bcos only
scripts/fisco/chain-down.sh --dir ~/fisco-hogee --wipe    # then rm -rf the whole chain folder
```

`--wipe` removes everything in D, including keys (the regulator's too: the next chain gets a new regulator), nodes, deploy files, `facts/` and `bin/`, and any download kept there, so keep `dl/` elsewhere if you want to rebuild. It runs only when `D/.hogee-fisco` names D. A new run needs a wipe first: `chain-up.sh` refuses an existing `D/nodes`, and the replay's ledger check expects a chain on which the regulator has sent nothing but the observer proposal. `chain-down.sh` also removes `/private/tmp/secp256k1.param`, which `build_chain.sh` writes, and fails if `~/.fisco` exists.
