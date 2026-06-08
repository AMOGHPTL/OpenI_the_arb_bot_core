.PHONY: help build test test-unit test-fork deploy-base deploy-eth deploy-arbitrum deploy-local anvil verify-base clean run-monitor run-bot

-include .env
export

ifeq ($(OS),Windows_NT)
FOUNDRY_BIN := $(subst \,/,$(USERPROFILE))/.foundry/bin
ANVIL ?= $(FOUNDRY_BIN)/anvil.exe
else
ANVIL ?= anvil
endif

NODE ?= node

DEPLOY_SCRIPT := script/FlashLoanDeploy.s.sol:DeployFlashLoanArb
LOCAL_DEPLOY_SCRIPT := script/DeployLocal.s.sol:DeployFlashLoanArbLocal

help:
	@echo Flash Loan Arbitrage Bot - Foundry Commands
	@echo ----------------------------------------------------
	@echo make build           - Build the contracts
	@echo make test            - Run all tests
	@echo make test-unit       - Run unit tests only
	@echo make test-fork       - Run Base fork test only
	@echo make deploy-base     - Deploy to Base mainnet
	@echo make deploy-eth      - Deploy to Ethereum mainnet
	@echo make deploy-arbitrum - Deploy to Arbitrum
	@echo make deploy-local    - Deploy to local Anvil
	@echo make verify-base     - Verify contract on BaseScan
	@echo make clean           - Clean Foundry build artifacts
	@echo make run-monitor     - Run price monitor
	@echo make run-bot         - Run execution engine
	@echo ----------------------------------------------------

build:
	forge build

test:
	forge test

test-unit:
	forge test --match-contract FlashLoanArbitrageTest -vvv

test-fork:
	forge test --match-contract FlashLoanArbitrageForkTest -vv

deploy-base: NETWORK=base
deploy-base:
	@echo "Deploying to Base mainnet..."
	forge script $(DEPLOY_SCRIPT) \
		--rpc-url base \
		--broadcast \
		--verify \
		--private-key $(PRIVATE_KEY) \
		-vvv

deploy-eth: NETWORK=ethereum
deploy-eth:
	@echo "Deploying to Ethereum mainnet..."
	forge script $(DEPLOY_SCRIPT) \
		--rpc-url ethereum \
		--broadcast \
		--verify \
		--private-key $(PRIVATE_KEY) \
		-vvv

deploy-arbitrum: NETWORK=arbitrum
deploy-arbitrum:
	@echo "Deploying to Arbitrum..."
	forge script $(DEPLOY_SCRIPT) \
		--rpc-url arbitrum \
		--broadcast \
		--verify \
		--private-key $(PRIVATE_KEY) \
		-vvv

deploy-local:
	@echo "Deploying locally..."
	forge script $(LOCAL_DEPLOY_SCRIPT) \
		--rpc-url http://localhost:8545 \
		--broadcast \
		-vvv

anvil:
	$(ANVIL) --fork-url base

verify-base:
	forge verify-contract \
		--chain-id 8453 \
		--num-of-optimizations 200 \
		--compiler-version v0.8.23 \
		$(CONTRACT_BASE) \
		src/FlashLoanArbitrage.sol:FlashLoanArbitrage \
		$(BASESCAN_API_KEY)

clean:
	forge clean

run-monitor:
	$(NODE) scripts/priceMonitor.js

run-bot:
	$(NODE) scripts/executionEngine.js
