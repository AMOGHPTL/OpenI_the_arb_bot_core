/**
 * Execution Engine with Morpho Flash Loans
 * Listens to PriceMonitor, validates opportunities, triggers Morpho flash loan contract
 */

const { ethers } = require("ethers");
const { PriceMonitor, CONFIG } = require("./priceMonitor");

// ─── YOUR DEPLOYED CONTRACT ADDRESS ───────────────────────────────────────────
const CONTRACTS = {
  base: process.env.CONTRACT_BASE || "0xYOUR_BASE_CONTRACT_ADDRESS",
  ethereum: process.env.CONTRACT_ETH || "0xYOUR_ETH_CONTRACT_ADDRESS",
};

const WALLET_PRIVATE_KEY = process.env.PRIVATE_KEY;

// ─── Flash Loan Contract ABI (Morpho version) ───────────────────────────────────
const FLASH_LOAN_ABI = [
  "function initiateFlashLoan(address token, uint256 amount, address intermediateToken, uint24 fee, uint256 minProfit, uint8 direction, uint256 minAmountOutFirst, uint256 minAmountOutSecond, uint256 deadline) external",
  "function initiateProtectedFlashLoan(address token, uint256 amount, address intermediateToken, uint24 fee, uint256 minProfit, uint8 direction, uint256 minAmountOutFirst, uint256 minAmountOutSecond, uint256 deadline, uint160 uniswapSqrtPriceLimitX96, uint256 maxGasPrice, uint256 validUntilBlock) external",
  "function withdrawProfit(address token) external",
  "function getBalance(address token) view returns (uint256)",
  "event ArbitrageExecuted(address indexed asset, uint256 profit, uint256 timestamp)",
];

// ─── EXECUTION CONFIG ──────────────────────────────────────────────────────────
const EXEC_CONFIG = {
  minProfitUSD: 10,
  slippageBps: 50, // 0.5% slippage tolerance
  maxGasPriceGwei: {
    base: 0.1,
    ethereum: 40,
  },
  cooldownMs: 5000,
  useFlashbotsOnEth: true,
  flashbotsRpc: "https://rpc.flashbots.net",
  minLoanAmount: {
    base: ethers.parseEther("0.5"), // 0.5 ETH minimum loan
    ethereum: ethers.parseEther("5"), // 5 ETH minimum loan
  },
};

class ExecutionEngine {
  constructor() {
    this.monitor = new PriceMonitor();
    this.wallets = {};
    this.contracts = {};
    this.lastExecuted = {};
    this.stats = { attempts: 0, successes: 0, failures: 0, totalProfitUSD: 0 };
    this.executing = {}; // per-chain concurrency lock
  }

  async init() {
    if (!WALLET_PRIVATE_KEY) {
      throw new Error("❌ PRIVATE_KEY env variable not set");
    }

    for (const [chainName, chainCfg] of Object.entries(CONFIG.chains)) {
      let rpcUrl = chainCfg.rpc;

      if (chainName === "ethereum" && EXEC_CONFIG.useFlashbotsOnEth) {
        rpcUrl = EXEC_CONFIG.flashbotsRpc;
        console.log("🛡️ Ethereum: using Flashbots RPC (MEV protection)");
      }

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
      this.wallets[chainName] = wallet;

      if (CONTRACTS[chainName] && !CONTRACTS[chainName].includes("YOUR_")) {
        this.contracts[chainName] = new ethers.Contract(
          CONTRACTS[chainName],
          FLASH_LOAN_ABI,
          wallet,
        );
        console.log(
          `✅ Connected to ${chainName} contract at ${CONTRACTS[chainName]}`,
        );
      } else {
        console.warn(`⚠️ No contract deployed for ${chainName} — skipping`);
      }
    }
  }

