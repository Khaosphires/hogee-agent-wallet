# @hogee/api-mock (P2, task 2.12)

The mock and replay twin of `packages/api`. It implements **every** `@hogee/api-contract` route as
`export const app = new Hono().basePath('/api')`, so the web app works before the live backend exists and
judges can run the whole demo offline (project.md §26.7).

## Modes

| Env | Mode | Data |
|---|---|---|
| `MOCK_API=1` | mock | In-memory store for the demo `HOGEE_COUNTRY` selects (below). MY (Rina): `fixtures/scenario-rina/*.json` (P3), a missing file falls back to the matching `@hogee/core` example. SG (Mei): `fixtures/scenario-mei/*.json` when P3 adds them, a missing file falls back to Rina's scenario re-issued for Mei (`src/scenario-mei.ts`). A file that breaks its frozen schema throws. |
| `REPLAY=<runId>` | replay | Evidence routes serve only `evidence/<runId>/`. The store is seeded from `evidence/<runId>/scenario/` when the bundle carries that snapshot, else from the fixtures. `GET /api/session` reports `mode: "replay"`. |
| `DEMO_MODE=1` | — | Enables `/api/demo/*`, `/api/eval/*`, `/api/session/persona`, `/api/proposals/spend` (404 otherwise). |

`HOGEE_COUNTRY` (the live API's variable): unset or `SG` serves Mei, Singapore, the main demo; `MY` serves Rina. Any
other value fails closed: every request answers 502 (`ID` is a country-switch preview only).

Other env (names only; set values in your own `.env.local`, never commit them):
`PERSONA_COOKIE_SECRET` and `OFFICER_TOKEN` (required for persona cookies; shared code in `@hogee/api`),
`STRIPE_WEBHOOK_SECRET` (signed test webhooks), `DEMO_TIMELOCK_SECONDS` (default 120),
`HOGEE_FIXTURES_DIR` (folder holding `scenario-rina/` and `evidence-sample/`; default `<repo>/fixtures`),
`HOGEE_MOCK_OWNER_EOA` (the founder's wallet address for MetaMask signatures; unset by default, see Signing).

## Behaviour

- **Contract rules for every route:** demo-only → 404, persona → 403, request schemas → 422, and every 2xx body is
  validated against `route.res` before it is sent (a mismatch is answered 502 and logged as a mock bug).
- **Persona:** the signed, httpOnly `hogee_persona` cookie from `@hogee/api` (same code as the live API). The
  officer persona needs `officerToken` = `OFFICER_TOKEN`. The founder is `HOGEE_COUNTRY`'s (SG `founder:mei`, MY
  `founder:rina`): any other cookie reads as that founder, and minting the other founder answers 403.
- **Singapore never shows Malaysia:** an SG scenario with a Malaysian name or label anywhere throws at load. The country
  switch (`POST /api/plans/preview-country`) is exhaustive per country (SG, MY, ID) with the compiler's rule texts
  (Mei's plan shows the free SFA importer registration, `approval.sfa.fee.0`); an unknown country throws.
- **Spend rules** (`src/spend-policy.ts`, the checks `Treasury.spend` makes): bound payee, not escrow-only, not
  paused, per-payment cap, and window and pocket caps counting payments still in flight. Each pacing slot and
  invoice pays once (`DuplicateIntent` / `DuplicateInvoice`).
- **Escalations:** `POST /api/exceptions` refuses `POLICY_ESCALATION` (422); only the server's spend path opens one.
  When the officer approves one, the spend rules run again first (a failure sends nothing and leaves it open), and
  the payment is traced as an "Officer override".
- **Reserve withdrawal:** `WITHDRAW_RESERVE` pays only the facility's tax payee (`iras-tax` for Mei, `lhdn-tax` for Rina) and at most what the
  reserve holds (withdrawals in flight count). It is checked when requested (422 / 409), when the officer approves
  (409) and when the timelock executes (it stays `EXECUTABLE` and pays nothing, as a reverted execute would). This is
  stricter than the chain, whose `_checkLoosen` (and core's withdraw rules) accept any static platform payee.
- **Founder key:** a credential's public key is set once; re-registering it with another key answers
  `FounderKeyAlreadySet` (409). The officer registers one key per facility: approving a second answers
  `FounderKeyAlreadySet` too.
- **Requester:** `x-hogee-requester: agent` (sent by `apps/mcp`) records a request as the agent's. It can only lower
  the requester, never raise it.
- **Scripted transitions** (lazy, no timers): a payment the mock creates goes `PROPOSED → SETTLED` in about 6 s and
  moves the pocket when mined; a queued loosening becomes `EXECUTABLE` after the timelock and `EXECUTED` 3 s later;
  a new shortlist is `READY` after 2.5 s; `POST /api/demo/autonomy/start` makes the agent pay one pacing slot every
  9 s inside its caps. Seeded fixture records never move on their own ("status gallery"); an officer or founder
  action on one moves it as on any other record.
- **Signing:** typed data uses `@hogee/chain` `hogeeTypes` and the custom Hogee domain; the digest is a real EIP-712
  hash of that typed data (a test checks it against `hashPlanApproval`). `planHash`, `linesHash` and `scheduleHash`
  are JCS keccak commitments in mock mode.
- **Signature checks** (`src/signature-check.ts`): a passkey assertion must pass OpenZeppelin 5.7 `WebAuthn.verify`'s
  checks (P-256 over sha256(authenticatorData ‖ sha256(clientDataJSON)), `webauthn.get`, challenge = this request's
  digest, user present + verified, low-s) against the founder's key. Once the officer registered a key, only that
  one counts, as on-chain.
  **Looser than the chain before that:** the chain accepts no founder signature until the officer registers the key,
  but the demo lets the founder sign with the pending key (it signs right after "Create your passkey first").
  Registering one takes the officer's one-time enrolment code (G2), and one key is pending at a time. What the
  pending key signs applies at once. A rejected key signs nothing. A loosening waits `FOUNDER_SIGNED` with its
  signer recorded (`founderSig`: the passkey's credential, or the wallet's address); if that passkey was rejected or
  another key registered before the officer approves, the approval is refused (`CONFLICT`, contract error
  `InvalidSignature`, as `queueLoosen` would revert) and the request goes back to `OPEN` for the founder to sign
  again. A seeded `FOUNDER_SIGNED` row is marked `seeded-fixture`: it is the owner's status gallery, no founder key
  signed it, and the officer approves it as before (nothing a request sends can create or edit such a row).
  A founder key must be a valid P-256 point (on the curve, coordinates below p), as `registerFounderKey` requires:
  register refuses any other (`VALIDATION`), approve too (`CONFLICT`, contract error `InvalidSignature`), which
  covers the seeded placeholder key. Register options list the founder's current key in `excludeCredentials`.
  An ECDSA signature must recover to `HOGEE_MOCK_OWNER_EOA`; unset, every ECDSA signature is refused, as on-chain
  for a passkey-only owner (Rina's ownerEOA is zero), so "Use MetaMask instead" fails in mock mode. A value that is
  not an address, or that is the lender's or an agent key's address, refuses wallet signatures with that reason and
  breaks nothing else. Anything else answers `InvalidSignature` with the reason and leaves the request usable.
  A founder's signature that would queue an approved reserve withdrawal the reserve no longer holds is refused with
  the chain's reason (`CapExceeded`), as `queueLoosen` would revert.
- **Evidence files:** links are never followed. A run folder, `manifest.json`, `evidence.json` or served file that
  is a symlink, a junction, a hard link or not a regular file (e.g. a named pipe) is skipped, and a bundle that
  doesn't parse is left out instead of failing the evidence routes. A file is read from the descriptor it was checked
  on, which narrows a swap between the checks and the read but doesn't close it: a folder on the path swapped for a
  link during the open is still followed (it takes a local writer winning the race). As the live reader: an
  unreadable folder is skipped, files are listed at most two folders down, a served file is at most 32 MiB (index
  files 4 MiB), and served files carry `nosniff`, a sandboxing CSP and `no-store` (every evidence response has
  `nosniff`).
- **Chat:** a canned planner conversation (3 questions → intent → plan draft → shortlist with a red flag) as an
  AI SDK 7 UI-message stream with the frozen data parts, in the demo's words (Mei: Singapore, S$; Rina: Malaysia, RM).
  History is kept per session.
- **Payouts and payees:** Mei's payouts are labelled "simulated PayNow payout" (payout ids `simulated-paynow-*`; the
  worker's MockRail, never a real SG payout); Rina's read "Test-mode payout". ADD_PAYEE signs the payee's payout hash
  from the API's own demo accounts (`src/payees.ts`; Mei's PayNow UEN proxies S99ZZ0001A..S99ZZ0005E) and refuses a
  payee the demo did not onboard. SupplierApproval takes an escrow order id or a shortlisted supplier id, as live.
- **Demo attacks:** `T1..T33`, `D-poison`, `D-plug` return a refusal trace and, where §13.2 names a revert, the
  forced send's revert reason.

## Wiring (P1: `apps/web/app/api/[...route]/route.ts`)

`apps/web` already depends on `@hogee/api-mock` and transpiles it. The route needs one import and one line:

```ts
import { app as mockApp } from "@hogee/api-mock";
// …
const app = mode === "live" ? liveApp : mockApp;
```

## Tests

```bash
pnpm --filter @hogee/api-contract test:contract   # P1's contract test against this mock
pnpm --filter @hogee/api-mock test                # transitions, digest parity, attacks, chat, replay
```
