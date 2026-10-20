# Needs validation — hogee run-12

Source ref: 6b0913ebb32fdaf6ac07f8a2f621c9a018a29aeb (int-ux after the FISCO regulator, anchor and Proof page merges plus two dry-run fixes), scope 2590ae0..6b0913e. Profile `quick`, scoped, source-only: no target code was executed.
These are prioritized leads, not confirmed vulnerabilities, and carry no severity. Each section is copied from the final record in
`findings.json`. Owner checks ask you to observe your own components only; none involves sending traffic to a deployment.

## 1. Proof page shows a passing 'Timestamped on Sepolia' check for a FISCO pack that has no Sepolia anchor

- **Fingerprint:** `apps/web/components/evidence/served-fisco.ts:anchorOf:not-anchored-row-labelled-timestamped`
- **Verifier:** `v-1` (independent, source-only)

### Claimed root cause

served-fisco.ts treats the anchor checker's 'not anchored passes' result as an ordinary passing 'Sepolia timestamp' check. fisco-labels.ts maps that check name to the affirmative label 'Timestamped on Sepolia' whatever its state, and FiscoChecks hides the detail of passing rows. So the state 'no timestamp' is shown as 'timestamped, passed'.

### Description

The Proof page can show a passing 'Timestamped on Sepolia' check for a FISCO pack that has no anchor. This happens when the API lists the pack with anchored:false, which is the case whenever no evidence/fisco/anchors/<packId>.sepolia.json exists or whoever controls that folder removes it. verifyServedFisco then runs the anchor checker with a null sidecar. The checker is present in this build because index.ts:30 re-exports anchor.ts, so anchorCheckerOf() is non-null. checkSepoliaAnchor(files, null) returns {ok:true, anchored:false, detail:'not anchored (...)'} before it loads the pack, by design: without --require-anchor, 'not anchored' passes. checkAnchor keeps this as ok:true. verifyServedFisco pushes it as a passing 'Sepolia timestamp' check, which counts toward data.ok and the verdict. FiscoChecks renders the row with a CircleCheck icon labelled 'passed', the fixed title 'Timestamped on Sepolia' and the text 'A public Sepolia transaction from Hogee's deployer names this pack and the hash of its index file.' It renders the detail only when !c.ok, so the 'not anchored' qualifier is dropped. The CLI (`make verify-fisco`) prints the detail on passing lines too, so its line stays qualified; the web page does not. The TimestampCard on the same page correctly says 'Not anchored yet', so the page contradicts itself, but the checks list still states that a public timestamp committing to this pack passed. On a pack that verifies, the green verdict 'N of N checks passed in this browser' counts this line, and the meaning paragraph says 'the Sepolia timestamp is the public part' whenever the pack is proven, with no check that an anchor exists. On the data tracked at this commit, the only pack (fm-c2b22fa376a165da) is hogee.fisco-mirror/1 with no anchors folder. The verifier requires /2, so pack loading fails: 1 failed check plus 14 'not run', plus a failed folder check. The section would read 'Not verified', '1 of 17 checks passed', and the one passing row it lists is 'Timestamped on Sepolia'. Impact is limited to a false statement on the verification page: the VERIFIED outcome is unchanged from design, because an absent anchor never blocks it. But it breaks the page's stated 'never fake a pass' rule for the one external commitment, and stripping the sidecar removes that commitment while the checks list still affirms it. Fix: in served-fisco.ts:68, push the anchor line only when a sidecar was checked or the check failed: `if (anchor.available && (anchor.anchored || !anchor.ok)) checks.push(...)`. Read failures (served-fisco.ts:82) and checker failures (fisco-anchor-check.ts:31) both set ok:false, so they stay visible. Alternatively, give the not-anchored state its own neutral label that is not counted as passed. Also show the 'the Sepolia timestamp is the public part' sentence (fisco-section.tsx:72-73) only when data.anchor.ok && data.anchor.anchored. Update served-fisco.test.ts:113-123 to assert there is no passing 'Sepolia timestamp' line for an unanchored pack, and add a FiscoChecks rendering test.

### Source trace

