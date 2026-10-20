# Needs validation — hogee run-11

Run-11 audited 7db6058 (int-ux after the FISCO BCOS mirror merges), scoped to 3420445..7db6058 minus the generated pack. Profile `quick`, scoped, source-only: no target code was executed.
These are prioritized leads, not confirmed vulnerabilities, and carry no severity. Each section is copied from the final record in
`findings.json`. Owner checks ask you to observe your own components only; none involves sending traffic to a deployment.

## 1. Unsandboxed FISCO scripts write through link entries inside the node-writable chain dir, so sandboxed node code could redirect their writes outside D

- **Fingerprint:** `scripts/fisco/D-contents-link-followed-by-unsandboxed-writers`
- **Verifier:** `v-1` (independent, source-only)

### Claimed root cause

Chain-dir trust is established once for D's own path. D's contents stay writable by lower-trust sandboxed code (node.sb, and build.sb during the build, allow file-write* on all of D). The trusted scripts later open those contents with link-following, non-exclusive operations: > redirection, cp, chmod, and mkdir -p accepting existing entries. They never check that an entry is a regular, non-link file inside D.

### Description

chain-up.sh starts every fisco-bcos node under node.sb. node.sb grants file-read* and file-write* on the whole chain dir D, not only the node folders. node.sb and build.sb are the only containment for the pinned but unauditable binary. The binary is a lower-trust principal: it could be malicious, or compromised through its unauthenticated loopback RPC or P2P ports. While the nodes run, the unsandboxed operator scripts write fixed paths inside D using bash redirection, cp and chmod, all of which follow symbolic links. deploy.sh writes D/deploy/forge-deploy.log, fisco-final-2.json.tmp, the copied forge run file, forge-verify.log and deploy-info.json. Its mkdir -p accepts an already existing D/deploy, including one that is a link to a directory. chain-up.sh writes D/observer.block after the nodes are up. ensure_keys_dir tests D/keys/pw with -f, which follows links, then runs chmod 600 on it. That changes the mode of an existing link target, or writes a new file at a dangling link's target. The only path checks bind D itself: resolve_chain_dir checks that D is not a link, and require_marker checks that the marker equals D. No check covers the entries inside D. If the sandbox lets a sandboxed process create a link entry inside D whose target is outside D, the next unsandboxed write runs with the operator's privileges and lands outside D. The effect is truncation and overwrite of, or a mode change on, an operator-owned file. The protected set includes the operator's files outside D, among them the env file holding the four real role keys. Some of the overwrite text comes from the node: forge-deploy.log captures forge output, which reflects RPC answers. This would break the stated containment ('may only read and write the chain folder') and the unit invariant that links cannot redirect script writes. chain-check.sh --selftest only tests a direct write outside D from inside the sandbox. It does not test a write redirected through a link.

### Source trace

1. **entrypoint** `scripts/fisco/chain-up.sh:149` — `node start loop`: The lower-trust fisco-bcos binary is started under node.sb with CHAIN_DIR=D. The nodes keep running through the later deploy.sh and replay.sh steps.
2. **propagation** `scripts/fisco/node.sb:17` — `node.sb profile`: (allow file-read* file-write* (subpath chain)): the sandboxed node may create, replace and remove any entry anywhere under D, including deploy/, keys/ and observer.block.
3. **propagation** `scripts/fisco/lib.sh:82` — `resolve_chain_dir`: The only link check covers D itself. require_marker (lib.sh:131-136) compares only the marker content. No check covers the entries inside D.
4. **propagation** `scripts/fisco/deploy.sh:128` — `deploy.sh chain gate`: deploy.sh requires chain-check.sh to pass, and chain-check.sh needs live node pids, so every deploy.sh write happens while the sandboxed nodes run.
5. **propagation** `scripts/fisco/deploy.sh:144` — `deploy.sh output dir`: mkdir -p -m 700 accepts an existing D/deploy, including a link to a directory (the mode applies only to a new directory). Nothing checks the entries inside it.
6. **sink** `scripts/fisco/deploy.sh:161` — `forge script DeployFinal`: Unsandboxed truncating redirect to D/deploy/forge-deploy.log, which follows a link entry. The content is forge output, which reflects RPC answers served by the node.

### Evidence