  async passesChecks(opportunity) {
    const { chain, pair, netProfitUSD, spreadPct, raw } = opportunity;

    if (parseFloat(netProfitUSD) < EXEC_CONFIG.minProfitUSD) {
      console.log(
        `  ⛔ Skipping: profit $${netProfitUSD} < min $${EXEC_CONFIG.minProfitUSD}`,
      );
      return false;
    }

    if (!this.contracts[chain]) {
      console.log(`  ⛔ Skipping: no contract on ${chain}`);
      return false;
    }

    const cooldownKey = `${chain}-${pair}`;
    const lastTime = this.lastExecuted[cooldownKey] || 0;
    if (Date.now() - lastTime < EXEC_CONFIG.cooldownMs) {
      console.log(`  ⛔ Skipping: cooldown active for ${cooldownKey}`);
      return false;
    }

    const provider = this.wallets[chain].provider;
    const feeData = await provider.getFeeData();
    // Use EIP-1559 maxFeePerGas on chains that support it; fall back to legacy gasPrice
    const effectiveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasPriceGwei = Number(ethers.formatUnits(effectiveGasPrice, "gwei"));
    const maxAllowed = EXEC_CONFIG.maxGasPriceGwei[chain];

    if (gasPriceGwei > maxAllowed) {
      console.log(
        `  ⛔ Skipping: gas ${gasPriceGwei.toFixed(3)} gwei > max ${maxAllowed} gwei`,
      );
      return false;
    }

    if (parseFloat(spreadPct) < CONFIG.minSpreadPercent) {
      console.log(`  ⛔ Skipping: spread ${spreadPct}% too low`);
      return false;
    }

    return true;
  }

  calculateMinAmounts(opportunity) {
    const slippageBps = BigInt(EXEC_CONFIG.slippageBps);
    const basisPoints = 10000n;

    const applySlippage = (amount) =>
      (BigInt(amount) * (basisPoints - slippageBps)) / basisPoints;

    let minFirst, minSecond;

    if (opportunity.direction.direction === 0) {
      // Uni -> Sushi
      minFirst = applySlippage(opportunity.raw.uniAmountOut).toString();
      minSecond = applySlippage(opportunity.raw.sushiAmountOut).toString();
    } else {
      // Sushi -> Uni
      minFirst = applySlippage(opportunity.raw.sushiAmountOut).toString();
      minSecond = applySlippage(opportunity.raw.uniAmountOut).toString();
    }

    return { minFirst, minSecond };
  }

  // Compute minProfit in tokenBorrowed units directly from expected swap outputs,
  // with slippage applied. Avoids any USD/price conversion entirely.
  calculateMinProfit(opportunity, loanAmount) {
    const slippageBps = BigInt(EXEC_CONFIG.slippageBps);
    const basisPoints = 10000n;

    // The second swap always returns tokenBorrowed. For direction 0 (Uni→Sushi)
    // the round-trip output is sushiAmountOut; for direction 1 (Sushi→Uni) it's uniAmountOut.
    const finalAmount =
      opportunity.direction.direction === 0
        ? BigInt(opportunity.raw.sushiAmountOut)
        : BigInt(opportunity.raw.uniAmountOut);

    const expectedProfit = finalAmount - loanAmount;
    if (expectedProfit <= 0n) return 0n;
    return (expectedProfit * (basisPoints - slippageBps)) / basisPoints;
  }