1. **entrypoint** `packages/api/src/evidence/fisco-store.ts:167` — `listFiscoPacks`: The API lists each pack with anchored = (a sidecar file exists under evidence/fisco/anchors/). Whoever writes that folder sets anchored:false by omitting or removing <packId>.sepolia.json. The real and mock APIs share this reader.
2. **propagation** `apps/web/components/evidence/fisco-section.tsx:37` — `Mirror`: The Proof page runs verifyServedFisco(pack, apiSource(pack.packId)) on the newest listed pack, passing no checker argument, so the real checker is used.
3. **propagation** `apps/web/components/evidence/served-fisco.ts:77` — `anchorOf`: check = anchorCheckerOf() resolves checkSepoliaAnchor (re-exported at tools/verify-evidence/src/fisco/index.ts:30). Because pack.anchored is false, checkAnchor(files, null, check) runs with a null sidecar.
4. **propagation** `tools/verify-evidence/src/fisco/anchor.ts:168` — `checkSepoliaAnchor`: A null sidecar returns {name:'Sepolia timestamp', ok:true (unless required), anchored:false, detail:'not anchored (no evidence/fisco/anchors/<packId>.sepolia.json)'} before the pack is loaded, so the pass holds even for a pack that does not load.
5. **propagation** `apps/web/components/evidence/fisco-anchor-check.ts:46` — `checkAnchor`: r.ok === true and r.anchored !== true becomes {available:true, ok:true, anchored:false, anchor:null, detail}.
6. **propagation** `apps/web/components/evidence/served-fisco.ts:68` — `verifyServedFisco`: if (anchor.available) checks.push({name: ANCHOR_CHECK, ok: anchor.ok, detail}). The not-anchored state becomes a passing check counted in ok (line 69) and in the verdict.
7. **propagation** `apps/web/components/evidence/fisco-labels.ts:73` — `FISCO_CHECK_LABELS`: fiscoCheckLabel('Sepolia timestamp') always maps to the label 'Timestamped on Sepolia' with the text 'A public Sepolia transaction from Hogee's deployer names this pack and the hash of its index file.' There is no not-anchored variant.
8. **sink** `apps/web/components/evidence/fisco-cards.tsx:221` — `FiscoChecks`: c.ok renders a CircleCheck tile with aria-label 'passed' and the title 'Timestamped on Sepolia'. The detail ('not anchored ...') renders only when !c.ok (line 236), so the page affirms a timestamp that does not exist.

### Evidence

- `apps/web/components/evidence/served-fisco.test.ts:122`: The test 'a pack the API lists without a sidecar is checked with none' (line 113) asserts that the 'Sepolia timestamp' check is ok:true for an unanchored listing, so the passing line is intended code behaviour.
- `apps/web/components/evidence/fisco-model.ts:43`: fiscoVerdict titles a full pass 'N of N checks passed in this browser', and N includes the not-anchored line. A failure's count (line 49) also counts it as passed.
- `apps/web/components/evidence/fisco-cards.tsx:150`: On the same page, TimestampCard's 'none' state reads 'Not anchored yet' (anchorView, fisco-model.ts:307), which contradicts the passing 'Timestamped on Sepolia' row. The page has the correct state but does not use it in the checks list.
- `tools/verify-evidence/src/fisco/cli.ts:112`: Comparable baseline: the CLI prints every check's detail, including on passing lines ('ok   Sepolia timestamp — not anchored (...)'). The not-anchored pass is qualified there; the web rendering drops the qualifier.
- `apps/web/components/evidence/fisco-section.tsx:73`: When the verdict is proven, the meaning paragraph says 'the Sepolia timestamp is the public part' without checking data.anchor.anchored.
- `evidence/fisco/fm-c2b22fa376a165da/pack.json:2`: The only tracked pack is format hogee.fisco-mirror/1, and evidence/fisco/anchors/ does not exist. pack.ts:128 requires the literal /2, so verifyFiscoPack returns 1 failed check plus 14 'not run' (index.ts:79). With the failed folder check and the passing anchor line, the section shows 1 of 17 passed, and the anchor line is the only passing row.

### Blockers

- Observing the rendered 'Timestamped on Sepolia' row (data-ok='true', 'passed' tile, no 'not anchored' text) and the verdict count requires running target code: vitest with @testing-library, or the Next app over MOCK_API. Run-12 forbids target execution and has an empty promotion allowlist, so no bounded local result exists. The source trace is complete and deterministic.

### Bounded local validation

In an approved sandbox (no network, read-only worktree, scratch-only writes), add a vitest case beside apps/web/components/evidence/served-fisco.test.ts: const r = await verifyServedFisco(listed(PACK, false), served(PACK)) with the third argument omitted, so the real anchorCheckerOf()/checkSepoliaAnchor runs. Assert r.checks contains {name:'Sepolia timestamp', ok:true}. Then render <FiscoChecks checks={r.checks} ok={r.ok} /> with @testing-library/react and expect the element [data-check='Sepolia timestamp'][data-ok='true'] to contain the text 'Timestamped on Sepolia' and a role=img element named 'passed', and not to contain 'not anchored'. On the tracked fm-c2b22fa376a165da (/1) pack, also assert fiscoVerdict('failed', r.checks).count === '1 of 17 checks passed', and that render(<TimestampCard anchor={anchorView(r.anchor, false)} />) shows data-state='none' with 'Not anchored yet'.

