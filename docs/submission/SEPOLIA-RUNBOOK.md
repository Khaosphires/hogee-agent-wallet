# Hogee: Sepolia runbook

How to put Hogee on Sepolia and collect the evidence, in order. Every command sits in its own block, ready to paste into the Terminal panel. Nothing here prints a secret.

| Field | Value |
|---|---|
| Chain | Ethereum Sepolia (chain id 11155111) |
| Deployments | `final-1` for the red team, then `final-2` for Mei's chat journey |
| Written | 19 Oct 2026, from the scripts on `main` `db731b0` |
| Fills | Every Sepolia placeholder in [EXECUTION-EVIDENCE.md](EXECUTION-EVIDENCE.md) and the other drafts (section 10) |
| Status (19 Oct) | `final-1` deployed and `VerifyFinal` passed; its PlanRegistry, Treasury, MilestoneEscrow and SalesOracle show "Source Code Verified" on Sepolia Etherscan (checked 20 Oct; addresses in EXECUTION-EVIDENCE §02). Its red-team run is done: 45 pass, 0 fail, 2 not run. `final-2` is deployed and verified the same way, and Mei's chat run on it is done: bundle `ev-74756ea61a72ae7c` verifies online |

---

## 0. Read this first

**Two deployments, not one.** A Treasury holds exactly one facility record (`Treasury.facility()`), and the API refuses to open it twice. The red team on `final-1` opens that facility for Rina (Malaysia). It ends by pausing the treasury and revoking the agent key. Its preflight also refuses a Treasury whose facility is already open, and a database that holds any facility. So Mei's chat journey needs its own deployment, `final-2`.

**Never run the two at the same time.** Both sign with the same `*_PRIVATE_KEY_FINAL` keys (the worker picks the FINAL set for any `final-*` deployment). Each run keeps its own nonce counter in its own database, so overlapping runs would collide. Finish the red team, then start `final-2`.

**No `loop-1`.** Nothing reads a `loop-1` deployment: `VerifyFinal` checks only the `final-*` set it is given, and the red team reads only a `final-*` manifest.

**ETH.** Not a blocker any more: the faucets gave 5.155 Sepolia ETH (19 Oct).

