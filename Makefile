.PHONY: help build test deploy-base deploy-eth deploy-arbitrum deploy-local verify clean

help:
	@echo "Flash Loan Arbitrage Bot - Foundry Commands"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "make build         - Build the contracts"
	@echo "make test          - Run tests"
	@echo "make test-fork     - Run fork tests"
	@echo "make deploy-base   - Deploy to Base mainnet"
	@echo "make deploy-eth    - Deploy to Ethereum mainnet"
	@echo "make deploy-arbitrum - Deploy to Arbitrum"
	@echo "make deploy-local  - Deploy to local anvil"
	@echo "make verify-base   - Verify contract on BaseScan"
	@echo "make clean         - Clean build artifacts"
	@echo "make run-monitor   - Run price monitor"
	@echo "make run-bot       - Run execution engine"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

build:
	forge build

test:
	forge test

test-fork:
	forge test --fork-url base -vvv

deploy-base:
	@echo "Deploying to Base mainnet..."
	forge script script/DeployFlashLoanArb.s.sol:DeployFlashLoanArb \
		--rpc-url base \
		--broadcast \
		--verify \
		--private-key $(PRIVATE_KEY) \
		-vvv

deploy-eth:
	@echo "Deploying to Ethereum mainnet..."
	forge script script/DeployFlashLoanArb.s.sol:DeployFlashLoanArb \
		--rpc-url ethereum \
		--broadcast \
		--verify \
		--private-key $(PRIVATE_KEY) \
		-vvv

deploy-arbitrum:
	@echo "Deploying to Arbitrum..."
	forge script script/DeployFlashLoanArb.s.sol:DeployFlashLoanArb \
		--rpc-url arbitrum \
		--broadcast \
		--verify \
		--private-key $(PRIVATE_KEY) \
		-vvv

deploy-local:
	@echo "Starting local anvil node..."
	@make anvil & sleep 3
	@echo "Deploying locally..."
	forge script script/DeployFlashLoanArbLocal.s.sol:DeployFlashLoanArbLocal \
		--rpc-url http://localhost:8545 \
		--broadcast \
		-vvv
	@echo "Local deployment complete. Anvil node running in background."

anvil:
	anvil --fork-url https://mainnet.base.org --fork-block-number 20000000

verify-base:
	forge verify-contract \
		--chain-id 8453 \
		--num-of-optimizations 200 \
		--compiler-version v0.8.23 \
		$(CONTRACT_BASE) \
		src/FlashLoanArbitrage.sol:FlashLoanArbitrage \
		$(ETHERSCAN_API_KEY)

clean:
	forge clean
	rm -rf deployments/*.json

run-monitor:
	node scripts/priceMonitor.js

run-bot:
	node scripts/executionEngine.js

.PHONY: help build test deploy-base deploy-eth deploy-local verify clean

# 1. Build the project
forge build

# 2. Run tests
forge test

# 3. Deploy to Base (using Makefile)
make deploy-base

# Or manually:
NETWORK=base forge script script/DeployFlashLoanArb.s.sol:DeployFlashLoanArb \
  --rpc-url base \
  --broadcast \
  --verify \
  --private-key $PRIVATE_KEY

# 4. Deploy to Ethereum
make deploy-eth

# 5. Deploy locally for testing
make deploy-local

# 6. Run the Node.js bot
cd scripts
npm install
node executionEngine.js