### Owner-observed deployment check

No deployment fact is decisive. Optionally, the owner can open Proof → Checks → FISCO BCOS mirror in their own browser on a server that lists a pack with no evidence/fisco/anchors/<packId>.sepolia.json. They should see a passing 'Timestamped on Sepolia' row (under Show details when the verdict is green) next to a TimestampCard that reads 'Not anchored yet'. This is read-only and needs no audit traffic.

## 2. Anchor tx nonce, gas limit and fee caps are filled by the untrusted Sepolia RPC, never bounded, and the fee caps are not shown before [y/N]

- **Fingerprint:** `scripts/fisco/anchor.sh:cast-mktx-rpc-filled-fee-nonce`
- **Verifier:** `v-2` (independent, source-only)

### Claimed root cause

anchor.sh:140 lets cast mktx fill the nonce, gas limit and fee caps from the lower-trust Sepolia RPC: no --nonce, --gas-limit, --gas-price or --priority-gas-price, and no environment defaults (anchor.sh:90-96). Neither pre-publish decoder bounds those fields (anchor.sh:148-151; scripts/redteam/src/fisco/anchor.ts:68-78). The summary before [y/N] (anchor.sh:155-160) leaves out the fee caps and the maximum cost, so the user's consent at anchor.sh:163 does not cover what the transaction can cost.

### Description

anchor.sh signs the project's one outward Sepolia transaction with the hogee-deployer keystore using `cast mktx` (anchor.sh:140). It passes no --nonce, --gas-limit, --gas-price or --priority-gas-price. The scrubbed environment and empty working folder (anchor.sh:90-96) supply no defaults either. So cast has to take the nonce, gas limit and fee fields from the RPC chosen at anchor.sh:68: --rpc, else SEPOLIA_RPC_URL_CAPTURE, else the public publicnode host. The architecture rates that RPC as lower-trust. The only RPC answer the script checks is eth_chainId (anchor.sh:104-105). Two decoders run before the prompt: the jq predicate on cast decode-transaction (anchor.sh:148-151) and checkRawTx (scripts/redteam/src/fisco/anchor.ts:68-78). Both bind chain, signer, to = self, value 0, input and hash. Neither checks maxFeePerGas, maxPriorityFeePerGas/gasPrice, the gas limit or the nonce. The confirmation (anchor.sh:155-160) prints the type, nonce and gas limit. The fee caps and the maximum cost (gas limit times maxFeePerGas) appear only inside the raw hex. If cast takes the RPC's fee answers with no ceiling, a hostile or compromised RPC can get the user to approve and sign a value-0 self-send of the correct anchor text whose priority fee pays up to the deployer's whole Sepolia test balance to the proposer that includes it. Both decoders and the offline anchor check would still pass. A far-future nonce is printed but compared with nothing, so it yields a signed tx the RPC can hold and release later, taking one future deployer nonce slot. Limits: chain id 11155111 is bound by both decoders, so nothing can be replayed on another chain. No key or password is exposed. The RPC gains nothing directly unless it is that proposer. A fabricated receipt for a withheld tx is the separately documented limit that inclusion is proven only online or on Etherscan (docs/fisco/ANCHOR.md:81), and it is not part of this finding. Fix direction: pass an independently read --nonce and explicit fee ceilings to cast mktx, have both decoders reject fees above a fixed ceiling, and print maxFeePerGas, maxPriorityFeePerGas and the maximum cost before [y/N].

### Source trace

