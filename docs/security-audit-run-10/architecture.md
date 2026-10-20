# Hogee run-10 architecture (quick, scoped: 6dc22f0..38e552b)

**Product and principals.** Hogee is one AI chat that runs a micro-business's loan budget on an on-chain treasury (Sepolia).
Principals: the founder persona (Mei; anonymous by design in the demo, a signed persona cookie, passkey for every signature),
the loan officer persona (server-checked access code; funds, approves passkeys, decides exceptions), the worker (the only
signer of agent transactions; settle-spend, reconcile, cfo-guard, timelock-executor, record-sale, agent-actions,
stage-gate jobs under one Postgres advisory lock), cross-site pages in the same browser, and anyone who can reach a
hosted demo. Protected resources: what the founder signs and what is paid; officer-only actions; the evidence/proof a
judge relies on; the integrity of the mock demo state a judge sees; availability of the single worker.

**Comparable baseline.** The relay wake already waits 30 s for the job lock (`apps/worker/src/runtime/relay-wake.ts:16,29`);
the officer-only `POST /api/demo/reset` (`packages/api-contract/src/routes.ts:358-362`) is the comparable for the new demo
switch.

**Stack and modes.** Next 16 web app (React Query, zod, Tailwind) whose `/api/[...route]` mounts, once per process, the
in-process Hono mock (`MOCK_API=1`), a replay of an evidence bundle (`REPLAY`), or the live Hono API (`route.ts:17-38`,
unchanged in this range). `dev:mock` forces `DEMO_MODE=1` and defaults to the new Sample business scenario (`lived`);
`dev`/`build`/`start` set nothing, so a deployment's mode depends on its environment (not source-visible). Every mode is
wrapped by `rejectUntrustedRequest` (`packages/api/src/request-guard.ts:54-63`, unchanged): Host allow-list for every
method; non-GET needs `Sec-Fetch-Site` same-origin/none and a matching `Origin`, but a request with neither header passes.
CSP is set for pages only by `proxy.ts` (scripts only), not `/api`. No target-controlled execution in this run (macOS
cannot enforce the required sandbox limits; no promotion code): every check is source-only.

**What changed (scope).**
1. *CFO "Couldn't load" fix (live API + worker):* `services/block-lag.ts` retries a block-pinned read once after 1 s when the
   RPC error text says the block is unknown (used by `services/snapshot.ts:154` and `services/cfo.ts`); worker
   `runtime/job-locks.ts` + `app.ts`: settle-spend and reconcile now wait up to 20 s (200 ms polls, holding one of 8 pool
   connections) for the shared lock instead of skipping; other jobs still skip. pg-boss queues stay exclusive, no retry,
   300 s expiry.
2. *Journey (live + mock):* core `journey/quick.ts` matches four fixed questions (≤160 chars, no digits/%) and answers from
   constant templates before the planner/router at every stage (`packages/api/src/journey/text.ts:84-107`, after redaction,
   rate limit and budget); a new `balancePaid` fact (`journey/facts.ts:118`, `bool_and(released_minor>0)`); template and
   next-step wording; `planner.ts` replies use explainer templates only; agent planner question wording.
3. *Mock (demo judges run):* new `lived` scenario built by replaying a story through the mock's own transitions on a fake
   clock (`scenario-lived/*`, `store.ts:164-248`, `withClock` at :348); new mock-only `GET/POST /api/demo/sample-business`
   (`demo-data.ts:45-64`, raw `app.get/post`, so no `register()` persona check; gates: DEMO_MODE else 404, REPLAY or non-SG
   409, body exactly `{on:boolean}` ≤256 bytes) which rebuilds the module-global store like `demoReset` but for any caller;
   `getChat` on an unseen session id in `lived` creates a pre-filled history (cap 200); canned-scenario quick/CFO
   templates before the script (`chat.ts:30`, `journey/index.ts:171-245`, founder persona whoever asks); the evidence
   tenant now pins facility and chain only and lists exported runs before the fixture sample, so the recorded Sepolia
   final-2 pack (`evidence/ev-74756ea61a72ae7c`, deployment `final-2`) is the default pack while the mock profile says
   `final-1`; the live store still pins the deployment; `spend-policy.ts` binds ADD_PAYEE payees and adds an outflow bound;
   payout wording "Sample payout (PayNow) … no real bank transfer".