- `scripts/fisco/node.sb:17`: (allow file-read* file-write* (subpath chain)): the node's write scope is all of D, not only nodes/127.0.0.1/nodeN.
- `scripts/fisco/lib.sh:131`: require_marker checks only refuse_unsafe_dir, the marker's existence and its content, never the entries in D.
- `scripts/fisco/deploy.sh:164`: Same pattern: an unsandboxed redirect into D/deploy/fisco-final-2.json.tmp.
- `scripts/fisco/deploy.sh:185`: Same pattern: cp of the forge run file into D/deploy/, which writes through an existing destination link or a linked D/deploy.
- `scripts/fisco/deploy.sh:201`: Same pattern: an unsandboxed redirect into D/deploy/forge-verify.log.
- `scripts/fisco/deploy.sh:213`: Same pattern: an unsandboxed redirect into D/deploy/deploy-info.json.
- `scripts/fisco/chain-up.sh:177`: An unsandboxed redirect into D/observer.block, made after the nodes were started at line 149.
- `scripts/fisco/lib.sh:214`: The [ ! -f "$d/keys/pw" ] test follows links. Line 215 writes through a dangling link, and line 217 runs chmod 600 through any link. ensure_keys_dir runs while the nodes are up (chain-up.sh:169, deploy.sh:141).
- `scripts/fisco/chain-check.sh:74`: selftest_files proves only that a direct touch outside D is denied inside the sandbox. It does not cover writes by the unsandboxed scripts redirected through links inside D.
- `docs/fisco/README.md:57`: Stated safety model: the node 'may only: read and write the chain folder'.

### Blockers

- No target-controlled or sandboxed execution is permitted in this run. So it cannot be observed whether node.sb (deny default, file-write* on subpath D) lets a sandboxed process create a symbolic link entry inside D whose target lies outside D, on the macOS version P1 uses. Macro-level Seatbelt behaviour for link creation, as opposed to the link's target, is a runtime OS fact. The source alone does not settle it, and it decides whether the redirect is reachable.

### Bounded local validation

Bounded fixture with dummy files only, no fisco-bcos binary and no real chain dir. In the agent scratch folder, create scratch/D (mode 700, containing deploy/ and keys/) and scratch/outside/target.txt with known dummy content and mode 644. Copy node.sb to scratch/test.sb and add only (allow process-exec file-read* file-map-executable (literal "/bin/ln")). Under /usr/bin/sandbox-exec with -D CHAIN_DIR=<scratch>/D -D BIN=/bin/ln -f scratch/test.sb, try to create scratch/D/deploy/forge-deploy.log as a symbolic link to scratch/outside/target.txt, and record whether the sandbox allows it. If it does, run one harmless unsandboxed redirect into that link path, as deploy.sh:161 does, and compare the dummy target's content. Repeat with a link at scratch/D/keys/pw and a chmod 600 on that path, as lib.sh:217 does, and compare the dummy target's mode. Remove the fixture afterwards. Regression case after a fix: the scripts refuse any pre-existing link or non-regular entry on their write paths in D, or create their outputs exclusively in a directory the nodes cannot write. With the same fixture, the dummy target's content and mode stay unchanged.

### Owner-observed deployment check

P1 runs the local fixture above on the Mac that runs the mirror (same macOS version as the 20 Oct smoke test), with dummy files only and with no chain running. Before each deploy.sh or chain-up.sh run on the real chain dir, P1 also lists unexpected links in D, excluding the tassl stub chain-up.sh creates on purpose: find <D> -type l -not -path '<D>/home/.fisco/tassl-1.1.1b'. Any other link is reported before the script runs.

## 2. The FINAL role keys stay in the launch-time environment of pnpm and node, where a same-uid fisco-bcos running under node.sb may read them through kern.procargs2 and copy them into the published pack

- **Fingerprint:** `scripts/fisco/replay.sh:role-keys-in-launch-env:readable-by-sandboxed-node-via-procargs`
- **Verifier:** `v-2` (independent, source-only)

### Claimed root cause

The keys are delivered as environment variables (replay.sh:102-103) and scrubbed only from process.env (keys.ts:94). They therefore remain in the launch-time exec string area of the long-lived pnpm process and of node for the whole replay. The lower-trust fisco-bcos nodes run at the same time as the same uid (chain-up.sh:148-150) under node.sb, which grants unfiltered sysctl-read directly (node.sb:20) and through its bsd.sb import (node.sb:10). No source-visible rule stops a kern.procargs2 read. Node-chosen free text reaches the published pack (capture.ts:95, runner.ts:68, runner.ts:152), and the literal secret scan (safety.ts:159, sign.ts:78) misses any re-encoded copy.

### Description