1. **entrypoint** `scripts/fisco/anchor.sh:68` — `RPC selection`: The lower-trust Sepolia RPC is chosen: --rpc, else SEPOLIA_RPC_URL_CAPTURE, else the public publicnode host. Any https host passes (69-76). Its JSON-RPC answers are the untrusted input.
2. **propagation** `scripts/fisco/anchor.sh:96` — `cast_()`: Every cast call runs in an empty cwd with every exported variable unset except PATH, HOME, LC_ALL and ETH_RPC_URL=$RPC. No foundry.toml or env var supplies fee, gas or nonce defaults, so cast asks the RPC.
3. **propagation** `scripts/fisco/anchor.sh:140` — `step 5 sign (cast mktx)`: cast mktx --keystore ... --password-file ... SIGNER CALLDATA with no --nonce, --gas-limit, --gas-price or --priority-gas-price. The nonce, gas limit and fee caps come from the RPC's answers.
4. **propagation** `scripts/fisco/anchor.sh:148` — `step 6 jq predicate on cast decode-transaction`: Checks chainId, to, signer, value, input and hash (149-150). It sets no bound on maxFeePerGas, maxPriorityFeePerGas/gasPrice, gas or nonce.
5. **propagation** `scripts/redteam/src/fisco/anchor.ts:68` — `checkRawTx (run by check-raw at anchor.sh:153)`: Checks chain, recovered sender, to = from, data and value (71-76). The nonce returned by parseSignedTx and the fee and gas fields are never read.
6. **propagation** `scripts/fisco/anchor.sh:156` — `confirmation text`: Prints type, nonce and gas limit but no maxFeePerGas, maxPriorityFeePerGas/gasPrice or maximum cost. The fee caps appear only inside the raw hex on line 159.
7. **propagation** `scripts/fisco/anchor.sh:163` — `step 7 [y/N]`: The user approves without seeing the fee caps or the maximum cost, and with nothing to compare the printed nonce against.
8. **sink** `scripts/fisco/anchor.sh:168` — `step 7 publish`: After y, cast publish --async sends the signed raw tx, with its RPC-chosen fee caps, gas limit and nonce, to the same RPC.

### Evidence

- `scripts/fisco/anchor.sh:15`: The documented guarantee (15-16) covers only chain 11155111, to = self, value 0 and the exact input.
- `scripts/fisco/anchor.sh:93`: The scrubbed environment exports only PATH, HOME and LC_ALL (plus ETH_RPC_URL at 96), so cast gets no fee, gas or nonce defaults from the environment.
- `scripts/fisco/anchor.sh:140`: No fee, gas-limit or nonce flags are passed to cast mktx.
- `scripts/fisco/anchor.sh:149`: jq predicate fields: chainId, to, signer, value, input, hash (149-150).
- `scripts/fisco/anchor.sh:159`: The raw hex is the only place the fee caps appear before the prompt.
- `scripts/redteam/src/fisco/anchor.ts:76`: value is the only economic field checkRawTx checks.
- `tools/verify-evidence/src/crypto.ts:118`: parseSignedTx returns the nonce, which checkRawTx never reads.
- `scripts/redteam/test/fisco/anchor-sh.live.test.ts:85`: The live Anvil test asserts only that the nonce moves by one (and type 0x2 at line 82). It asserts no bound on fee or nonce.
- `docs/fisco/ANCHOR.md:81`: A receipt or inclusion taken as served by the RPC is a separately documented, accepted limit, kept out of this finding.
- `docs/VERSIONS.md:12`: Foundry cast is pinned only by documentation (1.8.5). Its fee and nonce filling logic is not in this repository.

### Blockers

- Run-12 forbids target-controlled execution: macOS cannot enforce the required memory, disk and file-size limits, and no reviewed promotion code exists. So anchor.sh's cast mktx cannot be run against a loopback fixture JSON-RPC to observe the nonce, gas limit and fee fields it signs.
- Whether the installed Foundry cast (documented as 1.8.5) takes the nonce, gas limit and maxFeePerGas/maxPriorityFeePerGas (or gasPrice) from the RPC's eth_getTransactionCount, eth_estimateGas, block baseFeePerGas and eth_feeHistory/eth_maxPriorityFeePerGas answers with no ceiling or sanity refusal is runtime behaviour of a third-party binary whose source is not in this repository. If cast caps or refuses abnormal estimates, the fee half of the finding falls.

### Bounded local validation

Use the approved offline sandbox: loopback-only network, empty allowlisted environment, read-only target and tools, scratch-only writes, low CPU, memory and wall-clock limits. (1) Write the anchorPack() fixture from tools/verify-evidence/test/fisco/anchor-fixture.ts to <scratch>/run/fisco/<packId>/, as writePack does in scripts/redteam/test/fisco/anchor-sh.live.test.ts:41-48. (2) Create a throwaway keystore with `cast wallet new <scratch>/ks throwaway` and a random CAST_PASSWORD, as in the live test (lines 65-70). (3) Start a fixture JSON-RPC on 127.0.0.1:<port> that logs every method it receives and answers as follows. eth_chainId: 0xaa36a7. eth_getTransactionCount: 0x3e8. eth_estimateGas: 0x5dc0. eth_getBlockByNumber (latest or pending): a block with baseFeePerGas 0x9184e72a000 (10,000 gwei). eth_feeHistory: baseFeePerGas and reward entries all 0x9184e72a000. eth_maxPriorityFeePerGas and eth_gasPrice: 0x9184e72a000. eth_sendRawTransaction: an error, never forwarded. (4) Run `/bin/bash scripts/fisco/anchor.sh --pack <scratch>/run/fisco/<packId> --rpc http://127.0.0.1:<port>` with env PATH=<node dir>:/usr/bin:/bin, HOME, TMPDIR=<scratch>, HOGEE_ANCHOR_KEYSTORE=<scratch>/ks/throwaway and stdin '<password>\nn\n'. Capture stdout and stderr to a predeclared scratch file, which the parent promotes. (5) Outside the sandbox, decode the printed `raw 0x...` line with a trusted decoder. The finding holds if all of these are true: the run ends with 'Not sent.' (exit 1); check-raw printed its 'ok:' line; the printed confirmation lines contain no fee cap; the decoded tx has nonce 1000 and maxFeePerGas and maxPriorityFeePerGas (or gasPrice) of at least 10,000 gwei. It is refuted if cast mktx refuses or caps the fee fields well below the fixture values, ignores the fixture nonce, or if either decoder refuses the tx.

