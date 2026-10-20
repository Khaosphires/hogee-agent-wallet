# @hogee/web (P2)

The founder app, the loan-officer console, the glass-box timeline and the evidence explorer. Pages get data only
through `lib/api/*` (typed client over `@hogee/api-contract`, responses parsed with `route.res`), so the same pages run
against the live API, the mock and a recorded replay. The mode comes from `GET /api/session`.

## Run

```bash
pnpm --filter @hogee/web dev:mock      # mock + demo routes (the Sample business; MOCK_SCENARIO=fresh for a fresh start), prints a per-run officer access code
pnpm --filter @hogee/web dev           # uses your own .env.local (MOCK_API, DEMO_MODE, OFFICER_TOKEN, PERSONA_COOKIE_SECRET)
REPLAY=<runId> pnpm --filter @hogee/web dev:mock   # offline demo from evidence/<runId>/
```

Open http://localhost:3000 (not 127.0.0.1: passkeys need the `localhost` RP ID). Switching to the officer persona asks
for the access code (`OFFICER_TOKEN`).

Until P1 mounts `@hogee/api-mock` in `app/api/[...route]/route.ts` (see `packages/api-mock/README.md`), mock and replay
mode answer 503.

## Pages

| Route | Task | What it shows |
|---|---|---|
| `/chat` | 2.4 | Planner chat (AI SDK 7 `useChat`), question chips, intent card, red flags, AI-drafted labels |
| `/plan` | 2.5 | Lines vs contract pockets, rules with source/date, constitution, stages, diff, blast radius, MY→ID switch, sign |
| `/suppliers` | 2.8 | Ranked decision cards, blocked suppliers with reasons, escrow milestones, inspection upload |
| `/dashboard` | 2.9 | Totals, pockets with cap meters, agent key, autonomy, pause, founder change requests, payments |
| `/timeline` | 2.11 | Trace chains with plain-English reasons, red-team runs |
| `/officer` | 2.10 | Exception queue (approve/deny/veto, timelock countdown), stage gates, facility, demo controls |
| `/evidence` | 2.13 | Evidence rows with links, deployments, offline verifier |
| `/dev/passkey` | 2.6 | Passkey test-vector generator (gate G3) |

Signing is one `SignDialog` for every kind (`components/sign`): it recomputes the EIP-712 digest in the browser and
refuses to sign on a mismatch. `lib/passkey-encode.ts` is dependency-free so P1 can copy it into `packages/chain`.

## Tests

```bash
pnpm --filter @hogee/web test          # vitest: passkey encoder
pnpm --filter @hogee/e2e e2e:smoke     # Playwright smoke tests, 1280×720 and 1920×1080, mock mode
pnpm --filter @hogee/e2e vectors       # writes e2e/vectors/passkey-1..20.json (virtual authenticator)
pnpm --filter @hogee/e2e demo:record   # the 5-minute 1080p demo video + subtitles (ffmpeg for burn-in)
```

`HOGEE_FIXTURES_DIR=<dir>` points the mock at another fixtures folder (e.g. a checkout of P3's branch).
