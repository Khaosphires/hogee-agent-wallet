# Needs validation — hogee run-10

Source ref 38e552b (main after PR #14; scope 6dc22f0..38e552b). Profile `quick`, scoped, source-only: no target code was executed.
These are prioritized leads, not confirmed vulnerabilities, and carry no severity. Each section is copied from the final record in
`findings.json`. Owner checks ask you to observe your own components only; none involves sending traffic to a deployment.

## 1. An open tab can show the Sample business's made-up plan seal as this browser's passkey signature, with no Sample tag

- **Fingerprint:** `apps/web/components/chat/cards/sign-host.tsx:SignStub:sample-tag-keyed-by-kind-refId-not-bound-to-tx`
- **Verifier:** `v-1` (independent, source-only)

### Claimed root cause

The 'signed in this browser' decision (the in-memory Submitted record and hogee.signedAt) is keyed only by (kind, refId). The PlanApproval 'confirmed' decision only checks that the plan's txHash differs from baselineTx. Neither is bound to the transaction this browser submitted or to the store build. The mock reuses the seeded plan-draft.json draftId as the PlanApproval refId in every build, including the lived sample's made-up commit. A store rebuild invalidates neither the browser's records nor an already mounted thread.

### Description

This is new in this range. SignStub decides that a confirmed seal is 'signed in this browser' in two ways: an in-memory record from this page, or the localStorage entry hogee.signedAt. Both are looked up only by `${kind}:${refId}`. When either is found, the stub hides the Sample tag and stamps the seal with this browser's signing method and time. The mock reuses one PlanApproval refId in every store build: the seeded plan-draft.json draftId, used by the fresh plan reply and by the lived scenario's sample commit. POST /api/demo/sample-business can come from a second tab or from another visitor of a shared hosted mock. It rebuilds the module-global store as the Sample business, which commits that same draftId with the made-up txHash mockHash('tx:sample:PlanApproval:<id>') ('no passkey signed it'). A tab that signed the plan in the earlier fresh build keeps its old thread. ChatView's thread latch holds it, and the per-tab session-id memo ignores the reset id. That tab also keeps its record and its hogee.signedAt entry, which the switch never clears. The tab's 1.5 s getCurrentPlan poll then delivers the lived plan. signProgress accepts it as confirmed because its txHash differs from baselineTx; it never compares it with the tx this browser submitted. The stub then shows the sample's commit as 'Signed by Mei with a passkey · <this browser's time>' with no Sample tag, while the wallet rail labels the same plan Sample. With an in-page record the tag is gone whatever the sample flag says. With only hogee.signedAt, the entry is what suppresses the tag once the 60 s-stale sample flag refreshes. The impact is limited to presentation in a mock demo: no money, signature or authority changes. A reviewer is misled about which seal they made. The only lower-trust trigger is another visitor of a shared hosted mock.

### Source trace

1. **entrypoint** `packages/api-mock/src/demo-data.ts:54` — `POST /api/demo/sample-business`: Raw Hono route with no persona check. It is gated only by DEMO_MODE, REPLAY/SG and an exact {on:boolean} body. Any same-origin caller can rebuild the shared mock store: a second tab in the reviewer's browser, or another visitor of a shared hosted mock. Line 61 calls resetState(env, 'lived').
2. **propagation** `packages/api-mock/src/store.ts:226` — `resetState`: Drops the module-global store. getState rebuilds it from the same seed, and freshState empties plans (line 201) and chats (line 209) before the lived story is played in.
3. **propagation** `packages/api-mock/src/store.ts:268` — `buildState`: Every build seeds drafts under plan-draft.json's fixed draftId, so the PlanApproval refId is the same constant in the fresh and lived builds.
4. **propagation** `packages/api-mock/src/scenario-lived/build.ts:221` — `playStory commit step`: The lived build commits the plan with sampleSignature('PlanApproval', draftOf(st).draftId). That gives txHash mockHash('tx:sample:PlanApproval:<id>') (line 145) and a trace that says it was made up and no passkey signed it (line 147).
5. **propagation** `packages/api-mock/src/journey/index.ts:163` — `intakeReply`: [second path] Before the rebuild, in the fresh build, the victim tab's plan reply carried the needs card and the PlanApproval card for the same seeded draftId (draft taken at line 159).
6. **propagation** `apps/web/components/chat/cards/sign-host.tsx:112` — `SignHost.onDone`: [second path] When the victim signed that plan, onDone stored hogee.signedAt['PlanApproval:<draftId>'] = {at, method} and an in-memory Submitted record under the same key (line 113). Neither ties the 'this browser signed it' decision to the committed tx or to the store build.
7. **propagation** `apps/web/components/chat/chat-view.tsx:136` — `ChatView threadLatch`: The victim tab keeps its old thread: threadLatch returns the previous latch for the same session id (journey-client.ts:46). getChatSessionId's per-tab memo (chat-session.ts:27) ignores the new id the switching tab wrote. So the thread with its `signed` PlanApproval press, and the in-memory record, stay mounted. Only the switching tab does a full navigation (demo-data-toggle.tsx:99).
8. **propagation** `apps/web/components/chat/chat-thread.tsx:270` — `ChatThread useCurrentPlan`: getCurrentPlan is polled every 1.5 s while the tab is visible (useApiQuery default, hooks.ts:21). The latched thread's SignStub therefore reads the lived sample plan from the shared query cache.
9. **propagation** `apps/web/components/chat/cards/sign-host.tsx:188` — `useSignProgress`: submitted is true when there is a local record or a `signed` action for (kind, refId) in the mounted thread. baselineTx comes only from the local record (null without one), and submittedTx is passed but unused for PlanApproval.
10. **propagation** `apps/web/lib/journey-client.ts:417` — `signProgress`: PlanApproval counts as confirmed, with the plan's txHash, for any COMMITTED plan whose txHash differs from baselineTx. That hash is never compared with the tx this browser submitted, so the lived sample's commit is confirmed as this browser's signature.
11. **sink** `apps/web/components/chat/cards/sign-host.tsx:241` — `SignStub`: sample = useSampleBusiness() && confirmed && !local && !kept, where kept = storedSignature(key) (line 239). A local or kept record for the reused key suppresses SampleSealTag (line 298). SealStub (lines 291-294) stamps the sample tx with this browser's method and time, as 'Signed by Mei with a passkey · <time>'.

### Evidence

- `apps/web/components/chat/cards/sign-host.tsx:141`: hogee.signedAt is one localStorage object keyed by kind:refId. Each entry holds only {at, method}: no txHash and no store build.
- `apps/web/components/chat/cards/sign-host.tsx:174`: The code assumes that a browser record for (kind, refId) means the seal is never the sample business's. Reused mock refIds break that assumption.
- `apps/web/components/chat/cards/sign-host.tsx:239`: kept = storedSignature(key) whenever the seal is confirmed and there is no page-local record.
- `apps/web/components/chat/wallet-rail.tsx:274`: The wallet rail tags the committed plan's seal Sample whenever the Sample business is on, so it disagrees with the stub.
- `apps/web/components/settings/demo-data-toggle.tsx:93`: After the switch only goods-arrived marks are dropped (dropGoodsArrivedMarks, line 56; reused-id comment at line 28). hogee.signedAt and other open tabs are left alone.
- `packages/api-mock/src/handlers-core.ts:110`: Mock draftPlan also always returns the seeded plan-draft.json, so the plan's draftId never changes between builds.
- `packages/api-mock/src/scenario-lived/build.ts:145`: The sample's PlanApproval txHash is mockHash('tx:sample:PlanApproval:<draftId>'). Line 147 records that no passkey signed it.
- `apps/web/lib/journey-client.ts:46`: threadLatch keeps the previous latch whenever the session id is unchanged, so an open thread is never replaced by the rebuilt store's history.
- `apps/web/lib/chat-session.ts:27`: The session id is memoised per tab. Another tab's resetChatSessionId changes localStorage but not this tab's memo.
- `apps/web/components/chat/sample-seal.tsx:24`: The sample-business flag is a 60 s-stale query. It refreshes on a new observer after 60 s or on an invalidation, never on focus: providers.tsx:9 sets refetchOnWindowFocus false.
- `packages/api-mock/src/demo-data.ts:61`: The switch calls resetState(env, 'lived') for any caller that passes the DEMO_MODE, REPLAY/SG and body gates.

### Blockers

- No target-controlled execution is permitted in this run: macOS cannot enforce the required sandbox limits and there is no promotion code. So the stale-tab sequence was not observed in a browser. Two runtime facts are decisive. First, TanStack's 1.5 s getCurrentPlan poll (chat-thread.tsx:270, hooks.ts:21) must deliver the lived plan to the latched thread's SignStub once the tab is visible. Second, for the hogee.signedAt-only variant, the 60 s-stale sample-business flag (sample-seal.tsx:24) must refresh while ChatView's latch keeps the old thread mounted. A ChatView remount or full reload loads the lived history, which has no PlanApproval sign card, and closes the path.
- The only lower-trust trigger is another visitor flipping POST /api/demo/sample-business on a shared hosted mock. When the reviewer's own second tab flips it, the mislabel is self-inflicted. Whether a deployment serves MOCK_API=1 with DEMO_MODE=1 to more than one visitor at a time is a deployment fact that source does not show.

### Bounded local validation

Use an isolated local mock (MOCK_API=1, DEMO_MODE=1, HOGEE_COUNTRY=SG, no REPLAY) in one local browser profile, with the Sample business off (fresh). Variant A, in-page record: (1) In tab A on /chat, run the intake to the plan reply and sign the plan. Wait until the needs card's [data-testid=sign-status] has data-state=confirmed, and note its tx hash and stamp time. Do not reload or navigate tab A afterwards. (2) In tab B of the same browser, turn the Sample business on with the switch. (3) Bring tab A to the front and wait at least 3 s. Expected if the lead holds: the needs card's [data-testid=sign-confirmed] shows the tx mockHash('tx:sample:PlanApproval:<seeded draftId>') (the same tx as the wallet rail's plan seal) with 'Signed by Mei with a passkey' and tab A's original time, and the stub has no [data-testid=seal-sample]. Variant B, hogee.signedAt: as Variant A, but reload tab A once after its plan is confirmed and before step 2. After step 2, keep tab A on /chat without remounting ChatView for more than 60 s. Then mount a new observer of the sample-business query, for example by opening the wallet sheet at phone width. Expect the same stamp, with the stored time and no seal-sample, while the wallet rail shows Sample. Control: remove the PlanApproval:<draftId> key from hogee.signedAt in devtools and re-render; the seal-sample tag should appear. Regression fix: store the submitted txHash in SignedLocally and in the Submitted record. Treat a seal as this browser's (local or kept, suppressing the Sample tag and stamping method and time) only when that tx equals progress.txHash. In signProgress, require plan.txHash === submittedTx for PlanApproval when submittedTx is known. Clear hogee.signedAt on a demo switch or reset, or key it by a store-build id that the mock exposes.

### Owner-observed deployment check

Owner-observed only, with no audit traffic. On each hosted demo, confirm whether it runs the in-process mock (MOCK_API=1) with DEMO_MODE=1 and is open to more than one judge or visitor at a time. If it is, any visitor's POST /api/demo/sample-business rebuilds the shared store, and another visitor's open tab can show the sample's plan seal as their own passkey signature. Confirm this from the deployment's configuration and access policy, not by sending requests.

## 2. In mock mode, a recorded proof pack that fails the browser check is shown as a harmless 'Sample proof pack'

- **Fingerprint:** `apps/web/components/evidence/proof-model.ts:packStatus:mock-mode-failure-shown-as-sample`
- **Verifier:** `v-2` (independent, source-only)

### Claimed root cause

packStatus picks the 'sample' presentation from the session mode (ApiMode 'mock'), not from the pack's provenance. The run listing summary has no field that tells the fixture sample or core example apart from an exported recorded run (packages/core/src/schemas/evidence.ts:60). Since this range the mock lists exported runs, any deployment of the demo facility on the demo chain, first. So in mock mode a failure of an exported evidence/ run is explained away as a sample. Fix: decide the sample tone from the pack's identity, not the mode. For example, the mock serves the fixture sample and the core example under a reserved runId prefix that isRunName refuses for evidence/ folders, and packStatus uses the sample tone only for those ids. A failing evidence/ run stays red 'Not verified' with its count in every mode. Regression cases: packStatus for a failed exported run in mock returns tone 'failed'; proof-model.test.ts:11-19 and the e2e assertion at evidence.spec.ts:45-46 are narrowed to the fixture sample.

### Description

Under MOCK_API=1 without REPLAY (dev:mock, the mode judges run), the mock lists every evidence/<runId> export of the demo facility (fac-mei) on the demo chain (Sepolia), whatever its deployment (packages/api-mock/src/evidence.ts:292-293). Exported runs come before the fixture sample (:333). The final-2 pack evidence/ev-74756ea61a72ae7c is tracked in git (force-added past .gitignore:36), and its contracts.json names fac-mei, final-2 and chain 11155111. So it ships in the judge's checkout and is the default Proof pack (evidence-view.tsx:69). The browser fetches the pack files exactly as stored (evidence.ts:380) and checks them offline (verify-panel.tsx:23-37). If any check fails, or any file cannot be fetched or parsed, packStatus returns the grey 'sample' tone only because the session mode is 'mock' (proof-model.ts:35-42). It ignores which pack failed and the 'Recorded on' label it receives. The unit test proof-model.test.ts:11-19 asserts exactly this, with 'Recorded on Sepolia · 19 Oct' passed in. The page then: titles the pack 'Sample proof pack' with a grey flask icon. It says 'This sample comes from a test run, so it doesn't check here. A recorded pack checks in full.', which is false for this pack, a recorded export. It hides the 'N of M checks passed' count (verify-panel.tsx:131) and the figures (:140). It puts the failing checks inside the closed 'Show details' fold with grey CircleMinus icons and grey detail text (:116, :155-156). And it relabels every row 'Sample' instead of Pass or Fail (evidence-view.tsx:132, evidence-table.tsx:52). The only red signal left is the anchor note 'a check above failed' inside that closed fold (anchor-section.tsx:37). This masking covers a final-2 pack whose bytes were changed after export, a hand-edited row, and any other listed fac-mei Sepolia export that fails the check. The judge sees a benign explanation instead of the red 'Not verified' tamper signal. Before this range (6dc22f0, verify-panel.tsx:72), every mode showed 'Not verified' for a failed pack. The range brought in both packStatus and the listing change (commits 713a359 and dadc14c). The e2e smoke test codifies the outcome: 'The mock never shows a red Not verified' (e2e/smoke/evidence.spec.ts:45-46). What is not claimed: no green 'Every check passed' is faked, because the verified tone needs verifyBundle(...).ok (verify-panel.tsx:37). Tampered rows are never shown as 'Pass', only as 'Sample'. The harm is that a failed recorded pack, tampered or corrupted, has its failure suppressed and explained away as expected sample behaviour, next to a claim that recorded packs check in full.

### Source trace

1. **entrypoint** `packages/api-mock/src/evidence.ts:316` — `evidenceRuns`: GET /api/evidence/runs (handlers-ops.ts:121) lists the pack folders under evidence/. Their content is lower-trust for the reviewer: it is the input the browser check exists to verify. Any fac-mei export on Sepolia is accepted whatever its deployment (tenantOf :276-279, readEvidenceRun :292-293). Exported runs are listed before the fixture sample (:333), so the tracked final-2 pack ev-74756ea61a72ae7c is first.
2. **propagation** `apps/web/components/evidence/evidence-view.tsx:69` — `EvidenceView`: The default runId is runs.data[0], the newest exported run: the final-2 Sepolia pack.
3. **propagation** `packages/api-mock/src/evidence.ts:380` — `evidenceFile`: Each pack file is served as stored (link, size and containment checks only). Nothing on the server checks the bytes against the pack's hashes; the browser check is the only integrity control.
4. **propagation** `apps/web/components/evidence/verify-panel.tsx:37` — `useVerify`: The browser's verifyBundle over the fetched files gives check 'failed' (ok false) or 'unreadable' (a fetch or parse error).
5. **propagation** `packages/api-mock/src/store.ts:395` — `sessionFor`: Without REPLAY the mock session mode is 'mock', which useVerify reads through useSession (verify-panel.tsx:35).
6. **propagation** `apps/web/components/evidence/proof-model.ts:35` — `packStatus`: When mode === 'mock', any failed or unreadable result gets tone 'sample', title 'Sample proof pack', the line 'This sample comes from a test run...' and showCount false. Neither the pack's identity nor the 'recorded' argument is consulted.
7. **propagation** `apps/web/components/evidence/evidence-view.tsx:132` — `Tests`: [second path] The same packStatus tone sets sample=true for the tests table of the recorded pack.
8. **propagation** `apps/web/components/evidence/evidence-table.tsx:52` — `Result`: [second path] Every row of the recorded pack reads 'Sample', not Pass or Fail.
9. **sink** `apps/web/components/evidence/verify-panel.tsx:119` — `VerifyPanel`: The panel renders data-tone='sample' with the grey flask and 'Sample proof pack' heading (:121-125), with no count (:131) and no figures (:140). The failing checks sit inside the closed Show details, with grey CircleMinus icons and grey detail text (quiet at :116, :155-156), so the reviewer never sees a red 'Not verified' for a recorded pack that failed.

### Evidence

- `apps/web/components/evidence/proof-model.ts:35`: The mock branch returns the benign sample status for every failed or unreadable pack, whatever pack it is and whatever recorded label is passed in.
- `apps/web/components/evidence/proof-model.test.ts:13`: The unit test asserts that packStatus('failed'|'unreadable', 'mock', 'Recorded on Sepolia · 19 Oct') gives tone 'sample' and showCount false, which is the masking of a recorded pack.
- `packages/api-mock/src/evidence.ts:292`: Since this range (commit dadc14c) the tenant check accepts any deployment of the facility on the chain. The old check also pinned deploymentId final-1, which would have kept the final-2 pack out.
- `packages/api-mock/src/evidence.ts:333`: Exported runs are listed before the fixture sample, so a recorded pack is the default whenever there is one.
- `packages/core/src/demo/mei.ts:27`: The SG demo tenant is fac-mei on chain 11155111 (deploymentId final-1 at :26). It matches the final-2 pack's contracts.json (evidence/ev-74756ea61a72ae7c/contracts.json:6 deploymentId final-2), so the mock lists that pack.
- `.gitignore:35`: evidence/* is ignored except force-added final bundles. git ls-files shows evidence/ev-74756ea61a72ae7c tracked (25 files), so the recorded pack ships with the judge's checkout and dev:mock lists it.
- `packages/core/src/schemas/evidence.ts:60`: EvidenceRunSummary (runId, createdAt, gitCommit, rowCount) is a strict object with no provenance field, so the UI cannot tell the fixture sample from an exported run.
- `e2e/smoke/evidence.spec.ts:45`: The smoke test asserts that the mock never shows a red Not verified (tone verified or sample), whichever pack is checked.
- `apps/web/components/evidence/verify-panel.tsx:116`: quiet = tone === 'sample' turns failing check icons into grey CircleMinus and the failure details grey (:65, :76). For a non-failed tone the checks render only inside the closed Show details (:155-156).
- `apps/web/components/evidence/anchor-section.tsx:37`: The only remaining red text, 'a check above failed, so these values prove nothing yet', sits inside the same closed Show details fold.

### Blockers

- Run-10 forbids target-controlled execution (macOS cannot enforce the required sandbox memory, disk and file-size limits, and no promotion code exists). So two things were not observed: the Proof page rendered under MOCK_API=1 against a scratch copy of evidence/ev-74756ea61a72ae7c with one evidence.json row changed, and the existing unit case proof-model.test.ts:11-19 run. The claim rests on the pure function packStatus and its source-visible callers, with no bounded observed result.

### Bounded local validation

In an approved sandbox (no external network, empty allowlisted environment, read-only tools, scratch-only writes, low memory/disk/time limits): (1) Run vitest on apps/web/components/evidence/proof-model.test.ts only. Expect the case at :11-19 to pass, showing packStatus('failed', 'mock', 'Recorded on Sepolia · 19 Oct').tone === 'sample'. (2) Copy the worktree at 38e552b into scratch, so findRepoRoot resolves to the copy's pnpm-workspace.yaml. In the copy's evidence/ev-74756ea61a72ae7c/evidence.json, flip one row's outcome and leave hashes.json unchanged. Start the web app with MOCK_API=1 via dev:mock (default SG profile, no REPLAY), bound to 127.0.0.1, and open /evidence. Expect: the pack select defaults to ev-74756ea61a72ae7c; verify-panel has data-tone='sample' and heading 'Sample proof pack'; verify-practice-note is present; verify-count and the figures are absent; every evidence-row reads 'Sample'; verify-details is closed, with grey failing checks inside. Control: the unmodified copy should show data-tone='verified'. If it shows 'sample', the shipped pack already fails the browser check and is masked the same way. After the fix, the modified copy shows data-tone='failed', 'Not verified' and a verify-count.

### Owner-observed deployment check

No deployed fact is needed and no audit traffic is required. Optionally, the owner can confirm on their own local judge build (dev:mock) that the recorded pack turns red 'Not verified' once any of its files is altered in a local copy.

## 3. 'Every check passed · Recorded on <chain>' names the first manifest deployment, which the verifier does not bind, instead of the verified anchor chain

- **Fingerprint:** `apps/web/components/evidence/proof-model.ts:recordedLabel:chain-from-unbound-manifest-deployment`
- **Verifier:** `v-3` (independent, source-only)

### Claimed root cause

The headline attribution comes from an envelope field the verifier does not bind (the first manifest.deployments entry in key order), not from the verified payload identity (VerifyResult.anchor.chainId, that is contracts.json's chainId). Fix: in VerifyPanel, build the label from result.anchor.chainId, and only when result.ok. Return null when the manifest lists more than one deployment, as badgeDeployment does. Optionally, make checkRows fail a manifest whose deployments are not exactly contracts.json's deployment. Regression case: a manifest with a Sepolia 'final-2' entry first and the 31337 entry second, with contracts.json on 31337, must never yield 'Recorded on Sepolia'.

### Description

The new Proof headline under the green 'Every check passed' comes from recordedLabel(Object.values(b.manifest.deployments).map(d => d.chainId), run.createdAt) (evidence-view.tsx:85). recordedLabel takes chainIds[0] (proof-model.ts:27), and packStatus puts it on the verified line (proof-model.ts:34). The manifest is pack content: BundleManifest.deployments is an open record (core schemas/evidence.ts:48), and the mock serves the parsed manifest in file key order (evidence.ts:256-262, :355). The offline verifier binds rows, receipts and the anchor to contracts.json's deploymentId and chainId (anchor.ts:37-39, audit.ts:98). Its only manifest-deployment checks are two. checkRows requires the contracts.json deployment to be present on its chain and to agree on its addresses (audit.ts:87-91). explorerProblems requires each other entry's verifiedUrl to be exactly its own code page on that chain's pinned explorer (bundle.ts:311-316). hashes.json is an unkeyed index (index.ts:16), and SUMMARY.md uses only the manifest's runId and gitCommit (summary.ts:12). Genuine exports write exactly one deployment (packages/api/src/evidence/export.ts:176-181), so a pack with several entries has been altered or fabricated. By source, that pack still verifies. Example: the committed Anvil pack ev-cdc4cc7916471c1e (its only entry is final-meie4ba8c on 31337; it is the documented REPLAY demo pack, docs/decisions/int-e2e-author.md:81). Put a 'final-2' Sepolia entry first, holding the real final-2 addresses and Etherscan code URLs from evidence/ev-74756ea61a72ae7c/manifest.json, then recompute hashes.json. Served under REPLAY, which drops the chain pin (evidence.ts:278, :292-293), or by the live store when its deployment is that Anvil one (store.ts:96-97), the panel would read 'Every check passed · Recorded on Sepolia · 18 Oct'. Versions then also links the forged entry's real, verified final-2 contracts on Etherscan (evidence-view.tsx:29-43, linkable in replay and live). The sibling control badgeDeployment names no deployment when the manifest lists several (mode-deployment.ts:20-22); recordedLabel does not follow that rule. The boundary at stake is reviewer trust in an evidence pack from a lower-trust producer. The offline verifier exists so the reviewer need not trust the pack's author. Here the author gets a Sepolia attribution while the anchor names a local chain that the reviewer cannot compare with a public explorer. That is easier for the author than fabricating a Sepolia-anchored pack, whose tx hashes would be missing on Etherscan. The impact is limited to a misleading attribution. Nothing is paid, signed or authorized differently. In the same panel, the anchor's Blockchain row still reads 'Anvil (local) · 31337' (anchor-section.tsx:40). That row sits behind 'Show details', which opens by default in replay (verify-panel.tsx:155), and the Meaning text says to compare with 'the node it came from' (verify-panel.tsx:50). The precondition is control of the pack's files: write access to the served evidence/<runId>/ folder, or a pack handed to the reviewer.

### Source trace

1. **entrypoint** `packages/api-mock/src/evidence.ts:256` — `readIndex`: manifest.json from evidence/<runId>/ is pack content, written by whoever produced or altered the pack. It is parsed with BundleManifest, whose deployments record takes any number of entries, and the file's key order is kept.
2. **propagation** `packages/api-mock/src/evidence.ts:278` — `tenantOf`: In REPLAY the tenant keeps only the facility (chainId undefined), so an Anvil-recorded run of fac-mei is accepted.
3. **propagation** `packages/api-mock/src/evidence.ts:293` — `readEvidenceRun`: Requires only that manifest.deployments[contracts.deploymentId] is on contracts.chainId. Extra entries pass, and the parsed manifest is returned unchanged by evidenceBundle (:355).
4. **propagation** `packages/api/src/evidence/store.ts:97` — `readRun`: [second path] The live store pins the tenant deployment and chain but likewise checks only that the tenant's entry is present, so extra manifest entries also pass in live mode.
5. **propagation** `tools/verify-evidence/src/audit.ts:87` — `checkRows`: The verifier's only manifest-to-contracts binding is that contracts.json's deployment is present on its chain with the same addresses (:87-91). Other entries are not checked against anything here.
6. **propagation** `tools/verify-evidence/src/bundle.ts:311` — `explorerProblems`: Every other manifest entry is checked only for verifiedUrl being its own code page on its chain's pinned explorer. Real final-2 addresses with their exact Etherscan #code URLs pass.
7. **propagation** `apps/web/components/evidence/evidence-view.tsx:85` — `EvidenceView`: recorded is built from Object.values(b.manifest.deployments) in key order, not from the verifier's anchor, and is passed to VerifyPanel (:121).
8. **propagation** `apps/web/components/evidence/proof-model.ts:27` — `recordedLabel`: Takes chainIds[0], the first manifest entry, and returns 'Recorded on <chainName> · <day month>'.
9. **propagation** `apps/web/components/evidence/proof-model.ts:34` — `packStatus`: For a verified result, the label becomes the status line under the title 'Every check passed'.
10. **sink** `apps/web/components/evidence/verify-panel.tsx:128` — `VerifyPanel`: Renders the label (data-testid verify-recorded) directly under the green 'Every check passed' for a pack whose verified anchor is another chain.

### Evidence

- `tools/verify-evidence/src/anchor.ts:37`: The verified anchor chain is contracts.json's chainId, the value every row is checked against (audit.ts:98).
- `apps/web/components/evidence/anchor-section.tsx:40`: The same panel's anchor shows the bound chain (Anvil (local) · 31337), behind 'Show details', which opens by default in replay (verify-panel.tsx:155): the headline contradicts it.
- `apps/web/components/shell/mode-deployment.ts:21`: Sibling control: names no deployment when the manifest lists several. recordedLabel guesses the first.
- `packages/api/src/evidence/export.ts:176`: The exporter writes exactly one deployment (contracts.deploymentId), so several entries mean an altered or fabricated pack.
- `packages/core/src/schemas/evidence.ts:48`: BundleManifest.deployments is an open record of DeploymentId to entry. Nothing limits it to one entry.
- `tools/verify-evidence/src/index.ts:16`: The verifier states that ok means internal consistency only, that hashes.json is unkeyed, and that chain truth comes from the anchor, so any pack author can recompute hashes.json.
- `apps/web/components/evidence/evidence-view.tsx:39`: Versions links every manifest deployment's contracts on the pinned explorer in replay and live, including an entry the anchor does not name.
- `apps/web/components/evidence/proof-model.test.ts:37`: recordedLabel tests cover only single-chain arrays. No case has several deployments or an anchor that differs from the first entry.
- `evidence/ev-cdc4cc7916471c1e/manifest.json:5`: The committed REPLAY demo pack lists one Anvil deployment (final-meie4ba8c, chain 31337). evidence/ev-74756ea61a72ae7c/manifest.json:5 holds the real final-2 Sepolia entry an altered pack could prepend.

### Blockers

- Run-10 forbids target-controlled execution: macOS cannot enforce the required sandbox limits, and no promotion code exists. So verifyBundle was not run on ev-cdc4cc7916471c1e, or on a copy with a prepended final-2 Sepolia manifest entry and a recomputed hashes.json. Whether that copy returns ok:true is decisive for the green 'Every check passed' beside the false label. Source cannot settle it. Source does show that only audit.ts:87-91 and bundle.ts:311-316 read manifest.deployments, and that SUMMARY.md uses only runId and gitCommit. But the base pack's cryptographic, event-replay and SUMMARY byte-equality checks (index.ts:61-70) cannot be re-derived by hand.

### Bounded local validation

Run in an approved sandbox only: no network, empty environment, read-only target, scratch-only writes, low CPU, memory and time limits. (1) Copy evidence/ev-cdc4cc7916471c1e into scratch, keeping the folder name and runId. (2) Control: build the file map (text for .json/.md, bytes otherwise, as verify-panel.tsx loadAndVerify does) and run verifyBundle. Record ok, the failing checks if any, and anchor.chainId/deploymentId. Expect ok:true, 31337, final-meie4ba8c. (3) Rewrite manifest.json so deployments is {"final-2": <the exact final-2 entry from evidence/ev-74756ea61a72ae7c/manifest.json: chainId 11155111 and its four addresses with their https://sepolia.etherscan.io/address/<addr>#code verifiedUrl>, "final-meie4ba8c": <the original entry unchanged>}, with final-2 first. Replace hashes.json with hashesFileOf(files minus hashes.json). (4) Run verifyBundle again. Expect ok:true and the same anchor (31337, final-meie4ba8c). (5) Evaluate packStatus("verified", "replay", recordedLabel(Object.values(JSON.parse(manifest).deployments).map(d => d.chainId), "2026-10-18T15:44:45.175Z")).line. Expect 'Recorded on Sepolia · 18 Oct', against 'Recorded on Anvil (local) · 18 Oct' for the control. (6) Optional: render VerifyPanel with the copy's files (jsdom, session mode replay). Observe [data-testid=verify-recorded] reading 'Recorded on Sepolia · 18 Oct' while the anchor's Blockchain row reads 'Anvil (local) · 31337'. A step-4 result of ok:false refutes the green-headline claim.

## 4. settle-spend and reconcile lock waits can take the job lock ahead of the urgent relay of a Treasury.pause, so the relay's 30 s wait can run out

- **Fingerprint:** `apps/worker/src/runtime/job-locks.ts:JOB_LOCK_WAITS:urgent-relay-wake-unprioritized-behind-settle-reconcile-waiters`
- **Verifier:** `v-4` (independent, source-only)

### Claimed root cause

job-locks.ts adds two equal-priority, deadline-free waiters (settle-spend, reconcile) to the one shared advisory lock. lock.ts's wait loop has no priority or ordering. relay-wake.ts's 30 s bound still assumes that only one pass stands between a pending tighten-only row and the lock.

### Description

fix-cfo-load makes settle-spend and reconcile wait up to 20 s for the shared advisory job lock (JOB_LOCK_WAITS). They poll every 200 ms, the same way as the relay wake does while a tighten-only row is pending. That row is either the Treasury.pause any persona requests through POST /api/control/pause (the officer's emergency lever) or a veto's cancelLoosen. lock.ts gives no waiter priority: after each release, whichever waiter polls first wins. The relay's TIGHTEN_LOCK_WAIT_MS (30 s) was sized for one pass ahead of it (a cfo-guard pass, 10 s). Now suppose the minute's first holder is a job that does not relay: reconcile, record-sale, or the 10- or 20-minute cfo-guard, stage-gate or autonomous-tick. If it releases within the waiters' 20 s, settle-spend and/or reconcile can win the next acquisitions, and neither has a pass deadline. If a pass that starts behind that holder ends after the relay's 30 s bound (in practice a pass of at least about 10 s), relayWake returns ran:false and the pause is not signed on that wake. Before this range those two jobs skipped at once, so the relay ran right after the single holder. The delay is bounded, not permanent. The relay cron retries every minute, with the same race. agent-actions and timelock-executor also relay pending rows at the end of their own passes (app.ts:225, 230). While the pause is late, the agent can keep signing payments the on-chain policy allows: agent-actions signs its own batch before its runRelay, and autonomous-tick does not relay. So the change weakens a pause the route calls instant (control.ts:2). The cancelLoosen case is narrower. The veto marks the exception CANCELLED first, so the worker never queues its executeLoosen (timelock-executor.ts:29). Only an outside executeLoosen after executableAt can overtake a late cancel. That needs a short timelock (120 s in the labelled demo, 24 h in production), and sync-veto records it as an ALERT. Whether a miss happens depends on real pass durations, which source does not show. Suggested fix: give tighten-only relays precedence. For example, settle-spend and reconcile skip their tryLock while hasPendingTighten is true (checked on their own pooled connection each poll). Alternatively, size TIGHTEN_LOCK_WAIT_MS to cover a holder plus both waiters and give settle-spend and reconcile a pass deadline like cfo-guard's. Add a fake-timer test that starts the three waiters behind one holder.

### Source trace

1. **entrypoint** `packages/api/src/routes/control.ts:25` — `pause (POST /api/control/pause)`: Any persona (the officer's emergency lever) inserts an unsigned PENDING Treasury.pause row and wakes the relay queue (line 29). No DB halt is written: only the on-chain pause stops agent payments. A veto does the same for Treasury.cancelLoosen (exceptions.ts:165,168).
2. **propagation** `apps/worker/src/runtime/app.ts:218` — `createWorkerApp relay handler`: The relay queue's handler (woken by the API or by its every-minute cron, config/env.ts:79) calls relayWake.
3. **propagation** `apps/worker/src/runtime/relay-wake.ts:28` — `relayWake`: A pending tighten-only row (TIGHTEN_KINDS, relay-calls.ts:335) makes the wake urgent. It waits up to TIGHTEN_LOCK_WAIT_MS = 30_000 ms (line 16), polling every 200 ms.
4. **propagation** `apps/worker/src/runtime/job-locks.ts:29` — `JOB_LOCK_WAITS`: New in this range: settle-spend and reconcile also wait up to SAME_MINUTE_LOCK_WAIT_MS = 20_000 ms instead of skipping. lockedJob passes the wait at line 44.
5. **propagation** `apps/worker/src/runtime/app.ts:215` — `createWorkerApp handlers`: reconcile (215) and settle-spend (216) are built through lockedJob with those waits. Both fire every minute by default, like the relay (config/env.ts:77-79).
6. **propagation** `apps/worker/src/runtime/lock.ts:46` — `withJobLock wait loop`: Each waiter sleeps pollMs (200 ms) and retries pg_try_advisory_lock. There is no ordering or priority, so the first poll after a release wins.
7. **propagation** `apps/worker/src/jobs/settle.ts:387` — `runSettle`: A settle-spend pass has no wall-clock deadline (nor does runReconcile, reconcile.ts:160; contrast CFO_GUARD_DEADLINE_MS, cfo-guard.ts:67). A waiter that wins holds the lock for its full pass.
8. **sink** `apps/worker/src/runtime/relay-wake.ts:42` — `relayWake result`: After 30 s without the lock, withJobLock logs job_skipped_lock_busy and returns ran:false (lock.ts:51-53). The wake returns ran:false, and the pending Treasury.pause (or cancelLoosen) is not signed until a later relay, agent-actions or timelock-executor pass gets the lock.

### Evidence

- `apps/worker/src/runtime/relay-wake.ts:15`: The bound is documented as longer than a cfo-guard pass (10 s, sends included): sized for one holder ahead of the relay.
- `apps/worker/src/runtime/job-locks.ts:8`: The 20 s wait is justified as longer than another job's usual pass. This is the same single-pass reasoning, with no analysis of the relay competing with these waiters.
- `apps/worker/src/runtime/job-locks.ts:12`: The pool-budget note admits three concurrent waiters (settle-spend, reconcile, relay wake), but nothing orders them.
- `docs/decisions/fix-cfo-load.md:67`: The design decision says the relay wake keeps its own 30 s wait. It does not mention precedence over the two new waiters.
- `apps/worker/src/jobs/cfo-guard.ts:67`: Only cfo-guard has a pass deadline (10 s). settle-spend and reconcile, now waiters, have none.
- `apps/worker/src/jobs/relay.ts:164`: hasPendingTighten exists and could gate the other waiters, but only relay-wake.ts (lines 28, 37) uses it.
- `apps/worker/test/unit/job-locks.test.ts:73`: The relay is counted as a waiter only for the pool budget. No unit or live test (job-lock.live.test.ts, relay-wake.live.test.ts) runs the urgent relay against settle-spend and reconcile waiters.
- `apps/worker/src/runtime/app.ts:230`: Partial mitigation: agent-actions (and timelock-executor at line 225) run runRelay after their own pass, so they also sign a pending pause. agent-actions does this only after runAgentActions has signed its batch (line 229). A miss therefore needs the lock to pass from a holder that does not relay to settle-spend and/or reconcile.
- `packages/api/src/routes/control.ts:2`: The pause is documented as tighten-only and instant. It writes only the chain_actions row and the wake, with no DB halt, so agent payments continue until the relay signs it.
- `apps/worker/src/jobs/timelock-executor.ts:29`: Limits the cancelLoosen impact: the worker queues executeLoosen only for QUEUED/EXECUTABLE exceptions, and the veto sets CANCELLED first (exceptions.ts:162). Only an outside executeLoosen can overtake a late cancel.
- `contracts/src/TreasuryGovernance.sol:128`: executeLoosen is open to anyone from executableAt. With the 120 s demo timelock (DeployFinal.s.sol:26; 24 h in production), a cancelLoosen delayed past it can be overtaken; sync-veto.ts:7-9 records this as an ALERT, not a halt.

### Blockers

- This run allows no target-controlled execution: the macOS host cannot enforce the required sandbox limits, and no promotion code exists. So the interleaving of three waiters behind one holder cannot be reproduced, not even with a fake-timer unit test.
- Whether a pause actually misses its wake depends on deployment-only timing that source does not fix. First, the real pass durations of the minute's first holder, settle-spend and reconcile on Sepolia through the configured RPC: a miss needs a settle-spend or reconcile pass that starts behind a holder shorter than 20 s and ends after the relay's 30 s bound. Second, the pg-boss fetch phase (pollingIntervalSeconds 2, boss.ts:40), which decides which handlers wait at the same time and who polls first after each release.

### Bounded local validation

In an approved sandbox, write a vitest unit test with fake timers (no DB, no network), in the style of job-locks.test.ts. Use one shared in-memory fake lock: pg_try_advisory_lock succeeds only while no holder is set, and pg_advisory_unlock clears it. Pass a JobDeps stub whose db.$client is the fake pool. Mock ../jobs/relay: hasPendingTighten returns true, then false after the first runRelay, and runRelay records the fake time it ran. At t=0, withJobLock('record-sale') takes the lock with a body that resolves at 4,210 ms. Also at t=0, start relayWake with the defaults (30,000 / 200 ms). Start lockedJob('settle-spend') at t=50 ms with a 12,000 ms body and lockedJob('reconcile') at t=100 ms with a 16,000 ms body. Advance 31,000 ms. If the candidate holds: settle-spend runs at about 4,250 ms and reconcile at about 16,300 ms. relayWake returns {ran:false} and logs job_skipped_lock_busy {job:'relay', waitedMs >= 30000}, and runRelay is never called. Control run with a precedence fix (settle-spend and reconcile skip their tryLock while hasPendingTighten is true): relayWake runs at about 4,400 ms and both waiters run after it.

### Owner-observed deployment check

Owner-observed and read-only, with no audit traffic and no pause or veto sent for the check. In the final-2 worker logs, find job_skipped_lock_busy lines with job=relay and waitedMs >= 30000, and job_lock_waited lines for settle-spend and reconcile in the same minute. Measure each waiting job's pass duration from its job_lock_waited line to its reconcile_done or settle_done line, or to its heartbeat write. For each Treasury.pause and Treasury.cancelLoosen chain_actions row, compare created_at with the time of its TX trace ('signed by the ... key at nonce ... and broadcast') to get the real relay latency. Flag any latency above 30 s, and note which job held the lock first in that minute.

## 5. The mock Sample business switch lets any caller rebuild the shared demo store, bypassing the officer-only demo reset

- **Fingerprint:** `packages/api-mock/src/demo-data.ts:registerDemoData:sample-business-switch-no-operator-gate`
- **Verifier:** `v-5` (independent, source-only)

### Claimed root cause

The switch's only gates are DEMO_MODE, REPLAY/country and the body shape, and it never resolves a persona. The ux2-demo-data decision lets 'either persona' switch, on the premise that the same-origin guard covers the POST. That premise only addresses cross-site pages. In the mock, every caller without a valid officer cookie is the founder, so 'either persona' means any caller, including any other visitor of a shared demo. A parallel route with the same store-rebuild effect therefore bypasses the G0-REVIEW M14 rule that destructive demo routes are officer-only.

### Description

In mock mode with DEMO_MODE=1 (dev:mock forces both), POST /api/demo/sample-business is a raw Hono route registered after the contract routes and outside register(), so no persona is ever resolved for it. Its only gates are DEMO_MODE (404), REPLAY or a non-SG country (409) and a body of exactly {"on":boolean} up to 256 bytes (422). It then calls resetState(env, 'lived'|'fresh'). That is the same rebuild of the module-global store that the officer-only POST /api/demo/reset performs (handlers-ops.ts:190-191). The rebuild discards everything done since the store was built, for every viewer of the process: orders, signature requests, exceptions and officer approvals, founder keys enrolled in the browser, chat sessions and traces. It also switches every viewer between the sample business and a fresh start. The web UI offers the switch to every visitor: SampleBusinessRow sits in the quick settings (quick-settings.tsx:69) and on Settings, while 'Reset the demo' is shown to the officer only (demo-section.tsx:114). On a mock demo, any visitor without a valid officer cookie is the founder. So on a shared mock demo reached through a tunnel or reverse proxy whose hostname is in HOGEE_ALLOWED_HOSTS (project.md:944), any visitor can wipe the demo another reviewer is using. They can do it from the page itself (a same-origin POST, which the guard accepts) or with any HTTP client that sends neither Origin nor Sec-Fetch-Site. The same caller gets 403 from /api/demo/reset. Cross-site pages are refused by rejectUntrustedRequest. dev:mock binds to localhost only (dev-mock.mjs:46), so a demo used only by its local operator is not affected. Smallest fix: gate the POST like demoReset (personaOf(c, env) === 'officer', else 403) and show the toggle only to the officer. A loopback-Host check alone is weaker, because a tunnel that rewrites Host to localhost defeats it. Regression test: a POST with no cookie answers 403, and GET /api/plans/current is unchanged afterwards.

### Source trace

1. **entrypoint** `apps/web/app/api/[...route]/route.ts:42` — `guarded`: Every /api request from any client that reaches the process goes through rejectUntrustedRequest and then to the mock app (mode mock: route.ts:38).
2. **propagation** `packages/api/src/request-guard.ts:62` — `rejectUntrustedRequest`: Once Host is in the allow-list (:56), a POST with Sec-Fetch-Site same-origin/none (:59) and Origin equal to Host (:61), or with neither header, returns null. Both the hosted page's own same-origin POST and a header-less client pass.
3. **propagation** `packages/api-mock/src/index.ts:33` — `app setup`: registerDemoData adds the switch as raw app.get/app.post after the register() loop (:31), which is where personas are enforced.
4. **propagation** `packages/api-mock/src/demo-data.ts:54` — `registerDemoData POST`: The only checks are DEMO_MODE (:56), REPLAY/country (:57-58) and the strict {on:boolean} body of at most 256 bytes (:59-60). No persona or operator check.
5. **propagation** `packages/api-mock/src/demo-data.ts:61` — `registerDemoData POST`: Calls resetState(env, body.on ? 'lived' : 'fresh').
6. **sink** `packages/api-mock/src/store.ts:226` — `resetState`: Records the chosen scenario for every caller (:225), drops the module-global state (:161), and getState rebuilds it from the seed (:227). Everything done since the last build is discarded for every viewer of the process.

### Evidence

- `packages/api-contract/src/routes.ts:360`: demoReset is declared with personas: OFFICER.
- `docs/G0-DECISIONS.md:140`: M14: the persona cookie was unauthenticated, so destructive demo routes are officer-only.
- `packages/api-mock/src/handlers-ops.ts:191`: The mock's demoReset handler is just resetState(env), the same effect the switch has.
- `packages/api-mock/src/http.ts:112`: Persona enforcement exists only inside register(), and the switch never goes through it.
- `packages/api-mock/src/http.ts:59`: Without a valid officer cookie every caller is the founder (no secret: founder at :57), so a founder-or-officer rule admits anyone.
- `packages/api-mock/src/demo-data.ts:10`: Source comment: either persona may switch, unlike officer-only demoReset, and the web's same-origin guard is in front.
- `docs/decisions/ux2-demo-data.md:51`: Design rule: either persona, because it only rebuilds the mock's memory and the same-origin guard covers the POST.
- `apps/web/components/settings/quick-settings.tsx:69`: SampleBusinessRow (the DemoDataToggle) is in every visitor's quick settings. Reset the demo is officer-only (demo-section.tsx:114).
- `apps/web/components/settings/demo-data-toggle.tsx:49`: The UI's switch is a same-origin POST of {on}, which the guard accepts from any visitor's browser.
- `apps/web/scripts/dev-mock.mjs:46`: dev:mock binds to localhost, so a non-operator can reach it only through a tunnel or reverse proxy.
- `project.md:944`: Operators are told to add any tunnel or hosted hostname to HOGEE_ALLOWED_HOSTS, and that a POST with neither header passes.
- `packages/api/src/request-guard.ts:10`: The guard's own comment: a POST with neither header passes (non-browser clients).

### Blockers

- Run 10 allows no target-controlled execution, so the cookie-less POST being accepted, the rebuilt store and the 403 from demoReset were not observed locally.
- Deployment fact, not source-visible: whether any judged or shared mock demo (MOCK_API=1, DEMO_MODE=1) is reachable by anyone other than its operator. That means a tunnel or reverse proxy in front of the localhost-bound process with its hostname in HOGEE_ALLOWED_HOSTS, with more than one reviewer sharing one process.
- Owner policy: docs/decisions/ux2-demo-data.md:51 allows either persona on purpose. The owner must say whether every visitor of a shared hosted demo is an intended operator of the switch. If so, this is intended behavior and should be rejected.

### Bounded local validation

In a sandboxed vitest harness with no network, import @hogee/api-mock's app with DEMO_MODE=1, MOCK_API=1, MOCK_SCENARIO=lived, HOGEE_COUNTRY=SG, REPLAY unset, and random 64-hex PERSONA_COOKIE_SECRET and OFFICER_TOKEN. (1) GET /api/plans/current, expect 200. (2) POST /api/demo/sample-business with content-type application/json and body {"on":false}, no cookie: expect 200 {ok:true,on:false,scenario:'fresh'}. (3) GET /api/plans/current, expect 404 NOT_FOUND. (4) POST /api/demo/reset with no cookie, expect 403 FORBIDDEN. (5) Through route.ts's guarded handler with HOGEE_ALLOWED_HOSTS=demo.example.test, send POST /api/demo/sample-business with Host demo.example.test: (a) no Origin or Sec-Fetch-Site, expect it to pass the guard; (b) Sec-Fetch-Site same-origin and Origin http://demo.example.test, expect it to pass; (c) Sec-Fetch-Site cross-site, expect 403. Stop there.

### Owner-observed deployment check

The owner checks, for every judged or shared demo, the start command and its MOCK_API, DEMO_MODE and HOGEE_ALLOWED_HOSTS values. They check whether a tunnel or reverse proxy lets anyone other than the operator reach that process, and whether more than one reviewer uses the same process at once. The owner then confirms whether any such visitor is meant to be able to rebuild the shared store. No audit traffic.

## 6. Cross-site or remote GETs of unseen chat ids use up the lived scenario's 200 seeded histories, so later new sessions start without the sample history

- **Fingerprint:** `packages/api-mock/src/store.ts:seededChat:get-seeds-shared-capped-history`
- **Verifier:** `v-6` (independent, source-only)

### Claimed root cause

seededChat makes GET /api/chat/:sessionId a state-creating call that spends one store-wide budget (MAX_SEEDED_CHATS, reset only by a store rebuild). This breaks the request guard's premise that GET routes are reads (routes.test.ts:62), so a caller the guard would refuse for state-changing methods can still spend the bound that was meant to protect memory and so deny the sample history to later sessions.

### Description

This range changed getChat (GET /api/chat/:sessionId) from st.chats.get to seededChat (handlers-core.ts:104). In the lived scenario, which dev:mock serves by default (dev-mock.mjs:19), every unseen session id now creates and stores a 5-message session. Each one counts against MAX_SEEDED_CHATS = 200 (store.ts:231), a single counter for the whole store that every caller shares (scenario-lived/index.ts:61). Only a store rebuild resets it. The route has no persona gate and is not demoOnly (http.ts:110-112). SessionId accepts any well-formed lowercase UUIDv7 (primitives.ts:129), so a caller can mint as many fresh ids as it likes. The request guard checks only Host for GET (request-guard.ts:57), because the design assumes every GET is a read (routes.test.ts:62). That means a caller whose POSTs the guard refuses can still spend the counter. One example is a cross-site page in the reviewer's browser sending 200 no-cors fetch or img GETs to http://localhost:3000 with fresh ids: the Host stays localhost:3000, which the allow-list accepts. On a mock demo that non-operators can reach, a direct caller can do the same. POSTs to /api/chat also seed through journey session() (journey/index.ts:77), but only a non-browser or same-origin caller can send them. Once the counter is spent, seededChat returns undefined and getChat answers 404. chat-view shows a 404 as a new, empty conversation (chat-view.tsx:132). The first POST then creates an empty session at turn 0 (journey/index.ts:78-80). This hits every new session after exhaustion: a new browser, or 'Clear this chat' (chat-view.tsx:111). Such a session lacks the WELCOME_BACK line saying the sales, payments and orders are made up (story.ts:122) and the sample's order cards. Its journey facts carry no terms or order, because they are read from the session's history (journey/index.ts:105, journey/facts.ts:38). So the chat's next-step guidance no longer matches the sample business the store holds. Sessions seeded before exhaustion are unaffected. The quick settings still label mock data 'Sample data' (mode-deployment.ts:35), so the disclosure is not lost everywhere. The Sample business switch rebuilds the store and resets the counter (demo-data.ts:61), and so do the officer's reset and a process restart. A session started right after a switch is therefore affected only if the counter is spent again after the rebuild, for example by an attacking page still open and repeating. Memory stays bounded (200 sessions of 5 messages each). The impact is limited to the integrity and availability of the demo chat a reviewer sees, with easy recovery. Smallest fix: make GET read-only again. For an unseen id, return the sample transcript without storing or counting it, and create the session on its first POST, or count only POST-created sessions. Regression test: after 200 GETs of fresh ids, a further fresh id still returns the 5-message history and st.chats has not grown.

### Source trace

1. **entrypoint** `apps/web/app/api/[...route]/route.ts:42` — `guarded`: GET /api/chat/:sessionId reaches the mounted mock app (MOCK_API=1) only after rejectUntrustedRequest returns null.
2. **propagation** `packages/api/src/request-guard.ts:57` — `rejectUntrustedRequest`: After the Host allow-list check at :56, safe methods (GET/HEAD/OPTIONS) return null with no Sec-Fetch-Site or Origin check (those run only at :58-61).
3. **propagation** `packages/api-mock/src/http.ts:118` — `register handler`: getChat has no personas and no demoOnly, so :110-112 do not refuse it. The params pass SessionIdParams, the lived store is readied, and the handler runs at :122.
4. **propagation** `packages/api-mock/src/handlers-core.ts:104` — `getChat`: Changed in this range from st.chats.get to seededChat(st, sessionId). An undefined result answers 404 NOT_FOUND (:105).
5. **sink** `packages/api-mock/src/store.ts:241` — `seededChat`: For an unseen id, while sample.seededChats < 200 (:240), the shared counter is incremented and a 5-message session is stored (:242-243). Once the cap is reached, every unseen id gets undefined.

### Evidence

- `packages/api-mock/src/store.ts:231`: MAX_SEEDED_CHATS = 200 for the whole store, shared by every caller.
- `packages/api-mock/src/scenario-lived/index.ts:61`: seededChats starts at 0 only when a lived store is built. Nothing else resets it.
- `packages/api-mock/src/demo-data.ts:61`: The Sample business switch calls resetState, which builds a new lived store with a fresh counter. The switch therefore restores seeding, and recovery needs a rebuild (the switch, the officer reset or a restart).
- `packages/api-contract/test/routes.test.ts:62`: Design invariant: the /api guard skips the Origin and Sec-Fetch-Site checks for GET, so a GET must be a read. seededChat breaks this.
- `packages/core/src/schemas/primitives.ts:129`: SessionId is any well-formed lowercase UUIDv7, so a caller can mint unlimited fresh ids.
- `packages/api-mock/src/journey/index.ts:77`: POST /api/chat also seeds through session() -> seededChat. After the cap, a new session is created empty at turn 0 (:78-80).
- `packages/api-mock/src/journey/index.ts:105`: Journey facts are built from the session's history (seeded messages plus the new ones). With no seed, the history is empty.
- `packages/api-mock/src/journey/facts.ts:38`: The session's terms and order come only from the termsIds in its history, so an unseeded session's journey has no terms and no order.
- `apps/web/components/chat/chat-view.tsx:132`: A 404 from getChat is shown as a new, empty conversation.
- `apps/web/lib/chat-session.ts:31`: A browser without a stored id (a new browser) mints a new UUIDv7 session id. 'Clear this chat' and the switch mint one through resetChatSessionId (:40-41).
- `apps/web/components/settings/demo-data-toggle.tsx:94`: After a switch, the web starts a new chat session id, which is seeded from the rebuilt store's fresh counter unless the counter is spent again.
- `packages/api-mock/src/scenario-lived/story.ts:122`: The seeded first line is the sample's statement that the sales, payments and orders are made up.
- `apps/web/scripts/dev-mock.mjs:19`: dev:mock serves the lived scenario by default for SG without REPLAY. It binds to localhost (:46), so remote reach needs hosting or a tunnel.

### Blockers

- Run 10 allows no target-controlled execution, so cap exhaustion and the 404 for the next unseen id were not observed locally. Source shows the logic deterministically (store.ts:240-243, handlers-core.ts:104-105).
- Browser fact, decisive for the cross-site variant (the only variant in which the guard's GET exemption gives a lower-trust caller something it lacks against a localhost demo): whether a public page in the reviewer's browser can send no-cors fetch, img or iframe GETs to http://localhost:3000 without the user's consent. This covers the Chrome Local Network Access permission prompt, Firefox and Safari behaviour, and mixed-content treatment of http://localhost from an https page. Source does not show it.
- Deployment fact, decisive for the remote variant: whether any DEMO_MODE=1 lived mock is reachable by non-operators (hosted or tunnelled). dev:mock binds to localhost and the deployment's environment is not source-visible.

### Bounded local validation

In a sandboxed vitest harness that imports @hogee/api-mock's app with DEMO_MODE=1, MOCK_API=1, MOCK_SCENARIO=lived, HOGEE_COUNTRY=SG and no REPLAY, call app.request('/api/chat/<id>') for 200 distinct fresh lowercase UUIDv7 ids. Expect each to answer 200 with 5 messages. Then GET a 201st fresh id and expect 404 NOT_FOUND. POST /api/chat with that id and the text 'hi', then GET it and expect no WELCOME_BACK message. Next, POST /api/demo/sample-business with body {"on":true} and no Origin header, and expect a further fresh id to return 5 messages again. Separately, call rejectUntrustedRequest(new Request('http://localhost:3000/api/chat/<id>', {method:'GET', headers:{host:'localhost:3000', origin:'https://attacker.example', 'sec-fetch-site':'cross-site'}}), parseAllowedHosts(undefined)) and expect null.

### Owner-observed deployment check

The owner checks, without any audit traffic, which browsers and versions the reviewers will use and whether those browsers block or prompt on a public page's subresource GETs to http://localhost:3000. The owner also checks whether any DEMO_MODE=1 mock demo is hosted or tunnelled beyond the operator's own machine.