### Owner-observed deployment check

None: the local fixture decides this. Never run anchor.sh with the hogee-deployer keystore or against a public Sepolia RPC for validation, because any raw tx it prints is a valid signed Sepolia transaction.

## 3. build.sb blocks only its own sockets: inherited trustd and XPC-service lookups may give the sandboxed build_chain.sh an out-of-sandbox network channel

- **Fingerprint:** `scripts/fisco/build.sb:inherited-system.sb-mach-lookup-network-helpers`
- **Verifier:** `v-3` (independent, source-only)

### Claimed root cause

build.sb relies on (deny network*) for its 'no network at all' guarantee. Unlike node.sb, it adds no mach-lookup deny after its bsd.sb import, so system.sb's allowances stay in force: com.apple.trustd and com.apple.trustd.agent, and in version-1 profiles every XPC service name (xpc-service-name-prefix with an empty prefix). Neither profile denies the XPC-service lookups, and the self-test probes only socket egress. Egress that goes through out-of-sandbox helpers is therefore neither blocked nor tested.

### Description

build_chain.sh is downloaded third-party code, pinned by SHA-256 (chain-up.sh:64 against SHA256SUMS:5). chain-up.sh runs it under build.sb, along with any /bin or /usr/bin tool it starts. The profile's own header (build.sb:4) and the README (README:121) call build.sb a sandbox with no network at all. Its only network rule is (deny network*), which covers only the confined processes' own sockets. Through its import of bsd.sb it inherits macOS system.sb. On this Mac (macOS 27.0.1), system.sb allows mach-lookup of com.apple.trustd and com.apple.trustd.agent (system.sb:176-177). Because build.sb declares (version 1), system.sb also allows lookup of every XPC service name (system.sb:21-23). These helpers run outside the caller's sandbox. trustd's own profile allows it network-outbound (com.apple.trustd.sb:107-108), and trustd fetches issuer and revocation data named in certificates. A hostile pinned script could write a certificate whose caIssuers or OCSP URL carries data, then have a /usr/bin tool evaluate it, for example /usr/bin/security verify-cert. If trustd or a framework XPC service then fetches for the confined caller, data leaves the host in a non-loopback request that the sandbox never sees. node.sb denies the trustd, trustd.agent, analyticsd, nsurlsessiond and xpc.activity.unmanaged lookups right after the same import. That deny has been there since node.sb's first commit, 112c55d, and no comment gives the reason. build.sb has never had any mach-lookup deny, and neither profile denies XPC-service lookups. The self-test probes only socket egress (nc and curl). If the channel exists, the impact is low. build.sb can read only D/build, D/nodes, D/home, D/tmp, D/tools, system paths, sysctl values and stat metadata of any path. So the payload would be: the throwaway node, CA and SDK keys, which the script generates itself, already controls and uses only for a loopback chain; host details; and a beacon showing when, and from which IP, the operator ran the build. No real role key, keystore, password or regulator keystore is readable under build.sb. Whether macOS lets these helpers fetch for such a caller is runtime behaviour that no source shows.

### Source trace

