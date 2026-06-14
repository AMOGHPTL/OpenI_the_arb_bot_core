# Flash Loan Arbitrage Bot

## Overview

This project detects and executes cross-DEX arbitrage opportunities using Morpho flash loans, with no upfront capital required. It is built around five pillars:

0. **Research / scanning** — offline tools that quantify whether a spread worth chasing actually exists on a given chain and pair.
1. **Price monitor** — a live multi-chain, multi-DEX price watcher that emits opportunity events.
2. **Execution engine** — validates opportunities and submits the on-chain transaction.
3. **Smart contract** — the flash-loan + two-leg swap logic that runs atomically on-chain.
4. **Tests & formal verification** — unit, fork, real-DEX, invariant/fuzz, and Halmos symbolic proofs.

> **Empirical note:** A dense, every-block scan of the Uniswap V3 (0.05%) vs Uniswap V2 WETH/USDC spread on Base showed the spread effectively never clears the combined fee floor (V2 0.30% + V3 0.05% = 0.35%) for long enough to execute. In other words, that specific pair on Base is **not** profitably arbitrageable with this strategy. Re-run the scanner (Pillar 0) on any new chain/pair before deploying capital.

---

## The Complete Flow

### Pillar 0 — Research / Scanning (`scripts/scanArb.js`, `scripts/scanDense.js`)

Before risking gas, these read-only tools measure the historical spread between two pools directly from on-chain state (Uniswap V3 `slot0()` and V2 `getReserves()`), with no quoter round-trips.

- **`scanArb.js`** — *sampled* scan. Walks back a large block range (default ~500k blocks ≈ 11 days on Base) sampling 1 block every `STEP` (default 500). Fast and cheap, but by design it misses short-lived spreads. Prints the top opportunities and the exact `forge test ... --fork-block-number <n>` command to replay each one.
- **`scanDense.js`** — *contiguous, every-block* scan. Checks **every** block in the window using Multicall3 (one `eth_call` per block) so "no opportunities" becomes a quantified statement rather than an absence of data. Outputs a full spread distribution, the longest consecutive run above the fee floor, and a per-block CSV (`scripts/scan-dense.csv`).

```shell
node scripts/scanArb.js                          # sampled, ~11 days
node scripts/scanDense.js                         # dense, last 7200 blocks (~4h)
BLOCKS=21600 node scripts/scanDense.js            # dense, last ~12h
```

Both require an archive-capable RPC (Alchemy free tier on Base works) set via `BASE_RPC_URL`.

---

### Pillar 1 — Price Monitor (`scripts/priceMonitor.js`)

Every **3 seconds** (`pollIntervalMs`), the monitor runs a poll cycle in three phases:

**Phase 1 — Parallel data fetch.** For every chain and enabled pair simultaneously, it fires static calls (read-only, no gas) to each DEX's quoter asking *"if I sell `amountIn` right now, how much do I get?"* and the reverse. It also refreshes the cached gas price. A per-DEX `quoteTimeoutMs` (5 s) prevents a hung RPC from stalling the whole poll.

**Phase 2 — ETH price cache.** It derives the current ETH price in USD from the WETH/USDC quotes, used later to convert gas cost into USD.

**Phase 3 — Profit analysis.** For every pair it compares all DEX quotes against each other. If one DEX sells cheaper than another buys, there is a spread. It computes **net profit** after deducting swap fees on both legs, a 0.05% flash-loan buffer (`morphoFeePercent`), estimated gas in USD, and a 0.5% slippage buffer.

> **Note on the flash-loan fee:** Morpho Blue flash loans are **free** — `flashFee` is zero, and the contract repays exactly the borrowed `amount` with no fee added. The monitor's `morphoFeePercent` (0.05%) is therefore a deliberately conservative safety margin baked into the profit math, **not** a real on-chain cost.

If net profit exceeds `minNetProfitUSD` ($1) and spread exceeds `minSpreadPercent` (0.1%), it emits an `"opportunity"` event. A 30-second per-direction-per-pair cooldown (`oppCooldownMs`) prevents flooding the execution engine on every poll.

