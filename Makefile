.PHONY: help build sizes lint test test-unit test-fork test-invariant test-formal test-real-dex \
        deploy-base deploy-eth deploy-arbitrum deploy-local \
        verify-base verify-eth verify-arbitrum \
        anvil warm-approvals \
        install run-monitor run-bot run-scan run-scan-dense \
        clean

-include .env
export

# ──────────────────────────────────────────────────────────────────────────────
# Toolchain — .exe suffixes on Windows
# ──────────────────────────────────────────────────────────────────────────────
ifeq ($(OS),Windows_NT)
FOUNDRY_BIN := $(subst \,/,$(USERPROFILE))/.foundry/bin
FORGE  ?= $(FOUNDRY_BIN)/forge.exe
ANVIL  ?= $(FOUNDRY_BIN)/anvil.exe
CAST   ?= $(FOUNDRY_BIN)/cast.exe
HALMOS ?= halmos
else
FORGE  ?= forge
ANVIL  ?= anvil
CAST   ?= cast
HALMOS ?= halmos
endif

NODE    ?= node
ACCOUNT ?= default

DEPLOY_SCRIPT       := script/FlashLoanDeploy.s.sol:DeployFlashLoanArb
LOCAL_DEPLOY_SCRIPT := script/DeployLocal.s.sol:DeployFlashLoanArbLocal

# Must match foundry.toml
SOLC_VERSION := 0.8.28
OPT_RUNS     := 10000

# Base token addresses (for warm-approvals)
WETH_BASE := 0x4200000000000000000000000000000000000006
USDC_BASE := 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# ──────────────────────────────────────────────────────────────────────────────

help:
	@echo "Flash Loan Arbitrage Bot — available targets"
	@echo "──────────────────────────────────────────────────────────────"
	@echo " Build"
	@echo "  make build              Compile contracts"
	@echo "  make sizes              Compile and print bytecode sizes"
	@echo "  make lint               Lint (runs with build)"
	@echo "  make clean              Delete build artifacts"
	@echo ""
	@echo " Test"
	@echo "  make test               Run all tests"
	@echo "  make test-unit          Unit tests (mock env)"
	@echo "  make test-fork          Fork test against live Base state"
	@echo "  make test-invariant     Stateful fuzz / invariant suite"
	@echo "  make test-formal        Halmos symbolic-execution tests"
	@echo "  make test-real-dex      Fork test with real on-chain DEX contracts"
	@echo ""
	@echo " Deploy"
	@echo "  make deploy-base        Deploy to Base mainnet        (ACCOUNT=name)"
	@echo "  make deploy-eth         Deploy to Ethereum mainnet   (ACCOUNT=name)"
	@echo "  make deploy-arbitrum    Deploy to Arbitrum           (ACCOUNT=name)"
	@echo "  make deploy-local       Deploy to local Anvil (uses mock addresses)"
	@echo ""
	@echo " Verify"
	@echo "  make verify-base        Verify on Basescan  (CONTRACT_BASE in .env)"
	@echo "  make verify-eth         Verify on Etherscan (CONTRACT_ETH in .env)"
	@echo "  make verify-arbitrum    Verify on Arbiscan  (CONTRACT_ARBITRUM in .env)"
	@echo ""
	@echo " Post-deploy"
	@echo "  make warm-approvals     Pre-approve WETH+USDC for all routers on Base"
	@echo ""
	@echo " Run"
	@echo "  make anvil              Anvil forked from Base mainnet"
	@echo "  make install            npm install for off-chain scripts"
	@echo "  make run-monitor        Start price monitor"
	@echo "  make run-bot            Start execution engine"
	@echo "  make run-scan           Sampled historical arb scan (Base)"
	@echo "  make run-scan-dense     Dense every-block arb scan (Base)"
	@echo "──────────────────────────────────────────────────────────────"

# ──────────────────────────────────────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────────────────────────────────────

build:
	$(FORGE) build

sizes:
	$(FORGE) build --sizes

lint:
	$(FORGE) build

clean:
	$(FORGE) clean

# ──────────────────────────────────────────────────────────────────────────────
# Test
# ──────────────────────────────────────────────────────────────────────────────

test:
	$(FORGE) test -vv

test-unit:
	$(FORGE) test --match-contract FlashLoanArbitrageTest -vvv