1. **entrypoint** `scripts/fisco/chain-up.sh:124` — `chain-up.sh sandboxed_build (lines 121-127)`: Runs sandbox-exec with -f build.sb and /bin/bash on the copied build_chain.sh, in an emptied environment (env -i, PATH=/usr/bin:/bin). This is downloaded third-party code, digest-pinned at line 64. From here the lower-trust script, and every process it starts, runs under build.sb.
2. **propagation** `scripts/fisco/build.sb:19` — `build.sb exec rule`: Allows process-exec, file-read* and file-map-executable for all of /bin and /usr/bin. The script can therefore run system tools that perform Security.framework trust evaluation or use framework XPC services (for example /usr/bin/security verify-cert) on certificate files it writes in D/build or D/tmp.
3. **propagation** `scripts/fisco/build.sb:12` — `build.sb imports`: Imports bsd.sb, which imports system.sb (/System/Library/Sandbox/Profiles/bsd.sb:15). system.sb allows mach-lookup of com.apple.trustd and com.apple.trustd.agent (system.sb:176-177). Because build.sb declares (version 1) at line 10, system.sb also allows lookup of every XPC service name (system.sb:21-23).
4. **sink** `scripts/fisco/build.sb:13` — `build.sb network rule`: (deny network*) is the profile's only network control, and it covers only the confined processes' own sockets. Unlike node.sb:16-17, no mach-lookup deny follows, so the inherited lookups stay allowed. A request can be handed to trustd, whose profile allows network-outbound (com.apple.trustd.sb:107-108), or to a framework XPC service. That is a possible non-loopback egress path outside the sandbox.

### Evidence

- `scripts/fisco/node.sb:16`: The sibling profile denies mach-lookup of com.apple.trustd, trustd.agent, analyticsd, analyticsd.messagetracer, nsurlsessiond and xpc.activity.unmanaged right after the same bsd.sb import (lines 16-17). This deny has existed since node.sb's first commit, 112c55d, and no comment gives the reason. build.sb (commits 112c55d, 1027057, cc28734) has never had a mach-lookup deny, and neither profile denies XPC-service lookups.
- `scripts/fisco/build.sb:4`: The profile header says 'No network at all'.
- `docs/fisco/README.md:121`: Says the build runs under build.sb, 'a sandbox with no network at all'.
- `docs/fisco/README.md:127`: Lists what the inherited bsd.sb and system.sb rules still allow and says there is 'no network beyond the rules above'. It does not mention the trustd or XPC-service mach-lookup allowances.
- `scripts/fisco/chain-check.sh:211`: The self-test's build.sb network probes are all socket-level: nc to TEST-NET and two curl calls (lines 211-217). scripts/fisco/test/profiles.sh probes build.sb only with true, ps -E and touch, plus a text check of the sysctl rule order. No probe covers egress through a helper.
- `scripts/fisco/chain-up.sh:64`: build_chain.sh must match the SHA256SUMS digest (SHA256SUMS:5). The lower-trust code is therefore one fixed upstream file, and this path matters only if that pinned file, or a tool it drives, is hostile. That is the threat the sandbox exists to contain.

### Blockers

- Decisive macOS runtime fact that no source or profile shows: does trustd (com.apple.trustd or com.apple.trustd.agent) make network fetches (CA issuers, OCSP, CRL) for a client confined by sandbox-exec with (deny network*) on P1's macOS (27.0.1, build 26A434 on this Mac)? trustd's profile allows it network-outbound (com.apple.trustd.sb:107-108) and shows client checks only for the keychain and trust settings (lines 16-23). Any check of the caller's network rights would be inside Apple's closed binary.
- The same question applies to framework XPC services reachable through the empty-prefix xpc-service-name-prefix lookup. The XPCTimeStampingService and XPCAcmeService profiles say they now gate requests on SecXPCCallerHasNetworkEntitlement (an 'XPC network-service sandbox-bypass class fix', rdar://177979759). The profiles do not show how that check treats an unentitled command-line caller under sandbox-exec, or whether other framework services make requests for callers.
- This run allows no execution: macOS cannot enforce the required memory, disk and file-size limits, and the promotion allowlist is empty. The bounded loopback probe below therefore cannot run, and without it neither the channel nor its absence is established.

### Bounded local validation

Use only Apple tools and Homebrew OpenSSL 3: no target code, no external network. Run on P1's Mac with external networking off, or on an isolated macOS 27.0.1 VM. 1) Create a throwaway D with the folders chain-up.sh makes (build, home, tmp, tools, nodes, bin) and a scratch folder S outside D. 2) Outside any sandbox, start /usr/bin/nc -l 127.0.0.1 18080 > S/hits.txt (one connection per run). 3) With /opt/homebrew/opt/openssl@3/bin/openssl, create in D/tmp a throwaway root CA, an intermediate signed by it, and a leaf signed by the intermediate. Give the leaf authorityInfoAccess caIssuers;URI:http://127.0.0.1:18080/hogee-probe.cer and do not provide the intermediate. 4) Positive control, unsandboxed: run /usr/bin/security verify-cert -c D/tmp/leaf.pem -r D/tmp/root.pem -p basic (without -L). Require a GET /hogee-probe.cer in hits.txt; otherwise the fixture does not trigger a fetch and the test is void. 5) Restart the listener and run the same command exactly as chain-check.sh's sb_build does: /usr/bin/env -i PATH=/usr/bin:/bin HOME=D/home TMPDIR=D/tmp LC_ALL=C /usr/bin/sandbox-exec -D CHAIN_DIR=D -D BIN=D/bin/fisco-bcos -D OPENSSL_CELLAR=/opt/homebrew/Cellar/openssl@3 -f scripts/fisco/build.sb /usr/bin/security verify-cert -c D/tmp/leaf.pem -r D/tmp/root.pem -p basic, with a 30 s timeout. Capture log show --last 2m --predicate 'sender == "Sandbox" OR process == "trustd"'. A GET in hits.txt confirms helper-mediated egress from build.sb, because the request comes from trustd, not the confined process. No GET together with a logged sandbox or fetch refusal refutes the trustd path. If security fails before evaluating (for example a keychain lookup denial), record 'not exercised', not 'refuted'. 6) Repeat step 5 with a scratch copy of build.sb that adds node.sb:16-17's deny list and (deny mach-lookup (xpc-service-name-prefix "")) after the import; expect no GET. Afterwards remove D and S and stop the listener. Fix if confirmed: add those denies to build.sb after the import and the XPC-service deny to node.sb; re-run P1's live chain-up test; add the step-5 probe to chain-check.sh --selftest, expecting no hit; and correct build.sb:4 and README:121 and :127.

