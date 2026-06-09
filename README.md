# Flash Loan Arbitrage Bot

## Overview

This project consists of three main pillars: a price monitoring bot, an execution engine, and a smart contract. Together they detect and execute cross-DEX arbitrage opportunities using Morpho flash loans, with no upfront capital required.

---

## The Complete Flow

### Pillar 1 — Price Monitor (`scripts/priceMonitor.js`)

Every **3 seconds**, the monitor runs a poll cycle in three phases:

**Phase 1 — Parallel data fetch.** For every chain and pair simultaneously, it fires `static calls` (read-only, no gas) to each DEX's quoter contract asking: *"if I sell 1 WETH right now, how much USDC do I get?"* and the reverse. It also refreshes the current gas price. All of this runs in parallel to keep the poll fast.

**Phase 2 — ETH price cache.** It uses the WETH/USDC quote results to derive the current ETH price in USD. This is used later to convert gas cost into USD for the profit math.

**Phase 3 — Profit analysis.** For every pair, it compares all DEX quotes against each other. If DEX A is selling WETH cheaper than DEX B is buying it, there's a spread. It then calculates the **net profit** after deducting:
- Swap fees on both DEXes
- Morpho flash loan fee (0.05%)
- Estimated gas cost in USD
- A 0.5% slippage buffer

If net profit exceeds `$1` and spread exceeds `0.1%`, it fires an `"opportunity"` event. There is also a 30-second cooldown per direction per pair to prevent flooding the execution engine with the same opportunity on every 3-second poll.

**Chains and DEXes monitored:**

| Chain | DEXes |
|---|---|
| Base | Uniswap V3, Aerodrome, Aerodrome Slipstream |
| Ethereum | Uniswap V3, SushiSwap V3, SushiSwap V2, Curve Tricrypto |

**Active pairs:** WETH/USDC, USDC/USDT on Base — WETH/USDC, WBTC/USDC, WETH/USDT, WBTC/USDT, WETH/DAI on Ethereum.

---

### Pillar 2 — Execution Engine (`scripts/executionEngine.js`)

The execution engine subscribes to the monitor's event stream at startup via `monitor.on("opportunity", ...)`. The monitor doesn't know the execution engine exists — you can run the monitor standalone to just watch prices without executing anything.

When it receives an `"opportunity"` event:

**Step 1 — Pre-flight checks.** It validates that:
- Net profit is above `$10` (its own higher threshold, separate from the monitor's `$1`)
- The deployed contract exists on that chain
- A 5-second cooldown per pair hasn't elapsed
- Current gas price is below the configured max (0.1 gwei on Base, 40 gwei on Ethereum)
- The spread still meets the minimum

**Step 2 — Build all on-chain parameters.** If checks pass, it:
- Calculates `minAmountOutFirst` and `minAmountOutSecond` — the minimum tokens each swap leg must return, using BigInt arithmetic at the token's native precision with 0.5% slippage tolerance
- Calculates `minProfit` — the minimum profit in `tokenBorrowed` units the round-trip must produce, derived directly from expected swap outputs minus the loan amount
- Sets a 2-minute `deadline` — the contract reverts if the transaction isn't included within this window
- Fetches current block number and gas price, then sets `maxGasPrice` (current + 20% headroom) and `validUntilBlock` (current block + 2 on Ethereum, +5 on Base) for on-chain MEV protection
- Calls `estimateGas` on the contract function to get the actual gas needed, then adds a 30% buffer

**Step 3 — Submit the transaction.** Calls `initiateProtectedFlashLoan` on the deployed contract with all parameters, then waits for the receipt.

**Step 4 — Post-execution.** On success, it parses the `ArbitrageExecuted` event from the receipt to get the actual profit (not the pre-execution estimate), then calls `withdrawProfit` to move profit tokens from the contract to the owner wallet.

---

### Pillar 3 — Smart Contract (`src/FlashLoanArbitrage.sol`)

**Step 1 — `initiateProtectedFlashLoan` is called.** The contract validates all inputs (deadline, direction, MEV guards). It bundles the arb parameters into a `bytes` payload and calls `MORPHO.flashLoan(token, amount, data)`.

**Step 2 — Morpho sends the tokens.** Morpho transfers the borrowed amount directly to the contract, then immediately calls back `onMorphoFlashLoan` on the contract.

**Step 3 — The callback executes the arb.** Inside the callback:
- Verifies Morpho is the caller (security check)
- Executes the two-leg swap: if direction `0`, sells on Uniswap V3 first then SushiSwap V2; if direction `1`, the reverse
- Checks that the final balance covers loan repayment AND exceeds `minProfit` — if either fails, it **reverts the entire transaction**, unwinding everything including the flash loan
- If profitable, approves Morpho to pull back the principal

**Step 4 — Profit stays in the contract.** The net profit above the repayment amount remains in the contract until the execution engine's `withdrawProfit` call transfers it to the owner wallet.

---

## Data Flow

```
RPC nodes → Price Monitor quotes DEXes → finds spread → emits event
  → Execution Engine validates + builds params → calls contract
    → Contract calls Morpho → Morpho sends tokens → callback runs swaps
      → profit check passes → Morpho recoups principal → profit stays in contract
        → Execution Engine withdraws profit to wallet
```

---

## Environment Variables

```
PRIVATE_KEY=        # Owner wallet private key
BASE_RPC_URL=       # Base mainnet RPC endpoint
ETH_RPC_URL=        # Ethereum mainnet RPC endpoint
CONTRACT_BASE=      # Deployed FlashLoanArbitrage address on Base
CONTRACT_ETH=       # Deployed FlashLoanArbitrage address on Ethereum
```

---

## Running

```shell
# Monitor only (no execution)
node scripts/priceMonitor.js

# Full bot (monitor + execution)
node scripts/executionEngine.js
```