  async execute(opportunity) {
    const { chain, pair, netProfitUSD, raw, direction } = opportunity;

    // Per-chain concurrency guard — prevents nonce collisions from overlapping executions
    if (this.executing[chain]) {
      console.log(`  ⛔ Skipping: execution already in progress on ${chain}`);
      return;
    }
    this.executing[chain] = true;
    this.stats.attempts++;

    console.log(`\n⚡ EXECUTING ARBITRAGE`);
    console.log(`   Chain  : ${chain}`);
    console.log(`   Pair   : ${pair}`);
    console.log(`   Expected profit: $${netProfitUSD}`);
    console.log(`   Direction: ${direction.buyOn} → ${direction.sellOn}`);

    try {
      const contract = this.contracts[chain];
      const provider = this.wallets[chain].provider;
      const loanAmount = ethers.parseUnits("1", raw.decimalsIn ?? 18);

      const { minFirst, minSecond } = this.calculateMinAmounts(opportunity);
      const minProfitWei = this.calculateMinProfit(opportunity, loanAmount);
      const deadline = Math.floor(Date.now() / 1000) + 120;

      // On-chain MEV guards: cap gas price and restrict to a short block window
      const [feeData, currentBlock] = await Promise.all([
        provider.getFeeData(),
        provider.getBlockNumber(),
      ]);
      const effectiveGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      // Allow 20% gas price headroom so the tx isn't rejected by a minor spike
      const maxGasPrice = (effectiveGasPrice * 12n) / 10n;
      const validUntilBlock = currentBlock + (chain === "base" ? 5 : 2);

      const callArgs = [
        raw.tokenIn,
        loanAmount,
        raw.tokenOut,
        raw.uniswapFee,
        minProfitWei,
        direction.direction,
        minFirst,
        minSecond,
        deadline,
        0,           // uniswapSqrtPriceLimitX96 — 0 means no price limit
        maxGasPrice,
        validUntilBlock,
      ];

      // Estimate gas dynamically so we don't over/under-allocate
      const estimatedGas = await contract.initiateProtectedFlashLoan.estimateGas(...callArgs);
      const gasLimit = (estimatedGas * 130n) / 100n; // 30% buffer

      const tx = await contract.initiateProtectedFlashLoan(...callArgs, { gasLimit });

      console.log(`   📤 Tx sent: ${tx.hash}`);
      console.log(`   ⏳ Waiting for confirmation...`);

      const receipt = await tx.wait(1);

      if (receipt.status === 1) {
        this.stats.successes++;
        this.lastExecuted[`${chain}-${pair}`] = Date.now();

        // Read actual profit from the ArbitrageExecuted event rather than the estimate
        const arbLog = receipt.logs
          .map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } })
          .find((e) => e?.name === "ArbitrageExecuted");

        let profitUSD = parseFloat(netProfitUSD);
        if (arbLog) {
          const profitTokens = Number(
            ethers.formatUnits(arbLog.args.profit, raw.decimalsIn ?? 18),
          );
          const price = parseFloat(opportunity.uniPrice);
          if (price > 0) profitUSD = profitTokens * price;
        }
        this.stats.totalProfitUSD += profitUSD;

        console.log(`   ✅ SUCCESS — block ${receipt.blockNumber}`);
        console.log(`   💰 Actual profit: $${profitUSD.toFixed(2)}`);
        console.log(
          `   💰 Total profit so far: $${this.stats.totalProfitUSD.toFixed(2)}\n`,
        );

        await this.withdrawProfit(chain, raw.tokenIn);
      } else {
        this.stats.failures++;
        console.log(`   ❌ TX REVERTED — ${tx.hash}\n`);
      }
    } catch (err) {
      this.stats.failures++;
      console.error(`   ❌ Execution error: ${err.message}\n`);
    } finally {
      this.executing[chain] = false;
    }
  }

  async withdrawProfit(chain, token) {
    try {
      const contract = this.contracts[chain];
      const balance = await contract.getBalance(token);

      if (balance > 0) {
        const tx = await contract.withdrawProfit(token);
        await tx.wait();
        console.log(
          `   💸 Profit withdrawn: ${ethers.formatEther(balance)} tokens`,
        );
      }
    } catch (err) {
      console.log(`   ⚠️ Could not withdraw profit: ${err.message}`);
    }
  }

  printStats() {
    console.log("\n📊 STATS");
    console.log(`   Attempts  : ${this.stats.attempts}`);
    console.log(`   Successes : ${this.stats.successes}`);
    console.log(`   Failures  : ${this.stats.failures}`);
    const successRate =
      this.stats.attempts > 0
        ? ((this.stats.successes / this.stats.attempts) * 100).toFixed(2)
        : "0.00";
    console.log(`   Success Rate: ${successRate}%`);
    console.log(`   Total P&L : $${this.stats.totalProfitUSD.toFixed(2)}\n`);
  }

  async start() {
    console.log("🤖 Flash Loan Arbitrage Bot Starting (Morpho)...\n");
    await this.init();

    this.monitor.on("opportunity", async (opportunity) => {
      console.log(
        `\n🎯 Opportunity received: ${opportunity.pair} on ${opportunity.chain}`,
      );

      const safe = await this.passesChecks(opportunity);
      if (safe) {
        await this.execute(opportunity);
      }
    });

    setInterval(() => this.printStats(), 60000);
    await this.monitor.start();
  }

  stop() {
    this.monitor.stop();
    this.printStats();
  }
}

const engine = new ExecutionEngine();
engine.start().catch(console.error);

process.on("SIGINT", () => {
  engine.stop();
  process.exit(0);
});