replay.sh reads the four real FINAL role keys (Sepolia testnet keys), exports them in the replay subshell and runs exec pnpm ... fisco:replay. The keys therefore become part of the exec-time environment block of the pnpm process, which stays alive for the whole replay, and of the node process that pnpm starts. cli.ts calls loadSigners(..., {scrub: true}), whose finally block deletes the names from process.env only. That is a libc environ edit. The macOS kern.procargs2 sysctl returns the original exec strings, and ps(1) on the audit host (macOS 27.0.1) says that -E 'does not reflect changes in the environment after process launch'. pnpm never scrubs at all. The architecture treats the pinned, unauditable fisco-bcos binary as lower-trust and relies on node.sb to contain it. chain-up.sh starts all five nodes as the operator's own uid (env -i, nohup, sandbox-exec, no dedicated user). replay.sh:67 runs chain-check.sh, which fails unless every node pid is alive, so the nodes always run concurrently with the replay. node.sb is deny-default, but it grants sysctl-read without a name filter. It does so twice: directly at node.sb:20, and through (import "bsd.sb") at node.sb:10, since bsd.sb imports system.sb, which on the audit host contains an unconditional (allow sysctl-read) at /System/Library/Sandbox/Profiles/system.sb:191. As calibration, Apple's own container.sb allows kern.proc.pid.* only to Apple-signed executables. No source-visible rule therefore stops a sandboxed node from asking for kern.procargs2 of a same-uid process. Whether XNU and the Sandbox kext return the environment to such a caller is the runtime fact this record cannot settle. If they do, the node has exits that the existing controls miss. (a) Node-chosen free text is copied into the pack P1 publishes. web3_clientVersion (up to 200 chars) goes into chain.json; capture.ts:95 requests it at cli.ts:100, after the scrub, while pnpm and node are alive. JSON-RPC error text (up to 500 chars per step) goes into steps.json as probe.error and as outcome.rpcError.message. The checker accepts that text: refusals.ts:115 compares probe.error only when it is a Hogee error name. The writer's scan is a literal, case-sensitive includes over k, bare, bare upper-case and base64 of each key, so any re-encoding passes. Four base64 keys take 176 chars. (b) The redirect-following fetch transport covered by candidate scripts/redteam/src/fisco/rpc.ts:httpTransport:redirect-follow-bypasses-loopback-guard. Either exit breaks the unit's boundary that the keys never reach child processes beyond the replay, the pack or non-loopback hosts. A malicious pinned binary is the architecture's lower-trust assumption, not a validation blocker. One correction to the hunter's plan: narrowing node.sb:20 alone would not remove the grant, because the bsd.sb/system.sb import still allows sysctl-read. A fix needs an explicit later deny or must stop delivering the keys through the environment.

### Source trace

1. **entrypoint** `scripts/fisco/chain-up.sh:149` — `node start loop`: The lower-trust fisco-bcos binary is started under sandbox-exec with node.sb as the operator's own uid (no dedicated user) and keeps running through the replay
2. **propagation** `scripts/fisco/node.sb:20` — `node.sb`: (allow sysctl-read) without a sysctl-name filter. The profile also imports bsd.sb (line 10), whose system.sb grants unfiltered sysctl-read as well, so no rule denies a kern.procargs2 request from the node
3. **propagation** `scripts/fisco/replay.sh:86` — `read_role_keys`: printf -v loads each FINAL key from HOGEE_ENV_FILE into an unexported shell variable
4. **propagation** `scripts/fisco/replay.sh:102` — `replay subshell`: export $KEY_NAMES after scrub_env: the four keys become environment variables
5. **propagation** `scripts/fisco/replay.sh:103` — `replay subshell`: exec pnpm: the keys are in the exec-time environment block of the pnpm process, which lives for the whole replay
6. **propagation** `scripts/redteam/package.json:15` — `fisco:replay script`: pnpm launches node --import tsx src/fisco/cli.ts with that environment, so the keys are also in node's launch-time block
7. **propagation** `scripts/redteam/src/fisco/cli.ts:86` — `replay()`: loadSigners(env, 'FINAL', {scrub: true}) is the only scrub
8. **propagation** `apps/worker/src/config/keys.ts:94` — `loadSigners finally`: delete env[name] edits process.env only; the launch-time strings that kern.procargs2 returns are untouched
9. **propagation** `scripts/redteam/src/fisco/capture.ts:95` — `chainFile`: Node-chosen web3_clientVersion, clipped to 200 chars, goes into chain.json. It is requested at cli.ts:100, after the scrub, while pnpm and node are alive
10. **propagation** `scripts/redteam/src/fisco/runner.ts:68` — `probeErrorOf`: [second path] Node-chosen JSON-RPC error text (up to 500 chars) goes into steps.json probe.error; runner.ts:152 also copies it into outcome.rpcError.message
11. **propagation** `scripts/redteam/src/safety.ts:159` — `scanForSecrets`: The pack scan is a literal, case-sensitive text.includes over k, bare, upper-case bare and base64 of each key, so any re-encoding passes
12. **sink** `scripts/redteam/src/fisco/writer.ts:84` — `writePack`: renameSync turns the scanned temp folder into the final evidence/fisco/fm-<16hex> pack that P1 publishes, with the node-chosen text inside

### Evidence