- The floor set by the code is about 0.22 ETH. The red team needs at least 0.05 ETH on each of the four FINAL keys (`MIN_SEPOLIA_GAS_WEI` in `scripts/redteam/src/safety.ts`), and the deploy script needs at least 0.02 ETH on the deployer.
- One deploy is about 95M gas (the deploy script's measurement on a Sepolia copy, 19 Oct). At about 15 wei per gas that is under 0.0001 ETH, so `final-2` costs almost nothing.
- `hogee-fund-wallets.sh` now tops each FINAL key up to 0.25 ETH and keeps 0.5 ETH on the deployer. From empty wallets that needs 4 × 0.25 + 0.5 + 0.01 = 1.51 ETH. The extra is headroom for a gas spike during the 2–3 hour run; the deployer's 0.5 ETH covers a deploy at up to about 5 gwei.
- Check `cast gas-price` before each deploy (section 1).

**Who types what.**

| Secret or step | Who | Where |
|---|---|---|
| Deployer keystore password | You | forge asks for it (hidden) during each deploy |
| Founder passkey (Touch ID) | You, as Mei | in the browser: passkey registration and every inline signature |
| Officer access code | You, as the officer | the persona switch in the web app; it is your `OFFICER_TOKEN` (open `hogee/.env` yourself; never paste it in a chat) |
| Mei's one-time enrolment code | You, as the officer, then as Mei | the officer console creates it; Mei types it when registering a passkey |

**How the commands read `hogee/.env`.** Node's `--env-file` loads it into the process without printing it. A value set on the command line wins over the file. Run these commands yourself in the Terminal panel; an assistant must not open `.env`.

---

## 1. Preflight checks

Put Foundry and Postgres on the path in each new terminal tab.

```bash
export PATH="$HOME/.foundry/bin:/opt/homebrew/bin:$PATH" LC_ALL=C LANG=C
```

The public RPC serves Sepolia. Expect `11155111`.

```bash
cast chain-id --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

The gas price, in wei. Below 5000000000 (5 gwei) the funded amounts are enough.

```bash
cast gas-price --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

The balances. The funding script prints every balance first, then sends only shortfalls (it asks for the deployer password only if it must send).

```bash
bash ~/Desktop/Fintechathon/scripts/hogee-fund-wallets.sh
```

The repo is on `main` with nothing uncommitted, and the contracts build.

```bash
cd ~/Desktop/Fintechathon/hogee && git status --short && git log --oneline -1
```

```bash
cd ~/Desktop/Fintechathon/hogee/contracts && forge build
```

No manifest exists yet (the deploy script refuses to deploy twice).

```bash
ls ~/Desktop/Fintechathon/hogee/packages/chain/deployments/
```

Keep the Mac plugged in and awake. The long commands below run under `caffeinate`.

---

## 2. Deploy `final-1` (you type the password)

```bash
bash ~/Desktop/Fintechathon/scripts/hogee-deploy-final.sh
```

1. Check the summary it prints, then type `yes`.
2. forge asks for the **deployer keystore password**. Type it. Nobody else sees it.
3. The script deploys PlanRegistry, Treasury (which creates TreasuryGovernance), MilestoneEscrow and SalesOracle. It runs the read-only `VerifyFinal` against the chain and saves the manifest only if that passes.

What it uses:

- `COOLING_SECONDS=120` and `LOOSEN_TIMELOCK_SECONDS=120` (labelled demo values; a production deploy would use 86400 for both). See section 11.
- The lender and oracle are the FINAL keys' public addresses from `docs/wallet-addresses.md`.
- The platform payees of both countries (Rina's DuitNow and Mei's PayNow payees), from `platformPayeeDeployArgs(ALL_DEMO_PAYEES)`, the same code the red team uses.
- A gas multiplier of 800 %, because forge simulates with older gas rules than Sepolia now runs.

What it writes:

- the manifest `packages/chain/deployments/sepolia-final-1.json`;
- the log `~/Desktop/Fintechathon/docs/sepolia-final-1-deploy.log`.

`VerifyFinal` checks the chain id, that each contract has code, every link between them, the lender, oracle and observer, the deployment id and chain tag, the cooling and the timelock. It does not compare the platform payout hashes; the API checks those when a facility opens.

---

## 3. Verify the sources on Etherscan

The script ends with one Etherscan link per contract. Open each one and add `#code`. Expect "Contract Source Code Verified".

- If forge's verification failed, the script says "forge exited … after broadcasting". The deploy still stands: `VerifyFinal` already checked it on the chain. Tell P1, who verifies the missing ones.
- TreasuryGovernance is created inside Treasury's constructor, so forge's `--verify` may not cover it. Check its link too.

---

## 4. Run the red team on `final-1` (2–3 hours)

You do **not** start a separate worker for this. The runner runs the API and the worker's jobs inside its own process, signing with the FINAL keys. It uses a software passkey and a scripted model, so it calls no paid model API. Start nothing else that signs with the FINAL keys until it ends.

**4a. A dedicated, empty database.**

```bash
mkdir -p ~/hogee-sepolia/redteam && initdb -D ~/hogee-sepolia/redteam/pg -U hogee --auth=trust
```

```bash
pg_ctl -D ~/hogee-sepolia/redteam/pg -o "-p 55701 -k /tmp -c listen_addresses=127.0.0.1" -l ~/hogee-sepolia/redteam/pg.log start
```

```bash
createdb -h 127.0.0.1 -p 55701 -U hogee hogee
```

**4b. The run.** It reads `SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL_FALLBACK` and `AGENT_PRIVATE_KEY_FINAL`, `ORACLE_PRIVATE_KEY_FINAL`, `LENDER_PRIVATE_KEY_FINAL`, `RELAYER_PRIVATE_KEY_FINAL` from `hogee/.env`. The settings on the command line pin the mock payout rail and Rina's ids.

```bash
cd ~/Desktop/Fintechathon/hogee/scripts/redteam && PAYOUT_RAIL=mock HOGEE_FACILITY_ID=fac-rina HOGEE_FOUNDER_ID=founder-rina caffeinate -i node --env-file=../../.env --import tsx src/cli.ts --target sepolia --database-url postgres://hogee@127.0.0.1:55701/hogee
```

This is the same as `pnpm --filter @hogee/redteam start -- --target sepolia`, with `.env` loaded.

**Before any write, the preflight stops the run if:** the RPC is not on the manifest's chain; the final-1 facility is already open; the database holds any facility; the worker is halted; or a FINAL key holds less than 0.05 ETH. Each message names the problem. Fix it and run again.

**What to expect.** One line per case, then a summary:

- `rows: …; pass …, fail 0, not run …` and exit code 0.
- Not run on Sepolia, by design: T22 (needs ±1 s timing), T15's AgentExpired variant (needs a 60-day clock jump), the API-side expiry probe of T16, the Singapore variants of T1 and T4, and the 22 WEB cases (one facility per deployment, so the Mei web world runs on Anvil only). T33's main-world row has no query path, so it stays not run here; T33 is a real case only as a WEB variant, on Anvil.
- `evidence main: verified <path>`: the bundle to submit.

Sepolia waits real time: 2 minutes of cooling and timelock each time, and about 13 minutes for finality per settlement round.

---

## 5. Collect and verify the red-team bundle

The runner writes `evidence/<run-id>/`. Its own rows, with a task id on each, are in `evidence/<run-id>/evidence.json`. The verifiable bundle is `evidence/<run-id>/export/main/<ev-id>/`, the path the runner printed. `make evidence` cannot rebuild that bundle, because the runner's plans use the test country pack.

Check it offline. Exit code 0 means verified.

```bash
cd ~/Desktop/Fintechathon/hogee && make verify BUNDLE=evidence/<run-id>/export/main/<ev-id>
```

Check it against the chain. The public RPC has no key, so nothing secret enters the environment.

```bash
cd ~/Desktop/Fintechathon/hogee && HOGEE_VERIFY_RPC=https://ethereum-sepolia-rpc.publicnode.com make verify BUNDLE=evidence/<run-id>/export/main/<ev-id>
```

List each task's transactions, to fill the tables (task id, layer, outcome, tx hash).

```bash
cd ~/Desktop/Fintechathon/hogee && jq -r '.[] | select(.txHash) | [.taskId, .layer, .outcome, .txHash] | @tsv' evidence/<run-id>/evidence.json
```

Keep the whole run folder. The runner already scanned it for every secret it loaded or made.

```bash
cd ~/Desktop/Fintechathon/hogee && git add -f evidence/<run-id>
```

Stop the red-team database once the bundle is committed.

```bash
pg_ctl -D ~/hogee-sepolia/redteam/pg stop
```

---

## 6. Deploy `final-2` (after the red team has finished)

**Needs one P1 change first.** `hogee-deploy-final.sh` always deploys `final-1` and refuses once `sepolia-final-1.json` exists. P1 adds a `HOGEE_DEPLOYMENT_ID` setting, only after your STEPS 7 run has finished (section 12 has the exact change). Then:

```bash
HOGEE_DEPLOYMENT_ID=final-2 bash ~/Desktop/Fintechathon/scripts/hogee-deploy-final.sh
```

Type `yes`, then the deployer password. It writes `packages/chain/deployments/sepolia-final-2.json` and the log `docs/sepolia-final-2-deploy.log`, then check its links on Etherscan as in section 3.

Top the FINAL keys up again. It sends only shortfalls.

```bash
bash ~/Desktop/Fintechathon/scripts/hogee-fund-wallets.sh
```

---

## 7. Start the worker and the web app against `final-2`

**Before you start:**

- The checkout must contain the chat revamp (merged into `main`).
- No other `next dev` may run from the same `apps/web`; stop `hogee-demo` and `hogee-live` first.

**7a. A second dedicated, empty database, migrated.**

```bash
mkdir -p ~/hogee-sepolia/journey && initdb -D ~/hogee-sepolia/journey/pg -U hogee --auth=trust
```

```bash
pg_ctl -D ~/hogee-sepolia/journey/pg -o "-p 55702 -k /tmp -c listen_addresses=127.0.0.1" -l ~/hogee-sepolia/journey/pg.log start
```

```bash
createdb -h 127.0.0.1 -p 55702 -U hogee hogee
```

```bash
cd ~/Desktop/Fintechathon/hogee && DATABASE_URL=postgres://hogee@127.0.0.1:55702/hogee pnpm --filter @hogee/db db:migrate
```

**7b. The worker (terminal tab 1).** It is the only signer. It migrates its own schema at start.

```bash
cd ~/Desktop/Fintechathon/hogee/apps/worker && CHAIN=sepolia DEPLOYMENT_ID=final-2 DEPLOYMENT_FILE="$HOME/Desktop/Fintechathon/hogee/packages/chain/deployments/sepolia-final-2.json" DATABASE_URL=postgres://hogee@127.0.0.1:55702/hogee PAYOUT_RAIL=mock HOGEE_DATA_DIR="$HOME/Desktop/Fintechathon/hogee/data" caffeinate -i node --env-file=../../.env --import tsx src/main.ts
```

**7c. The web app with the live API (terminal tab 2).**

```bash
cd ~/Desktop/Fintechathon/hogee/apps/web && MOCK_API=0 DEMO_MODE=1 CHAIN=sepolia DEPLOYMENT_ID=final-2 DEPLOYMENT_FILE="$HOME/Desktop/Fintechathon/hogee/packages/chain/deployments/sepolia-final-2.json" DATABASE_URL=postgres://hogee@127.0.0.1:55702/hogee HOGEE_COUNTRY=SG PAYOUT_RAIL=mock HOGEE_DATA_DIR="$HOME/Desktop/Fintechathon/hogee/data" HOGEE_EVIDENCE_DIR="$HOME/Desktop/Fintechathon/hogee/evidence" caffeinate -i node --env-file=../../.env node_modules/next/dist/bin/next dev --hostname localhost --port 3000
```

Open <http://localhost:3000>. The passkey needs the host name `localhost`.

**The environment variables, by name.** Values come from the command line above or from `hogee/.env`.

| Process | Variables |
|---|---|
| Both | `CHAIN=sepolia`, `SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL_FALLBACK`, `DATABASE_URL`, `DEPLOYMENT_ID=final-2`, `DEPLOYMENT_FILE`, `PAYOUT_RAIL=mock`, `HOGEE_DATA_DIR` |
| Worker | `MAX_FEE_GWEI` (required; the setup script sets 50), `AGENT_PRIVATE_KEY_FINAL`, `ORACLE_PRIVATE_KEY_FINAL`, `LENDER_PRIVATE_KEY_FINAL`, `RELAYER_PRIVATE_KEY_FINAL`; optional `LOW_BALANCE_ETH` (default 0.05, a warning only) |
| Web and API | `MOCK_API=0`, `DEMO_MODE=1`, `HOGEE_COUNTRY=SG` (facility `fac-mei`, founder `founder-mei` by default), `HOGEE_EVIDENCE_DIR`, `PERSONA_COOKIE_SECRET`, `OFFICER_TOKEN`, `MEMORY_HMAC_KEY`, `MODEL_PROVIDER` (default `anthropic`) with its key (`ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY`), `TAVILY_API_KEY` (optional; without it the search shows labelled recorded samples), `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (for test sales); optional `WEBAUTHN_RP_ID` (default `localhost`), `WEBAUTHN_ORIGINS` (default `http://localhost:3000`), `FOUNDER_WALLET_ADDRESS` (Mei's backup wallet, public address) |

`TAVILY_API_KEY` is read only once the chat revamp's API change is merged. Add it with `bash ~/Desktop/Fintechathon/scripts/hogee-add-tavily-key.sh`.

---

## 8. Run Mei's chat journey on `final-2`

Do the steps in this order: funding is capped at the committed plan total, so the plan is signed before the officer funds it.

| # | Who | What to do | Needs | On-chain (task) |
|---|---|---|---|---|
| 1 | Officer | Switch to the officer persona. Open the facility: cap 10,000 BU, reserve floor 300 bps. Create Mei's one-time enrolment code. | officer access code | `openFacility` (S2) |
| 2 | Mei | Register a passkey with the enrolment code. | enrolment code, Touch ID | none |
| 3 | Officer | Approve Mei's pending key. | officer access code | `registerFounderKey` (S2) |
| 4 | Mei | In the chat, answer 2–3 questions. Read the needs card. Sign the plan inline. | Touch ID | `commitPlan` (S2) |
| 5 | Officer | Fund 10,000 BU. | officer access code | `fund` (S1) |
| 6 | Mei | Ask the AI to find suppliers. Pick one or more and copy the drafted enquiry. | none | none |
| 7 | Mei | Report the choice and terms, e.g. "went with #2, 30% deposit, 70% on delivery". Fill in the payout form. Sign the SupplierApproval inline. | Touch ID | `bindPayee` (S3) |
| 8 | Agent | After 120 s of cooling, the agent pays the deposit on order by itself; the simulated payout follows. The officer can object during the cooling. | none | `fundMilestone`, `confirmSettlement` (S4, S5) |
| 9 | Mei | Ask "how are we doing?" and open the CFO views. Record test sales (the app's sales demo action, or a Stripe test webhook). | none | `recordSale` (S11) |
| 10 | Agent, officer, Mei | The agent lowers a cap on a burn alert. The officer releases stage 2 when sales pass the target. Mei uploads the delivery check and signs the balance release (the worker already put the balance in escrow right after cooling, inside stage 1). Mei pauses at the end. | Touch ID for the release; officer access code for stage 2 | `tighten`, `releaseStage`, `releaseMilestone`, `pause` (S12) |

Wait for the chat's tx links to turn final before moving on. Settlement and export wait for Sepolia's finalized block, about 13 minutes behind.

---

## 9. Export and verify the chat-run bundle

1. When every transaction is final, export with the API's exporter (`make evidence`; the web app has no export button). Run it with the same settings as the web app: `bash ~/Desktop/Fintechathon/scripts/hogee-final2.sh evidence`. It signs and sends nothing. It refuses, with the reason, while any transaction is still pending, and it writes `evidence/<ev-id>/` in the app checkout and prints the path.
2. Check the bundle offline:

```bash
cd ~/Desktop/Fintechathon/hogee && make verify BUNDLE=evidence/<ev-id>
```

3. Check it against the chain:

```bash
cd ~/Desktop/Fintechathon/hogee && HOGEE_VERIFY_RPC=https://ethereum-sepolia-rpc.publicnode.com make verify BUNDLE=evidence/<ev-id>
```

4. Add it to the repo (retention keeps only the 10 newest bundles):

```bash
cd ~/Desktop/Fintechathon/hogee && git add -f evidence/<ev-id>
```

5. Stop the web app and the worker (Ctrl-C in each tab), then the database:

```bash
pg_ctl -D ~/hogee-sepolia/journey/pg stop
```

The live export names its rows by task where it can: `fund` is S1, `commitPlan` S2, `bindPayee` S3, a first `fundMilestone` S4, a later one S5, `recordSale` S11. A revert carries its attack's T id. Read the other S12 calls (`tighten`, `releaseStage`, `releaseMilestone`, `pause`) from the bundle's `SUMMARY.md`.

---

## 10. Where each value goes

Every placeholder in the drafts: search `docs/submission/*.md` for an opening square bracket followed by TBD. This file has none. The rows below name each placeholder by file and section, not by line, because the drafts were rewritten for the chat-first product on 19 Oct. Sources:

- **M1** = `packages/chain/deployments/sepolia-final-1.json`. **Already filled** in EXECUTION-EVIDENCE §02 and README §6 (addresses, deploy transactions, Etherscan links).
- **M2** = the same for `final-2`.
- **R** = the red-team run (section 5): `evidence/<run-id>/evidence.json` by task id, and the bundle path.
- **J** = the chat-run bundle on `final-2` (section 9).

**Filled from the Sepolia runs.** All files are in `docs/submission/`.

| File and place | Placeholder | Fill with |
|---|---|---|
| EXECUTION-EVIDENCE §02 "Deployments", `final-2` rows | addresses and deploy transactions | M2; the Etherscan `#code` link of each |
| EXECUTION-EVIDENCE §02 "Where each task's evidence comes from" | S1–S5, S11, S12: `final-1` hash, `final-2` hash, result | `final-1`: R rows with that task id. `final-2`: J (section 9 says how its rows are named). Result: R `report.json` |
| same table, row S6–S10 | `final-1` hash and result | R rows S6–S10 (the same hashes as T1, T4, T5, T6, T17) |
| EXECUTION-EVIDENCE §02 "Demos" | D-poison, D-plug: hash, block time, result | R rows D-poison and D-plug; block time from Etherscan or the bundle's `SUMMARY.md` |
| EXECUTION-EVIDENCE §02 "Red-team suite" | Sepolia hashes of T1–T10, T12–T21, T23, T24, T26–T29 | R rows by task id: each forced revert, plus the `recordDenied` hash where the row has one |
| EXECUTION-EVIDENCE §01 "What it does not show" | rail used on `final-1` | `mock` when run as in section 4b; R `run.json` |
| EXECUTION-EVIDENCE §02 "Autonomy" | the seven measures | J: first and last tx time, export time, agent-signed transactions, human signatures, the verifier's drift line |
| EXECUTION-EVIDENCE §02 "Timestamp, action, result and link" | Etherscan screenshots | the tx pages of S2, S4, T1 and D-poison from R |
| EXECUTION-EVIDENCE §03 A, and the end of §03 E | bundle paths; run ids, bundle commits, verifier output | `evidence/<run-id>/export/main/<ev-id>` (section 5), `evidence/<ev-id>` (section 9), the last lines of both online `make verify` runs |
| README §6, TECH-DOC §01 and §05 | `final-2` addresses | M2 |
| TECH-DOC §03 evaluation table; SECURITY-SELF-ASSESSMENT §02 intro | Sepolia red-team result | R: pass, fail and not-run counts and the bundle path |
| DECK-OUTLINE slide 9 and slide 10 | "On Sepolia"; autonomy | R counts; J autonomy measures |
| VIDEO-SCRIPT scenes 2, 6, 7, 8 | plan and deposit hashes; the replay bundle; the CFO scene's source | J; R |

**Not from Sepolia.** Listed so nothing is missed; other owners fill them.

| Placeholder | Who |
|---|---|
| Submission date (EXECUTION-EVIDENCE, SECURITY-SELF-ASSESSMENT, TECH-DOC, VIDEO-SCRIPT headers); upload links | at submission |
| Repository access for judges (README §6, EXECUTION-EVIDENCE §03) | user decision |
| The "TBD at freeze" items: the revamp tree's test counts, the WEB cases' result on the integrated tree, the e2e journey, audit run-9, the recorder reconciliation | the freeze check |
| E1 and E2 results (TECH-DOC §03, SECURITY-SELF-ASSESSMENT §03) | the eval run |
| Production consent copy; retention periods (SECURITY-SELF-ASSESSMENT §03) | P1 |
| Member names and universities (DECK-OUTLINE slide 1) | user |
| `docs/G0-DECISIONS.md`, `docs/decisions/docs.md` | notes that describe the placeholders: none to fill |

---

## 11. Payee cooling on Sepolia

**The value.** Both deploys set `COOLING_SECONDS=120` and `LOOSEN_TIMELOCK_SECONDS=120` (constants in `hogee-deploy-final.sh`). `DeployLoop`, whose checks `DeployFinal` inherits, refuses a cooling below 120 s or above 30 days off Anvil, and needs it set explicitly there. `VerifyFinal` re-reads both values from the chain. Production would use 86400 (24 h) for both.

**What it does.** `bindPayee` starts the cooling. Until it ends, any payment to that supplier reverts `PayeeCooling`. A re-bind restarts it.

**Demo impact.**

- After Mei signs the supplier terms, the deposit waits 2 minutes. The order card shows the countdown, then the agent pays.
- The officer's chance to object is those same 2 minutes. To show it on camera, the officer must act at once.
- A correction after binding ("actually 40/60", "wrong supplier") binds again and restarts the 2 minutes. That is why there is one order per web supplier.
- A cap raise, a budget move or an unpause waits the 120 s timelock. Executing it earlier reverts `TimelockActive` (S12, T9).
- The longer wait is finality: about 13 minutes per settlement round and before each export.

---

## 12. The change `hogee-deploy-final.sh` needs (P1, after STEPS 7)

Do not edit it while the user may be running it. After that run has finished, change these lines:

```diff
-MANIFEST="${HOGEE_MANIFEST:-$REPO/packages/chain/deployments/sepolia-final-1.json}"
-LOG="${HOGEE_DEPLOY_LOG:-$FT/docs/sepolia-final-1-deploy.log}"
+DEPLOYMENT_ID="${HOGEE_DEPLOYMENT_ID:-final-1}"
+[[ "$DEPLOYMENT_ID" =~ ^final-[a-z0-9-]{1,26}$ ]] || { echo "HOGEE_DEPLOYMENT_ID must look like final-2" >&2; exit 1; }
+MANIFEST="${HOGEE_MANIFEST:-$REPO/packages/chain/deployments/sepolia-$DEPLOYMENT_ID.json}"
+LOG="${HOGEE_DEPLOY_LOG:-$FT/docs/sepolia-$DEPLOYMENT_ID-deploy.log}"
```

```diff
-DEPLOYMENT_ID=final-1 CHAIN_TAG=sepolia LENDER_ADDRESS="$LENDER" ORACLE_ADDRESS="$ORACLE" \
+DEPLOYMENT_ID="$DEPLOYMENT_ID" CHAIN_TAG=sepolia LENDER_ADDRESS="$LENDER" ORACLE_ADDRESS="$ORACLE" \
```

The messages that say "final-1" ("final-1 is already deployed", "About to deploy final-1", "Done. final-1 is on Sepolia") should print `$DEPLOYMENT_ID` instead. The label rule is the deploy script's: `[a-z0-9][a-z0-9-]{0,31}`, and the worker needs `final-*` to pick the FINAL keys.
