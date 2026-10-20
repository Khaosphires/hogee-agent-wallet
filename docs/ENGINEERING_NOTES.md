# Engineering notes

What broke, why, and how we fixed it. Newest first. Also our AI-assistance disclosure (project.md §23).

## AI-assisted development disclosure

The team builds Hogee with AI coding assistants (Claude Code and others). Humans own and review:
- every `require` and custom error in the contracts;
- the EIP-712 layout and domain;
- nonce allocation and payment-state recovery;
- the policy decision table;
- key handling and every deploy.

The LLM inside the product never writes rules, payees, amounts or calldata (D6).

## 2026-10-15: G0 groundwork (task 1.3)

- **pnpm 12 fails installs whose dependencies have unapproved build scripts** (`ERR_PNPM_IGNORED_BUILDS`).
  - Fix: `allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml`. Approve each new one deliberately; never use `--all`.
- **`@wagmi/cli` pulls Vite 8, which wants esbuild ≥0.27.** pnpm resolves Vite's own copy (0.25.12) and warns. We pinned esbuild 0.28.2 in `@hogee/chain`; the warning is harmless while `abi:generate` works.
- **Two of the spec's Claude 5.5 rules were wrong for Haiku** (docs checked 15 Oct). Haiku 5.5 accepts forced tool choice and `thinking: disabled`, but needs `temperature` 1 and `top_p` 0.99 if they're sent. We keep the uniform "never set them" rule; project.md §7.1 now records both.
- **`@ai-sdk/anthropic` 4.0.x silently strips the forbidden sampling params** with a warning, so only a raw `fetch` proves the 400 (`pnpm smoke:models --prove-400`).
- **AI SDK 7 throws `AI_ToolChoiceViolationError` client-side** if `toolChoice: 'required'` and a step has no tool call, which includes the final text answer. One more reason never to force tool choice.
- **DeepSeek renamed `deepseek-v4-flash` to `deepseek-flash`** (old name is a retired alias).

## 2026-10-15: scaffold (task 1.2)

- **Homebrew formulas won't install on the lead's Mac.** The Xcode Command Line Tools are older than macOS 27 requires, so Homebrew refuses formula installs.
  - Fix: gitleaks 8.30.1 and Stripe CLI 1.53.1 were installed from their official GitHub release binaries, with checksums verified, into `~/.local/bin`.
  - Updating the CLT (Software Update) would restore Homebrew.
- **pnpm 12 has a minimum package release age.** Explicitly pinning packages published in the last day made pnpm add `minimumReleaseAgeExclude` entries.
  - Fix: we removed them and let pnpm pick the newest versions that pass the gate (Next 16.4.0, not 16.4.1). Keep the gate on.
- **TypeScript is pinned to 6.0.3, not 7.0.x.** TS 7 is the native port, and tooling that uses the TS JS API (Next type plugin, drizzle-kit, wagmi CLI) is the risk.
- **Solidity dependencies come from Soldeer (`forge soldeer install`), not git submodules,** so teammates never need `git clone --recursive`.
- **The local Claude deny rules don't block `.env.example`** (`.claude/settings.json`), so assistants can read variable names. Real secrets go only in `.env` or `.env.local`, which are denied.

## 2026-10-15: toolchain probe (task 1.1)

- OZ 5.7.0 `WebAuthn` + `MessageHashUtils` + `ECDSA` compile and pass under solc 0.8.37 with `cancun`. The same build fails under `paris` because of `mcopy`, as expected.
- The probe is kept as the canary test `contracts/test/Toolchain.t.sol`.
- OZ `WebAuthn.verify(challenge, auth, qx, qy)` requires the UV flag and rejects high-s signatures, so the client must normalise s to low-s (ROLE-P2 task 2.6).