test-fork:
	$(FORGE) test --match-contract FlashLoanArbitrageForkTest -vv

test-invariant:
	$(FORGE) test --match-contract FlashLoanArbitrageInvariantTest -vv

# Halmos reads halmos.toml for solver_timeout and loop bounds
test-formal:
	$(HALMOS) --match-contract FlashLoanArbitrageFormalTest

# Requires BASE_RPC_URL — replays against real Uniswap V3 / V2 state
test-real-dex:
	$(FORGE) test --match-contract FlashLoanArbitrageRealDexTest \
		--fork-url $(BASE_RPC_URL) -vv

# ──────────────────────────────────────────────────────────────────────────────
# Deploy
# ──────────────────────────────────────────────────────────────────────────────

deploy-base:
	@echo "Deploying to Base mainnet..."
	NETWORK=base $(FORGE) script $(DEPLOY_SCRIPT) \
		--rpc-url base \
		--broadcast \
		--verify \
		--account $(ACCOUNT) \
		-vvv

deploy-eth:
	@echo "Deploying to Ethereum mainnet..."
	NETWORK=ethereum $(FORGE) script $(DEPLOY_SCRIPT) \
		--rpc-url ethereum \
		--broadcast \
		--verify \
		--account $(ACCOUNT) \
		-vvv

deploy-arbitrum:
	@echo "Deploying to Arbitrum..."
	NETWORK=arbitrum $(FORGE) script $(DEPLOY_SCRIPT) \
		--rpc-url arbitrum \
		--broadcast \
		--verify \
		--account $(ACCOUNT) \
		-vvv

deploy-local:
	@echo "Deploying to local Anvil (requires mocks at default addresses)..."
	$(FORGE) script $(LOCAL_DEPLOY_SCRIPT) \
		--rpc-url http://localhost:8545 \
		--broadcast \
		-vvv

# ──────────────────────────────────────────────────────────────────────────────
# Verify  (compiler settings must match foundry.toml exactly)
# ──────────────────────────────────────────────────────────────────────────────

verify-base:
	$(FORGE) verify-contract $(CONTRACT_BASE) \
		src/FlashLoanArbitrage.sol:FlashLoanArbitrage \
		--chain-id 8453 \
		--compiler-version $(SOLC_VERSION) \
		--num-of-optimizations $(OPT_RUNS) \
		--etherscan-api-key $(BASESCAN_API_KEY)

verify-eth:
	$(FORGE) verify-contract $(CONTRACT_ETH) \
		src/FlashLoanArbitrage.sol:FlashLoanArbitrage \
		--chain-id 1 \
		--compiler-version $(SOLC_VERSION) \
		--num-of-optimizations $(OPT_RUNS) \
		--etherscan-api-key $(ETHERSCAN_API_KEY)

verify-arbitrum:
	$(FORGE) verify-contract $(CONTRACT_ARBITRUM) \
		src/FlashLoanArbitrage.sol:FlashLoanArbitrage \
		--chain-id 42161 \
		--compiler-version $(SOLC_VERSION) \
		--num-of-optimizations $(OPT_RUNS) \
		--etherscan-api-key $(ARBISCAN_API_KEY)

# ──────────────────────────────────────────────────────────────────────────────
# Post-deploy
# ──────────────────────────────────────────────────────────────────────────────

# Call warmApprovals([WETH, USDC]) once after deploying to Base so the first
# arb tx doesn't pay ~75k gas per token for cold ERC-20 approvals.
warm-approvals:
	$(CAST) send $(CONTRACT_BASE) \
		"warmApprovals(address[])" "[$(WETH_BASE),$(USDC_BASE)]" \
		--rpc-url $(BASE_RPC_URL) \
		--account $(ACCOUNT)

# ──────────────────────────────────────────────────────────────────────────────
# Local node
# ──────────────────────────────────────────────────────────────────────────────

anvil:
	$(ANVIL) --fork-url $(BASE_RPC_URL)

# ──────────────────────────────────────────────────────────────────────────────
# Off-chain scripts
# ──────────────────────────────────────────────────────────────────────────────

install:
	cd scripts && npm install

run-monitor:
	$(NODE) scripts/priceMonitor.js

run-bot:
	$(NODE) scripts/executionEngine.js

run-scan:
	$(NODE) scripts/scanArb.js

run-scan-dense:
	$(NODE) scripts/scanDense.js