- `scripts/fisco/replay.sh:3`: Design claim: the keys are passed to the replay 'in its environment only'
- `apps/worker/src/config/keys.ts:7`: Design claim: after the scrub 'a later env dump or child process cannot see them'. This holds for process.env, not for the launch-time block
- `scripts/redteam/src/fisco/cli.ts:8`: Design claim: the keys are 'scrubbed from the env; nothing prints or writes them'
- `scripts/fisco/chain-up.sh:148`: Nodes start with env -i and nohup and no uid change, so they run as the invoking (non-root) user
- `scripts/fisco/replay.sh:67`: The replay runs only after chain-check.sh passes
- `scripts/fisco/chain-check.sh:125`: chain-check fails unless every node pid is alive, so the nodes run concurrently with the replay
- `scripts/fisco/node.sb:9`: deny default: sysctl-read is an explicit grant, not an omission
- `scripts/fisco/node.sb:10`: (import "bsd.sb"): on the audit host bsd.sb imports system.sb, which has an unconditional (allow sysctl-read), so removing line 20 alone does not narrow the grant
- `scripts/redteam/src/fisco/cli.ts:100`: chainFile (web3_clientVersion) runs after the scrub, while pnpm and node still hold the launch-time env
- `scripts/redteam/src/fisco/rpc.ts:74`: The node's JSON-RPC error message is only sliced to 500 chars, never filtered
- `scripts/redteam/src/fisco/runner.ts:152`: A refused send keeps the node's error message in outcome.rpcError.message
- `scripts/redteam/src/fisco/sign.ts:78`: The secret forms are only k, bare, bare upper-case and base64 of each key separately
- `tools/verify-evidence/src/fisco/pack.ts:115`: clientVersion is free text of up to 200 chars in the published chain.json
- `tools/verify-evidence/src/fisco/pack.ts:205`: probe.error is free text of up to 500 chars per step
- `tools/verify-evidence/src/fisco/refusals.ts:115`: The checker compares probe.error only when it is a Hogee error name, so arbitrary node text still verifies
- `scripts/fisco/chain-check.sh:145`: Only sandbox denials are inspected; an allowed sysctl read leaves no trace
- `scripts/redteam/src/fisco/rpc.ts:60`: fetch with the default redirect mode: exit (b), covered by candidate scripts/redteam/src/fisco/rpc.ts:httpTransport:redirect-follow-bypasses-loopback-guard

### Blockers

- Not observable from source: whether a process under scripts/fisco/node.sb gets the environment portion of kern.procargs2 for another unsandboxed process of the same uid. The profile is deny default and grants unfiltered sysctl-read through node.sb:20 and the bsd.sb/system.sb import. The answer depends on XNU's sysctl_procargsx policy for non-root callers on P1's macOS release, and on whether the Sandbox kext mediates that MIB only through sysctl-read or also through process-info*. sandbox-exec execution is not permitted in this run.
- Not observed: that pnpm 12.11.2 (the pinned packageManager) and the replay's node keep the key strings in their launch-time exec string area for the whole replay after delete process.env[...]. ps(1) on macOS 27.0.1 documents that -E does not reflect later environment changes, but no process was run.

### Bounded local validation

Dummy values only, no network, scratch dir S (mode 700, outside the repo), 60 s wall clock per step. (1) Generate DUMMY=0x<64 random hex>. Start /usr/bin/env -i HOME=$S PATH=<node dir>:/usr/bin:/bin DUMMY_ROLE_KEY_FINAL=$DUMMY node -e 'delete process.env.DUMMY_ROLE_KEY_FINAL; setTimeout(()=>{},60000)' in the background. Also start the same command as the only script of a scratch package.json via pnpm run (npm_config_update_notifier=false) to mirror the pnpm wrapper. Record the pnpm pid and both node pids. (2) As the same user, run ps -E -p <pid> for each pid and note whether DUMMY_ROLE_KEY_FINAL is still listed. (3) Compile a small C probe to $S/bin/probe that calls sysctl({CTL_KERN, KERN_PROCARGS2, pid}) for a pid given in argv and prints only 'found' or 'not found' for the dummy value, never the buffer. Run /usr/bin/sandbox-exec -D CHAIN_DIR=$S -D BIN=$S/bin/probe -f scripts/fisco/node.sb $S/bin/probe <pid> for each pid, the same pattern chain-check.sh --selftest uses. Then read the Sandbox log for denials. 'found' for any pid confirms the candidate on that release; EINVAL, EPERM or 'not found' refutes it there. Kill all holders afterwards. Regression for a fix: replay.sh hands the keys to node on an inherited pipe fd (not env, not through pnpm), and node.sb adds an explicit (deny sysctl-read (sysctl-name "kern.procargs" "kern.procargs2")) after the bsd.sb import; dropping node.sb:20 alone is not enough. A chain-check --selftest case runs the probe and requires 'not found'.

### Owner-observed deployment check

Owner observation on P1's Mac, never with the real keys. Record sw_vers. During a normal replay, record only ps -o uid=,pid=,comm= for the five node pids, the pnpm pid and the node pid (no -E) to confirm that they share one uid. Then run the dummy-value local probe above on that same macOS release. Never point ps -E or the probe at a real replay process.

## 3. The FISCO replay's RPC transport follows HTTP redirects, so its loopback guard does not control where requests and signed transactions are sent

- **Fingerprint:** `scripts/redteam/src/fisco/rpc.ts:httpTransport:redirect-follow-bypasses-loopback-guard`
- **Verifier:** `v-3` (independent, source-only)

### Claimed root cause