4. *Web UI (no new server authority):* side nav and section jump (hash/`?tab`/a same-origin `SECTION_JUMP_EVENT`, ids checked
   against `^[A-Za-z][A-Za-z0-9-]{0,79}$`); quick settings and the persona switch dialog (code stays a password field, hint
   only outside live); Settings with a device-local profile (`lib/profile.ts`, localStorage, zod per field, 4 KB cap, React
   text only); new browser storage: `hogee.signedAt` (hides the Sample tag on seals signed in this browser), goods-arrived
   marks (UI gate only), passkey-setup dismissal, recording mode (`?recording=1` in sessionStorage hides demo tools); the
   officer dashboard (client-side gate; data from persona-less read routes, unchanged server side); Proof (`proof-model.ts`:
   in mock a failed or unreadable check renders a grey "Sample proof pack", green only when the browser's own check passes);
   Wallet/Plan redesigns; `?raise`/`#change-requests` now auto-opens the raise form (still needs a reason and both
   signatures); a GET client that holds a route up to 5 min after a 429 `Retry-After` (`lib/api/client.ts:57-120`) and one
   shared poll per query (`lib/api/query-policy.ts`); `/dev/ui` only under DEMO_MODE. No `dangerouslySetInnerHTML`,
   `innerHTML` or `postMessage`; insight hrefs pass `AppHref`; listing links https on listing hosts.
5. *Unchanged:* contracts, `api-contract`, `route.ts`, `request-guard.ts`, `components/sign/*` signing logic (styling only).

**Trust boundaries and strongest controls.** (a) Cross-site / remote caller → mock demo state: request guard + DEMO_MODE
gate, no persona. (b) Founder ↔ officer: server persona checks on contract routes; the officer UI gate is client-only.
(c) Evidence pack → reviewer's trust: browser offline verification; mock label rule. (d) Chat text → actions/money: template
only, no text path to terms or signatures. (e) Worker jobs → chain/DB: advisory lock + exclusive queues; idempotent
settlement. (f) RPC/block lag → API answers: fail closed with 502 on read errors. (g) URL/storage → UI state.

**Starting paths.** `packages/api-mock/src/{demo-data,store,evidence,spend-policy,chat,signing}.ts`,
`packages/api-mock/src/scenario-lived/`, `packages/api-mock/src/journey/index.ts`, `packages/core/src/journey/quick.ts`,
`packages/api/src/journey/{text,facts,planner}.ts`, `packages/api/src/services/{block-lag,snapshot,cfo}.ts`,
`apps/worker/src/runtime/{job-locks,app,lock}.ts`, `apps/web/lib/{profile,presentation,sections,api/client,api/query-policy}.ts`,
`apps/web/components/{evidence,officer,settings,shell,chat/cards}/`.

**Prior coverage.** Runs 1–9 have no confirmed records. Run-9 (scope db731b0..04924cd) left 5 needs_validation leads,
fixed after it; two touch changed source (mock catalog SupplierApproval binding in `api-mock/signing.ts`; cfo-guard
all-history reads under the job lock, now that settle-spend/reconcile wait for that lock) and are revalidation units here.
34 prior units have starting paths changed in this range and are current work; all other prior units stay out_of_scope.

**Companions selected.** WEB-PROTOCOL-AND-AUTH (Ordinary CSRF, Host and forwarded-header trust: the demo switch and the
request guard), CLIENT-SIDE (browser storage, navigation, DOM-based XSS: the new client state and links),
DATA-ISOLATION-AND-LIFECYCLE (missing owner enforcement, stale authorization and derived copy use: persona-less mock
writes, `signedAt`), RESOURCE-EXHAUSTION-AND-AVAILABILITY (worker pool starvation, retry amplification, unbounded
cardinality: job-lock waits, block-lag retry, seeded chats, the 429 hold), PROTOCOLS-RPC-AND-MESSAGING (duplicate delivery,
untrusted producer: worker jobs, evidence packs), AI-AND-LLM (prompt provenance, action-confirmation binding: quick intents
before the planner, chat cards). Excluded: CLOUD-AND-DEPLOYMENT and SUPPLY-CHAIN (no infra or lockfile change beyond
`next.config.ts`/e2e package metadata; covered by a reused unit), MEMORY-SAFETY, DESKTOP-MOBILE.
