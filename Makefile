# Hogee make targets (project.md §16, §18.4). Run `make help` for the list.
SHELL := /bin/bash
FOUNDRY_BIN := $(HOME)/.foundry/bin
export PATH := $(FOUNDRY_BIN):$(PATH)

.PHONY: help install up down chain-local deploy-local deploy-sepolia test test-contracts test-ts test-py \
        audit eval eval-replay evidence verify verify-fisco

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-16s %s\n", $$1, $$2}'

install: ## Install JS deps and Solidity deps
	pnpm install
	cd contracts && forge soldeer install

up: ## Start Postgres + Presidio (docker compose)
	docker compose up -d

down: ## Stop local services
	docker compose down

chain-local: ## Run a local Anvil chain
	anvil --chain-id 31337

deploy-local: ## Deploy contracts to Anvil (task 1.4)
	@echo "deploy-local: not implemented yet (P1 task 1.4)"; exit 1

deploy-sepolia: ## Deploy + verify on Sepolia (task 1.7)
	@echo "deploy-sepolia: not implemented yet (P1 task 1.7)"; exit 1

test: test-contracts test-ts test-py ## forge + vitest + pytest

test-contracts: ## Foundry tests
	cd contracts && forge test

test-ts: ## TypeScript typecheck + unit tests
	pnpm typecheck
	pnpm test

test-py: ## Python tests (evals/, services/presidio/) once they exist
	@if [ -f evals/pyproject.toml ]; then cd evals && uv run pytest; else echo "test-py: evals/ not created yet (P3), skipping"; fi

audit: ## slither + aderyn + halmos (task 1.14)
	@echo "audit: not implemented yet (P1 task 1.14)"; exit 1

eval: ## Run E1-E5 on Anvil (P3 task 3.12, after G5)
	@echo "eval: not implemented yet (P3 task 3.12)"; exit 1

eval-replay: ## Replay recorded eval runs offline
	@echo "eval-replay: not implemented yet (P3 task 3.12)"; exit 1

evidence: ## Build evidence/<run-id>/ from the DB + chain (needs the API env: DATABASE_URL, CHAIN, RPC, DEPLOYMENT_ID)
	pnpm --silent --filter @hogee/api evidence

# The RPC URL may carry a key: it reaches the CLI through the environment, never through a command line (`ps`).
# Set it in the environment too (HOGEE_VERIFY_RPC=<url> make verify), not as a make argument.
verify: export HOGEE_VERIFY_RPC := $(or $(VERIFY_RPC),$(HOGEE_VERIFY_RPC))
verify: ## Verify the latest evidence bundle offline (BUNDLE=evidence/<run-id> for another; HOGEE_VERIFY_RPC=<url> make verify also compares the anchor with a node; exit 0 = verified)
	@pnpm --silent --filter @hogee/verify-evidence verify $(if $(BUNDLE),$(abspath $(BUNDLE)),)

# PACK reaches the shell only as a quoted environment value (never expanded by make, never re-parsed by the shell), so
# a folder name with spaces, `;`, quotes, backticks or `$(…)` stays one literal path argument.
unexport PACK
verify-fisco: export HOGEE_FISCO_PACK := $(value PACK)
verify-fisco: ## Verify a FISCO BCOS mirror pack offline against final-2 (PACK=evidence/fisco/fm-<16hex>; uses contracts/out when built; exit 0 = verified)
	@d="$$(pwd)"; set --; p="$$HOGEE_FISCO_PACK"; \
	if [ -n "$$p" ]; then case "$$p" in /*) ;; *) p="$$d/$$p" ;; esac; set -- "$$p"; fi; \
	set -- "$$@" --sepolia-bundle "$$d/evidence/ev-74756ea61a72ae7c" --require-anchor; \
	if [ -d contracts/out ]; then set -- "$$@" --artifacts "$$d/contracts/out"; fi; \
	pnpm --silent --filter @hogee/verify-evidence verify:fisco "$$@"
