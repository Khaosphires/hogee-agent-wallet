# Pinned versions

Recorded at scaffold (task 1.2) on 2026-10-15. Change a version only in a `chore(deps):` PR approved by P1 (project.md §25.4).

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| Node | 24 (`.nvmrc`; tested 24.14.1) | `engines` allows ≥22.12 (pg-boss minimum) |
| pnpm | 12.11.2 (`packageManager`) | Keeps its default minimum-release-age gate; don't add `minimumReleaseAgeExclude` entries |
| TypeScript | 6.0.3 | **Not 7.x.** TS 7 is the native rewrite; Next, drizzle-kit and wagmi CLI rely on the JS compiler API |
| Foundry (forge/anvil/cast) | 1.8.5 | `foundryup` |
| solc | 0.8.37 | Pinned in `contracts/foundry.toml`; spec minimum 0.8.24 |
| EVM version | `cancun` | `paris` fails on OZ's `mcopy` (expected; checked by the `paris` profile) |
| Slither | 0.11.6 (crytic-compile 0.4.2) | `uv tool install slither-analyzer==0.11.6`; triage in `docs/assurance/static-analysis-2026-10-18.md` |
| Aderyn | 0.6.8 | Official `aderyn-installer.sh` from the `aderyn-v0.6.8` GitHub release (Cyfrin/aderyn) |
| gitleaks | 8.30.1 | Pre-commit hook + CI |
| Stripe CLI | 1.53.1 | `stripe listen --forward-to localhost:3000/api/webhooks/stripe` |
| Python | 3.12 via uv | For evals/ and services/presidio (P3) |

## Solidity dependencies (Soldeer, `contracts/soldeer.lock`)

| Package | Version |
|---|---|
| `@openzeppelin-contracts` | 5.7.0 (WebAuthn first shipped in 5.5; `WebAuthn.verify` requires UV by default and rejects high-s) |
| `forge-std` | 1.17.0 |

## Docker images (`docker-compose.yml`)

| Image | Tag |
|---|---|
| `postgres` | 16 |
| `ghcr.io/data-privacy-stack/presidio-analyzer` | 2.2.364 |
| `ghcr.io/data-privacy-stack/presidio-anonymizer` | 2.2.364 |

## apps/web

| Package | Version |
|---|---|
| next | 16.4.0 |
| react / react-dom | 19.3.0 |
| tailwindcss / @tailwindcss/postcss | 4.3.3 |
| recharts | 3.10.1 |
| @tanstack/react-query | 5.104.2 |
| zod | 4.6.7 |
| ai | 7.0.140 |
| @ai-sdk/react | 4.0.143 |
| @simplewebauthn/browser | 14.0.0 |
| hono | 4.13.13 |
| @playwright/test | 1.64.1 |
| class-variance-authority / clsx / tailwind-merge / lucide-react / tw-animate-css | 0.7.1 / 2.1.1 / 3.7.0 / 1.57.0 / 1.4.0 |

## Root (scripts)

| Package | Version |
|---|---|
| typescript | 6.0.3 |
| @types/node | 24.19.2 |
| ai | 7.0.140 |
| @ai-sdk/anthropic | 4.0.79 |
| @ai-sdk/openai-compatible | 3.0.68 |
| zod | 4.6.7 |
| vitest / tsx | see `pnpm-lock.yaml` |

## Workspace packages (G0)

| Package | Key deps |
|---|---|
| `@hogee/core`, `@hogee/api-contract`, `@hogee/checks`, `@hogee/privacy` | zod 4.6.7 |
| `@hogee/api` | hono 4.13.13 |
| `@hogee/chain` | viem, @wagmi/cli, esbuild 0.28.2 (peer of wagmi's Vite) |
| `@hogee/db` | drizzle-orm, drizzle-kit, pg |
| `@hogee/verify-evidence` | viem, zod |

Exact versions are in `pnpm-lock.yaml`; pnpm's minimum-release-age gate chose them.

## Models (scripts/smoke-models.ts)

| Role | Model ID |
|---|---|
| Planner | `claude-sonnet-5-5` (thinking `between_tools`) |
| Reader / Explainer | `claude-haiku-5-5` (structured outputs via `output_config.format`) |
| China fallback | `deepseek-v4-pro`, `deepseek-flash`, `qwen3-max` / `qwen-plus` (unverified until keys exist) |

## GitHub Actions

`actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6`, `foundry-rs/foundry-toolchain@v1`, `astral-sh/setup-uv@v10`, `dorny/paths-filter@v4`.
