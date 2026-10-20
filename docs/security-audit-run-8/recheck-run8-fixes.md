# Run-8 post-fix skills re-check (19 Oct 2026)

**What was checked:** three independent re-checks, read only, of `p1/dev` at `7e16090`, over the scope `42d0c96..HEAD`. That covers the 18–19 Oct takeover plus the run-8 fixes. Each one applied a single skill: `security-review`, `llm-trading-agent-security` or `nodejs-keccak256`. **None found anything above LOW.**

## security-review
- **LOW: quadratic PayNow window scan** in `packages/agent/src/reader/prefilter.ts` `payNowTargets`. It is reachable only through `/api/eval/case`, with `DEMO_MODE=1` and a local chain. **Fixed:** windows are merged per line and capped at 32 mentions, failing closed, in `wip/hard-agent` (`eb78c21`).
- **The six deferred run-8 critic gaps:**
  - Reader window cost: the LOW above.
  - Redactor request-path cost: nothing found.
  - Mock preview-draft approval: rejected. The mock now refuses a draft from another country anyway (`wip/hard-webmock` `892f06a`).
  - Plan rule source links: rejected. Only https URLs are linked (`3a9fbf7`).
  - SGD budget grounding: rejected. It is the founder's own text; the grounding was made stricter anyway (`69b3c29`).
  - WITHDRAW_RESERVE destinations with both countries' payees in final-1: rejected (fails closed). The destination is now bound anyway (`1823a98`).
- **No regressions** from the run-8 fixes in privacy, checks or the mock.

## llm-trading-agent-security
1. **LOW: reserve withdrawal to a marketplace payee.** `isPlatformPayee` treated any binding with an unlimited lifetime cap as a platform payee, while the tax payee (on no plan line) was refused. **Fixed:** WITHDRAW_RESERVE goes only to the server country's tax payee (`1823a98`), and "platform" means registered in Treasury's static registry (`c9c6baa`).
2. **LOW: an MCP agent's request was shown as the founder's.** The live API ignored `x-hogee-requester`. **Fixed** (`1b5c86d`). The header can only lower the requester to `agent`.
3. **LOW: a PayNow mobile in chat was not redacted.** **Already fixed** on p1/dev by the privacy batch (`07577ee`); the re-check read the tree just before that merge.
4. **LOW: PayNow window cost.** Same as the security-review LOW above; fixed.

## nodejs-keccak256
- Confirmed:
  - real Keccak-256 everywhere it is expected;
  - payout account hashes identical across the API catalog, the mock and the final-1 deploy arguments, and recomputed by the worker before paying;
  - `snippetHash` is SHA-256 everywhere and all 41 SG ledger quotes re-hash cleanly;
  - the enrolment-code keccak is pinned against SHA3 in tests.
- **Open LOWs** (latent, no on-chain path):
  - the supplier generator's own `snippetHash` normalisation differs from core's on rare whitespace characters;
  - core `snippetHash` accepts an empty sentence, which the Python tool refuses;
  - the mock fixtures carry placeholder (SHA-256 of a label) payout and shortlist hashes instead of Keccak of the real account.