## 4. fisco:sepolia-code prints Sepolia-RPC-controlled text to the operator's terminal without the nodeText control-character filter

- **Fingerprint:** `scripts/redteam/src/fisco/sepolia-code.ts:error-output-node-text-unsanitized`
- **Verifier:** `v-4` (independent, source-only)

### Claimed root cause

The top-level catch in sepolia-code.ts (line 126) prints error.message raw, without nodeText. Meanwhile captureSepoliaCode lets RPC result text into thrown messages: head.number is only typeof-checked before BigInt() (lines 61-62), and the eth_call result is decoded without a hex check (lines 66-67). This breaks the rule that node-supplied text is cleaned before printing (rpc.ts:13-14), which the sibling CLIs keep for their whole error line.

### Description

fisco:sepolia-code reads from an https Sepolia RPC that the operator names. The RPC can be on any host, and the architecture treats it as lower-trust. The httpTransport returns each JSON-RPC result exactly as served. Only error.message is cleaned by nodeText, at rpc.ts:99. An RPC that answers eth_chainId with 0xaa36a7 passes the chain guard at lines 54-55. It can then answer eth_getBlockByNumber("latest") with a block whose number is any string. That value is only typeof-checked (line 61) before BigInt() at line 62. Under V8, a non-numeric string throws a SyntaxError whose message quotes the string. The second path is the eth_call result for Treasury.governance(), which the RPC also controls. It reaches viem's decodeFunctionResult at line 67 without a hex check. From viem 2.x, a non-hex string is expected to throw an 'Invalid byte sequence' error that quotes the data. A short hex answer instead gives AbiDecodingDataSizeTooSmallError, which quotes only hex. The rejection travels unchanged through sepoliaCodeMain (line 118) to the isMain catch. That catch writes error.name and error.message to stderr at line 126 without nodeText. In the documented invocation (scripts/redteam/package.json:17, `node --import tsx src/fisco/sepolia-code.ts`), isMain is true. The sibling CLIs on the same rpc.ts layer clean the whole printed error line: fisco:anchor at anchor.ts:227, which talks to the same class of Sepolia RPC, and fisco:replay at cli.ts:213. ESC/CSI/OSC sequences from the RPC can therefore reach the operator's terminal. They could erase the 'fisco:sepolia-code failed:' prefix and show a fake 'code-sepolia captured' line, or use whatever other sequences the terminal honours. The impact is bounded. The failure happens before makeFreshDir (line 82), so nothing is written. The process still exits 1. A faked success leaves no code-sepolia folder for the later pack build. The success line on stdout (line 119) is safe, because meta passes the strict CodeMeta schema (Hex32 blockHash).

### Source trace