httpTransport (scripts/redteam/src/fisco/rpc.ts:60-65) calls fetch without a redirect option, so redirects are followed across origins. FiscoRpc's guards check the configured URL string (rpc.ts:44, at construction on line 131 and again before each send on line 143) and the responder's own eth_chainId answer (rpc.ts:144). They never check where the request was finally sent: res.redirected and res.url are not inspected, and only res.ok is checked (rpc.ts:69). The bash sibling (scripts/fisco/lib.sh:177) uses curl without -L and does not follow redirects.

### Description

FiscoRpc checks two things before every send: the configured URL string must be http(s) on 127.0.0.1 or localhost, and eth_chainId must answer 20200. httpTransport calls fetch with no redirect option, so the default 'follow' mode applies. Under that mode Node's global fetch (undici, Node 24 per .nvmrc) follows up to 20 3xx hops across origins. On 307/308 it re-sends the POST method and body. On 301/302/303 it switches to a GET of the Location URL. The response that ends the chain comes back as if the loopback node had answered, because only res.ok is checked. The service on 127.0.0.1:8545 is node0's Web3 RPC. It runs the downloaded fisco-bcos binary, which is pinned by digest but cannot be audited, and the architecture treats that binary as a lower-trust principal. That responder can answer eth_chainId with 0x4ee8 and answer eth_sendRawTransaction, or any other call, with a 307 and a Location pointing at any host, with data it chooses encoded in the URL. The replay process runs unsandboxed: replay.sh execs pnpm directly, with no sandbox-exec. It would then POST the body, a raw transaction signed with a real role key, to that host. This gives the sandboxed binary an outbound HTTP(S) channel that node.sb's loopback-only network rules do not apply to, and chain-check.sh would not see it, because it watches only fisco-bcos pids and fisco-bcos sandbox denials. The data that can leave this way is anything node0 can read in D (the throwaway deployer and observer keystores and pw file, node TLS keys, chain data), plus the requests it is sent. Impact of this candidate alone is limited. The leaked transactions are EIP-155 chain 20200 at gas price 0, and every sent raw transaction is already written into the published pack as rawSignedTx. Real-key EIP-712 signatures use the fisco salt. What this candidate breaks is the stated containment of downloaded code ('the host network: downloaded code must stay loopback-only') and the unit invariant that no signed transaction reaches a non-loopback host. It becomes an exfiltration channel for the real role keys only if node0 can obtain them, which is the separate candidate scripts/fisco/replay.sh:role-keys-in-launch-env:readable-by-sandboxed-node-via-procargs. A second path has the same root cause: fisco:sepolia-code builds a plain Rpc on the same httpTransport against an operator-supplied remote Sepolia provider, which is also a lower-trust principal. That provider can send the operator's machine blind SSRF requests to loopback or LAN URLs: a GET after 301/302/303, or the fixed read-only JSON-RPC POST after 307/308. No key is involved, and the final answer is still checked for chainId 11155111 and for code.

### Source trace