**Chains and DEXes monitored:**

| Chain | DEXes (quote sources) |
|---|---|
| Base | Uniswap V3, Aerodrome, Aerodrome Slipstream |
| Ethereum | Uniswap V3, SushiSwap V3, SushiSwap V2, Curve Tricrypto |

**Active pairs:** WETH/USDC and USDC/USDT on Base — WETH/USDC, WBTC/USDC, WETH/USDT, WBTC/USDT, WETH/DAI on Ethereum. (Base WETH/USDT, WETH/DAI, and cbETH/USDC are disabled in config due to thin bridged-stable liquidity.)

The monitor is standalone: it emits events but knows nothing about the execution engine, so you can run it alone just to watch prices.

---

### Pillar 2 — Execution Engine (`scripts/executionEngine.js`)

Subscribes to the monitor at startup via `monitor.on("opportunity", ...)`. On Ethereum it routes transactions through the **Flashbots RPC** for MEV protection.

When it receives an `"opportunity"` event:

**Step 1 — Pre-flight checks (`passesChecks`).**
- Net profit above `$10` (its own higher threshold, separate from the monitor's `$1`)
- A deployed contract exists for that chain
- A 5-second per-pair cooldown has elapsed
- Effective gas price (EIP-1559 `maxFeePerGas`, falling back to legacy `gasPrice`) is below the configured max (0.1 gwei Base, 40 gwei Ethereum)
- The spread still meets the minimum

**Step 2 — Build on-chain parameters.**
- `amount` — the flash-loan size. Currently **hardcoded to 1 unit of `tokenIn`** (`parseUnits("1", decimalsIn)`); the `minLoanAmount` values in `EXEC_CONFIG` are defined but **not yet wired into sizing**.
- `minAmountOutFirst` / `minAmountOutSecond` — minimum output per leg, computed with BigInt at native precision and 0.5% slippage tolerance
- `minProfit` — minimum round-trip profit in `tokenBorrowed` units, derived directly from expected swap outputs minus the loan (no USD conversion)
- A 2-minute `deadline`
- On-chain MEV guards: `maxGasPrice` (current + 20% headroom) and `validUntilBlock` (current + 2 on Ethereum, +5 on Base)
- `estimateGas` on the contract call, then a 30% buffer
- A per-chain concurrency lock prevents overlapping executions from colliding on nonces

**Step 3 — Submit.** Calls `initiateProtectedFlashLoan` with all parameters and waits for the receipt.

**Step 4 — Post-execution.** On success, parses the `ArbitrageExecuted` event for the *actual* profit, then calls `withdrawProfit` to move profit tokens to the owner wallet. Running stats (attempts / successes / failures / P&L) print every 60 s.

---

### Pillar 3 — Smart Contract (`src/FlashLoanArbitrage.sol`)

A generic two-router arbitrage contract. The constructor wires three immutables: Morpho Blue, a **Uniswap V3 SwapRouter02** (leg using `exactInputSingle`), and a **UniV2-compatible router** ("DEX2" — Uniswap V2 on Base, SushiSwap V2 on Ethereum/Arbitrum). Note: Aerodrome uses a `Route[]` struct and is **not** UniV2-compatible, so it cannot be used as DEX2.

Hardening:
- **`Ownable2Step`** — ownership transfer requires the new owner to accept.
- **`ReentrancyGuardTransient`** — EIP-1153 transient-storage reentrancy guard (~4.9k gas cheaper; requires Cancun, live on Base).
- **Cached max approvals** — each `token→spender` is approved once; `warmApprovals([...])` pre-approves both routers and Morpho so the first arb of a pair doesn't pay ~75k gas of cold approvals inside the profit-critical tx.

**Entrypoints (owner-only):**
- `initiateFlashLoan(...)` — unprotected variant (no MEV guards), zeros passed for guard fields.
- `initiateProtectedFlashLoan(..., uniswapSqrtPriceLimitX96, maxGasPrice, validUntilBlock)` — the variant the execution engine uses.

**Execution path:**

1. The chosen entrypoint validates inputs (non-zero amount/addresses, distinct tokens, valid direction, unexpired deadline, non-zero min-outs) and the MEV guards, encodes the parameters, and calls `MORPHO.flashLoan(token, amount, data)`.
2. Morpho transfers the borrowed tokens, then calls back `onMorphoFlashLoan`.
3. In the callback: verify the caller is Morpho, **re-validate the MEV guards**, confirm the loan was received, then run the two-leg swap — direction `0` is Uniswap V3 → DEX2; direction `1` is the reverse. It checks the post-trade balance covers repayment **and** that profit ≥ `minProfit`; if either fails it **reverts the whole transaction**, unwinding the flash loan. On success it ensures Morpho is approved to reclaim the principal and emits `ArbitrageExecuted`.
4. Net profit stays in the contract until `withdrawProfit` transfers it out.

**Admin / safety functions:** `warmApprovals`, `revokeApproval`, `withdrawProfit`, `rescueTokens`, `rescueETH`, `getBalance`.

---

### Pillar 4 — Tests & Formal Verification (`test/`)

| Suite | File | What it covers |
|---|---|---|
| Unit | `FlashLoanArbitrage.t.sol` | Deployment, access control, slippage/MEV reverts, both swap directions, approvals, "existing balance can't mask a bad trade" |
| Fork | `FlashLoanArbitrageFork.t.sol` | Real Morpho callback + repayment on a fork |
| Real DEX | `FlashLoanArbitrageRealDex.t.sol` | Both legs on real Base routers; includes a price-manipulation test that creates a spread then verifies the contract captures it |
| Invariant / fuzz | `FlashLoanArbitrageInvariant.t.sol` | Owner immutability, access control never breaks, Morpho always repaid, USDC supply conserved, no spurious ETH |
| Formal (Halmos) | `FlashLoanArbitrageFormal.t.sol` | Symbolic proofs: only-owner / only-Morpho gates, input-validation reverts, unchecked-subtraction can't underflow, block-window guard, constructor immutables |

```shell
make test            # all forge tests
make test-unit       # unit only
make test-fork       # Base fork test
halmos --match-contract Formal --solver-timeout-assertion 60000   # symbolic proofs
```

---

## Data Flow

```
Scanner (offline) → confirms a spread clears the fee floor on the target pair
  → Price Monitor quotes DEXes → finds spread → emits "opportunity"
    → Execution Engine validates + builds params → initiateProtectedFlashLoan
      → Contract calls Morpho → Morpho sends tokens → callback runs two-leg swap
        → profit ≥ minProfit check passes → Morpho reclaims principal → profit stays in contract
          → Execution Engine withdraws profit to wallet
```

---

## Environment Variables

```
PRIVATE_KEY=          # Owner wallet private key
BASE_RPC_URL=         # Base mainnet RPC (archive-capable for scanning)
ETH_RPC_URL=          # Ethereum mainnet RPC
ARBITRUM_RPC_URL=     # Arbitrum RPC (optional)
CONTRACT_BASE=        # Deployed FlashLoanArbitrage address on Base
CONTRACT_ETH=         # Deployed FlashLoanArbitrage address on Ethereum
BASESCAN_API_KEY=     # For contract verification (and ETHERSCAN_API_KEY / ARBISCAN_API_KEY)
```

---

## Build, Deploy & Run

Deployment is Foundry-based via the `Makefile` (`script/FlashLoanDeploy.s.sol` wires the correct routers per network):

```shell
make build           # forge build
make deploy-base     # deploy + verify on Base
make deploy-eth      # deploy + verify on Ethereum
make deploy-local    # deploy to a local Anvil fork
make anvil           # start a Base-forked Anvil node
```

After deploying, call `warmApprovals([USDC, WETH])` once per pair to avoid cold-approval gas on the first arb.

Running the bot:

```shell
make run-monitor     # or: node scripts/priceMonitor.js   (watch prices only)
make run-bot         # or: node scripts/executionEngine.js (monitor + execute)
```