1. **entrypoint** `scripts/redteam/src/fisco/rpc.ts:103` — `httpTransport`: Returns body.result from the operator-named Sepolia RPC (https, any host) as served; only body.error.message is passed through nodeText (line 99)
2. **propagation** `scripts/redteam/src/fisco/sepolia-code.ts:60` — `captureSepoliaCode`: The RPC's latest-block answer is taken as served, after the eth_chainId 11155111 guard (54-55) passes for an RPC answering 0xaa36a7
3. **propagation** `scripts/redteam/src/fisco/sepolia-code.ts:62` — `captureSepoliaCode`: BigInt(head.number) on a string checked only by typeof (line 61); a non-numeric string throws a SyntaxError whose V8 message quotes it
4. **propagation** `scripts/redteam/src/fisco/sepolia-code.ts:67` — `captureSepoliaCode`: [second path] The eth_call result from line 66 goes to viem decodeFunctionResult without hex validation; viem's hex parsing error is expected to quote the data
5. **propagation** `scripts/redteam/src/fisco/sepolia-code.ts:118` — `sepoliaCodeMain`: Awaits captureSepoliaCode; the rejection reaches the module entry's catch unchanged
6. **sink** `scripts/redteam/src/fisco/sepolia-code.ts:126` — `isMain catch`: process.stderr.write of error.name and error.message without nodeText

### Evidence

- `scripts/redteam/src/fisco/rpc.ts:13`: Module contract: node-supplied text is cleaned of control characters (nodeText) before anything prints or records it; the parenthetical names JSON-RPC error messages
- `scripts/redteam/src/fisco/rpc.ts:45`: nodeText replaces Cc/Cf/U+2028/U+2029 (UNPRINTABLE, line 42) with '?'
- `scripts/redteam/src/fisco/rpc.ts:99`: The transport cleans only JSON-RPC error messages; result fields are returned raw at line 103
- `scripts/redteam/src/fisco/anchor.ts:227`: The sibling Sepolia-RPC CLI wraps error.message in nodeText(…, 500) before writing it to stderr
- `scripts/redteam/src/fisco/cli.ts:213`: The replay CLI wraps the whole error line in nodeText
- `scripts/redteam/src/fisco/sepolia-code.ts:61`: Only typeof checks guard head.number and head.hash before BigInt()
- `scripts/redteam/src/fisco/sepolia-code.ts:125`: The catch's comment covers only keeping the URL out of the message, not control characters
- `scripts/redteam/src/fisco/sepolia-code.ts:82`: makeFreshDir runs only after both failing points, so a hostile answer writes nothing; impact is limited to terminal output
- `scripts/redteam/package.json:17`: The documented fisco:sepolia-code script runs src/fisco/sepolia-code.ts directly, so the isMain catch is live
- `scripts/redteam/package.json:38`: viem is pinned to 2.57.6; its source is not in the worktree (no node_modules), so the second path's error text cannot be read from allowed source

### Blockers

- Run-12 forbids target-controlled execution. Repository source cannot show whether the operator's Node/V8 puts the raw string, control characters unescaped, into the SyntaxError from BigInt(head.number) (or into viem 2.57.6's hexToBytes error for the second path, whose source is absent from the worktree). That raw text is what makes the sink reachable with ESC bytes.
- What the injected ESC/CSI/OSC sequences do depends on the operator's terminal emulator and its settings. Examples are erasing the failure line, showing a fake success line, or honouring title or clipboard (OSC 52) sequences. The terminal is outside the repository.

### Bounded local validation

Run in the approved sandbox only: no external network, empty environment, read-only worktree, writes to scratch only, CPU/memory/wall-clock limits. (a) From a scratch script, build new Rpc(t), where t answers eth_chainId with '0xaa36a7' and eth_getBlockByNumber with {number: '0x\u001b[2K\rforged', hash: '0x' + 'ab'.repeat(32)}, and refuses every other method. Call captureSepoliaCode(rpc, '<scratch>/out-a'). Assert it rejects with a SyntaxError whose message contains U+001B, and that '<scratch>/out-a/code-sepolia' does not exist. (b) Same fixture, but number '0xb6a000' and eth_call answering '0x\u001b]0;x\u0007'. Assert the rejection message contains U+001B. (c) Inside the sandbox, serve fixture (a) as JSON-RPC on http://127.0.0.1:<free port>. From scripts/redteam, run `node --import tsx src/fisco/sepolia-code.ts --out <scratch>/out-c` with only SEPOLIA_RPC_URL_CAPTURE=http://127.0.0.1:<port> set, and send stderr to <scratch>/stderr.bin. Assert exit code 1 and a raw 0x1b byte after 'fisco:sepolia-code failed: SyntaxError: '. Fix check: after wrapping the line-126 text in nodeText, the same run leaves '?' and no 0x1b byte.

### Owner-observed deployment check

Owner-observed, with no RPC or audit traffic. In the terminal they use for fisco:sepolia-code, the operator runs `printf 'fisco:sepolia-code failed: SyntaxError: Cannot convert 0x\033[2K\rcode-sepolia captured at block 1 to a BigInt\n' >&2`. They record whether the 'failed' prefix disappears and only the fake 'captured' text stays visible. This shows the display effect for their emulator without contacting any service.