1. **entrypoint** `scripts/fisco/chain-up.sh:150` — `chain-up.sh node start loop`: Each node runs the downloaded, digest-pinned but unauditable fisco-bcos binary under node.sb. Web3 is enabled on node0 only (line 135), so node0 is the lower-trust responder on 127.0.0.1:8545 that answers every replay request. Nothing on the client side stops it from answering with a 3xx and any Location it chooses.
2. **propagation** `scripts/fisco/replay.sh:103` — `replay.sh subshell`: exec pnpm fisco:replay runs directly, not under sandbox-exec, with --rpc $FISCO_RPC (http://127.0.0.1:8545, lib.sh:11) and the four *_PRIVATE_KEY_FINAL keys exported in its environment
3. **propagation** `scripts/redteam/src/fisco/cli.ts:83` — `replay()`: new FiscoRpc(a.rpc): one transport serves every read and every send
4. **propagation** `scripts/redteam/src/fisco/rpc.ts:131` — `FiscoRpc constructor`: assertLoopbackUrl checks only the URL string; then httpTransport(url) is installed as the only transport (line 132)
5. **propagation** `scripts/redteam/src/fisco/runner.ts:171` — `StepRunner.run`: signLegacy signs the catalogue step with the real FINAL key of the catalogue role (chain 20200, gas price 0)
6. **propagation** `scripts/redteam/src/fisco/runner.ts:146` — `StepRunner.send`: The raw signed transaction is passed to rpc.sendRawTransaction
7. **propagation** `scripts/redteam/src/fisco/rpc.ts:143` — `FiscoRpc.sendRawTransaction`: Re-checks the same immutable URL string, then eth_chainId (line 144), which the same responder answers, then sends request('eth_sendRawTransaction', [raw]) (line 145)
8. **propagation** `scripts/redteam/src/fisco/sepolia-code.ts:79` — `sepoliaCodeMain`: [second path] fisco:sepolia-code builds a plain Rpc on the same httpTransport against an operator-supplied remote Sepolia provider, whose 3xx answers are followed the same way: blind SSRF to loopback or LAN, as a GET after 301/302/303 or as the fixed read-only JSON-RPC POST after 307/308
9. **sink** `scripts/redteam/src/fisco/rpc.ts:60` — `httpTransport`: fetch(url, {method: 'POST', headers, body, signal}) has no redirect option. Under the default 'follow' mode, the unsandboxed replay process re-sends the POST method and body to the Location host on 307/308, or GETs the Location URL on 301/302/303, for up to 20 hops. The final response is returned as if node0 had answered.

### Evidence

- `scripts/redteam/src/fisco/rpc.ts:44`: The loopback decision uses only the parsed configured URL: protocol, hostname in {127.0.0.1, localhost}, and no userinfo
- `scripts/redteam/src/fisco/rpc.ts:69`: After fetch only res.ok is checked; res.redirected and res.url are never inspected, and no fetch option sets redirect to 'error' or 'manual'
- `scripts/fisco/lib.sh:177`: The bash rpc() helper uses curl --noproxy '*' without -L, so the shell scripts do not follow redirects; the TypeScript transport is the outlier
- `scripts/fisco/node.sb:21`: The node may accept connections on loopback only, and lines 22-23 let it connect out only to the five loopback p2p ports. A followed redirect makes the outbound connection from the replay process, which this profile does not cover.
- `scripts/fisco/chain-check.sh:130`: lsof is run only for fisco-bcos pids, and the sandbox-log check (lines 145-146) greps only fisco-bcos denials, so outbound connections made by the replay's node process are not observed
- `scripts/redteam/test/fisco/rpc.test.ts:5`: The rpc tests use a table-driven fake Transport only; httpTransport and redirect handling have no tests
- `scripts/redteam/src/fisco/sign.ts:30`: Signed transactions bind chainId 20200 at gas price 0, so a leaked transaction carries no Sepolia authority
- `scripts/redteam/src/fisco/runner.ts:177`: Every sent raw transaction is written into the pack as rawSignedTx, so the transaction bytes are public by design. What matters about the leak is the outbound channel outside the sandbox, not the transaction itself.
- `.nvmrc:1`: The runtime is Node 24, whose global fetch is undici; scripts/redteam/package.json runs fisco:replay and fisco:sepolia-code with node --import tsx and installs no fetch wrapper or dispatcher

### Blockers

- No target-controlled execution is allowed in this run. It was therefore not observed that Node 24's global fetch (undici, run through node --import tsx) follows a cross-origin 307/308 answer to the eth_sendRawTransaction POST and re-sends the JSON body, or follows a 301/302/303 as a GET in the sepolia-code path. The WHATWG fetch default ('follow') predicts both, but there is no observed result.

### Bounded local validation

Run in the approved sandbox: loopback only, no external network, empty environment, dummy data only. Use Node 24 and the repo's tsx. Start fixture A on 127.0.0.1:P1. For a POST whose JSON method is eth_chainId it answers 200 {"jsonrpc":"2.0","id":<id>,"result":"0x4ee8"}. Every other POST gets '307' with 'Location: http://127.0.0.1:P2/leak?d=probe'. A different port makes the redirect cross-origin; 127.0.0.2 is not configured on macOS lo0 by default. Start recorder R on 127.0.0.1:P2. It logs the method, path, query and body and answers 200 {"jsonrpc":"2.0","id":1,"result":"0x" + 'ab' repeated 32 times}. Run await new FiscoRpc('http://127.0.0.1:P1').sendRawTransaction('0x01'). The trace is confirmed if R logs 'POST /leak?d=probe' with a body containing eth_sendRawTransaction and 0x01, and the call resolves to R's result. Repeat with A answering 302: R should log a GET with no body. For the second path, have fixture C on 127.0.0.1:P3 answer every POST with '302 Location: http://127.0.0.1:P2/ssrf', run sepoliaCodeMain(['--rpc','http://127.0.0.1:P3','--out',<scratch dir>]), and expect R to log 'GET /ssrf'. Regression check: add redirect: 'error' to the fetch options in httpTransport, or reject any res.redirected or 3xx. Each call must then reject ('the RPC request failed' or 'answered HTTP 3xx'), and R must log nothing.

## 4. A FISCO pack chooses, and can skip, the only pin of the final-2 deploy broadcast, so other constructor inputs or creation code reach VERIFIED

- **Fingerprint:** `tools/verify-evidence/src/fisco:source-broadcast-pin-pack-steered`
- **Verifier:** `v-4` (independent, source-only)

### Claimed root cause

The pack itself is the trust root for final-2's deploy broadcast. FINAL_2 pins only runId, chainId, chainTag and deploymentId. deploy.ts checks the broadcast against a keccak the pack records. cli.ts broadcastOnDisk checks it against a repo file at a path the pack chooses, and silently skips the check when that path does not exist. No other check binds the constructor values (lender, oracle, observer, cooling, loosen, judging, payees) or the source creation code to anything outside the pack.

### Description

When the FISCO checker prints VERIFIED (cli.ts FISCO_MEANING), it says the pack matches the pinned Sepolia bundle: 'the same code (immutables explained), constructor inputs, signed plan and calls ran on the local FISCO BCOS chain'. For final-2's constructor inputs, the checker's only source is the pack's own sepolia-broadcast.json. Without --artifacts, the same holds for the creation code. deploy.ts:89 compares that file's keccak only with deployment.json's broadcastKeccak, which the same pack supplies. The Sepolia bundle binds only the four source addresses (deploy.ts:105); its contracts.json holds addresses only. The plan check binds only roles.agent to the manifest's agent (plan.ts:94). Parity compares calldata, not senders. Refusals do not read the deploy params. So nothing outside the pack binds lender, oracle, observer, coolingSeconds, loosenTimelockSeconds, judgingWindowEnd or the platform payee ids and payout hashes. The code-sepolia runtime files are also supplied by the pack.

The one external anchor is the CLI's repo-copy comparison (broadcastOnDisk), and it reads its path from the pack's deployment.json sepolia.broadcastFile. Both the schema (pack.ts:175) and the CLI regex accept any chain directory and any run number. When that path does not exist, broadcastOnDisk returns null (cli.ts:62). main then adds no line (cli.ts:126), so the verdict rests on the 13 library checks alone. The replay writer always records run-1792385076465.json (scripts/redteam/src/fisco/deployment.ts:14), and that file is tracked in every clone. The checker never requires that path, though. The library entry verifyFiscoPack, which is also the browser entry, does no comparison at all. FINAL_2 pins no broadcast path or digest.

Attack: the author needs the final-2 agent key. roles.agent must equal the manifest agent, and every agent-sent step must recover to it (view.ts:108 and view.ts:173). That means P1, or anyone the key leaks to. The author builds a pack as follows:
- sepolia-broadcast.json keeps the real final-2 source addresses and the TreasuryGovernance entry but carries other constructor values, such as another lender, oracle or observer address or another judgingWindowEnd. When the judge has no contracts/out, it can also carry other creation code. An author without the real lender and oracle keys has to change those two addresses anyway.
- The FISCO side is replayed on the author's own local FISCO chain, whose headers the checker takes as served. Deploys come from a throwaway deployer. Lender, oracle and relayer steps use keys the author picks. Passkey steps use a mirror founder key that the author registers in S2.
- deployment.json roles and params, artifacts.json, code/ and code-sepolia/ are made consistent with these values.
- broadcastKeccak and hashes.json are recomputed. packId covers only pack.json, so it does not change.
- sepolia.broadcastFile names a missing run file, e.g. contracts/broadcast/DeployFinal.s.sol/11155111/run-1.json.

Source review finds none of the 13 checks that would fail. make verify-fisco would then print VERIFIED with 13 lines and no 'source broadcast (repo copy)' line, while the constructor values, and possibly the code, differ from the tracked final-2 broadcast. The constructor-value variant works even with contracts/out: --artifacts pins artifacts.json, not the arguments. The repo's own fixture names a missing run-1.json (fixture-steps.ts:176), and its CLI test expects exit 0 (cli.test.ts:58). So the skip path already yields VERIFIED in tests, under a synthetic source identity. Nothing was built or executed in this run.

Fix: add broadcastFile and broadcastKeccak to SourceIdentity and FINAL_2. For run-1792385076465.json, the keccak is 0xd729b12a...f0f52a, as the published pack records. In sourceInputs, require deployment.json's sepolia.broadcastFile and broadcastKeccak to equal them, so the library and browser entry are pinned too. In the CLI, compare against the pinned path rather than the pack's, and report a failing line when the tracked copy is absent or differs. Regression tests: a pack whose broadcastFile names a missing run file must be NOT VERIFIED. So must a pack whose broadcast carries constructor values changed consistently everywhere.

### Source trace

1. **entrypoint** `tools/verify-evidence/src/fisco/cli.ts:120` — `main`: The CLI reads the untrusted pack directory and the Sepolia bundle, then calls verifyFiscoPack (line 123).
2. **propagation** `tools/verify-evidence/src/fisco/pack.ts:175` — `DeploymentFile.sepolia.broadcastFile`: The schema accepts any contracts/broadcast/DeployFinal.s.sol/<digits>/run-<digits>.json path, including one that does not exist.
3. **propagation** `tools/verify-evidence/src/fisco/cli.ts:62` — `broadcastOnDisk`: If the path taken from the pack's deployment.json does not exist, the function returns null and the repo-copy comparison is skipped.
4. **propagation** `tools/verify-evidence/src/fisco/cli.ts:126` — `main`: A null result adds no check line. The verdict at line 130 needs only result.ok and the remaining extra lines.
5. **propagation** `tools/verify-evidence/src/fisco/deploy.ts:89` — `sourceInputs`: The broadcast's keccak is compared only with deployment.json's broadcastKeccak, which the same pack supplies.
6. **propagation** `tools/verify-evidence/src/fisco/deploy.ts:131` — `checkDeploy`: The source facts (lender, oracle, observer, cooling, loosen, judging) come from the decoded constructor args in the pack's broadcast.
7. **propagation** `tools/verify-evidence/src/fisco/deploy.ts:138` — `checkDeploy`: FISCO constructor args are accepted when they equal those pack-derived source facts, with only the chain tag and links swapped.
8. **sink** `tools/verify-evidence/src/fisco/cli.ts:84` — `report`: The CLI prints 'VERIFIED: every check passed' together with the claim of the same code and constructor inputs as final-2.

### Evidence

- `tools/verify-evidence/src/fisco/pack.ts:30`: FINAL_2 SourceIdentity holds no broadcast path or digest, so the library and browser entry never pin the broadcast.
- `tools/verify-evidence/src/fisco/cli.ts:62`: 'if (!path.startsWith(...) || !existsSync(path)) return null;' runs on a path read from the pack's deployment.json (line 59).
- `tools/verify-evidence/src/fisco/deploy.ts:105`: The bundle binds only the source contract addresses. The broadcast's input bytes are never compared with any value from outside the pack.
- `evidence/ev-74756ea61a72ae7c/contracts.json:10`: The source bundle's contracts.json lists addresses only, with no deploy tx, code hash or role address.
- `tools/verify-evidence/src/fisco/plan.ts:94`: roles.agent is the only role tied to the source (the manifest agent). lender, oracle, relayer, observer and deployer are chosen by the pack.
- `tools/verify-evidence/src/fisco/view.ts:108`: Each step tx must recover to deployment.json's address for its role. Forging agent steps therefore needs the real agent key, while the other roles accept the author's own keys.
- `scripts/redteam/src/fisco/deployment.ts:14`: The replay writer always records run-1792385076465.json, but the checker never requires that path.
- `evidence/fisco/fm-6861d1d5e991f1f2/deployment.json:73`: The published pack names the tracked final-2 broadcast and its keccak 0xd729b12a...f0f52a, the values a fix should pin.
- `docs/decisions/fisco-check.md:11`: The design intends the CLI to compare the pack's broadcast with the repo's tracked file. The pack's choice of path defeats this.
- `tools/verify-evidence/test/fisco/fixture-steps.ts:176`: The test fixture's broadcastFile is a nonexistent run-1.json path.
- `tools/verify-evidence/test/fisco/cli.test.ts:58`: The CLI test expects exit 0 for that fixture, so the skip path yields VERIFIED (under the synthetic source identity).
- `Makefile:62`: make verify-fisco passes --artifacts only when the untracked contracts/out exists. A judge's default run therefore also takes the creation bytecode from the pack.

### Blockers

- This run forbids target-controlled execution, and the worktree has no node_modules (viem, zod, @hogee/core, vitest). Two results are unobserved. First, that the published pack, with only sepolia.broadcastFile changed to a missing run file and hashes.json reindexed, still prints VERIFIED with 13 lines. Second, that a fixture pack whose constructor values are changed consistently on both sides passes all 13 library checks. Source review finds no check that reads these values from outside the pack, but the end-to-end verdict needs execution.

### Bounded local validation

Run in an approved sandbox with node_modules installed, no network and scratch-only writes. (1) Copy evidence/fisco/fm-6861d1d5e991f1f2 to scratch. In the copy's deployment.json, set sepolia.broadcastFile to contracts/broadcast/DeployFinal.s.sol/11155111/run-1.json. Rebuild hashes.json with hashesFileOf (tamper.ts reindex); packId covers only pack.json, so leave it unchanged. Call main([copy, '--sepolia-bundle', 'evidence/ev-74756ea61a72ae7c']) with no source override. Expect exit 0, 13 check lines and no 'source broadcast (repo copy)' line. The unmodified pack should give 14 lines, including an ok repo-copy line. (2) In tools/verify-evidence/test/fisco, build a second fixture pack with one shared value changed for both the source broadcast and the FISCO deploys, e.g. PARAMS.judging or the Treasury observer. That means creationInput for SSIDE and FSIDE, deployment.json params and roles, and the code slot values. Keep the synthetic source bundle unchanged. Assert that verifyFiscoPack(pack, {sepoliaBundle, source: SOURCE}).ok is true, that main([...], print, SOURCE) returns 0, and that this pack's sepolia-broadcast.json differs from the honest fixture's. Then point broadcastFile at the tracked contracts/broadcast/DeployFinal.s.sol/11155111/run-1792385076465.json and assert that main returns 1 with a FAIL repo-copy line. After the fix (path and keccak pinned in SourceIdentity/FINAL_2, and a failing line when the tracked copy is absent or differs), both (1) and the altered pack must return 1.

### Owner-observed deployment check

To be run and observed by the owner, never through audit traffic. On a fresh clone at 7db6058 without contracts/out, copy the published pack to a temp folder. Change only deployment.json sepolia.broadcastFile to contracts/broadcast/DeployFinal.s.sol/11155111/run-1.json, regenerate hashes.json, and run make verify-fisco PACK=<copy>. Look for VERIFIED with 13 check lines and no 'source broadcast (repo copy)' line. Compare with the 14 lines, including that line, for the unmodified published pack.
