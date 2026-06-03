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
  "function initiateFlashLoan(address token, uint256 amount, address intermediateToken, uint24 fee, uint256 minProfit, uint8 direction, uint256 minAmountOutFirst, uint256 minAmountOutSecond) external",
  "function withdrawProfit(address token) external",
  "function getBalance(address token) view returns (uint256)",
  "event ArbitrageExecuted(address indexed asset, uint256 profit, uint256 timestamp)",
  "event ArbitrageFailed(string reason, uint256 timestamp)",
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
    const gasPriceGwei = Number(
      ethers.formatUnits(feeData.gasPrice || 0n, "gwei"),
    );
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

    const loanAmount = ethers.parseEther("1"); // Adjust based on your position sizing
    if (loanAmount < EXEC_CONFIG.minLoanAmount[chain]) {
      console.log(`  ⛔ Skipping: loan amount too small`);
      return false;
    }

    return true;
  }

  calculateMinAmounts(opportunity) {
    const slippageMultiplier = (10000 - EXEC_CONFIG.slippageBps) / 10000;

    let minFirst, minSecond;

    if (opportunity.direction.direction === 0) {
      // Uni -> Sushi
      minFirst = Math.floor(
        parseFloat(opportunity.raw.uniAmountOut) * slippageMultiplier,
      ).toString();
      minSecond = Math.floor(
        parseFloat(opportunity.raw.sushiAmountOut) * slippageMultiplier,
      ).toString();
    } else {
      // Sushi -> Uni
      minFirst = Math.floor(
        parseFloat(opportunity.raw.sushiAmountOut) * slippageMultiplier,
      ).toString();
      minSecond = Math.floor(
        parseFloat(opportunity.raw.uniAmountOut) * slippageMultiplier,
      ).toString();
    }

    return { minFirst, minSecond };
  }

  async execute(opportunity) {
    const { chain, pair, netProfitUSD, raw, direction } = opportunity;
    this.stats.attempts++;

    console.log(`\n⚡ EXECUTING ARBITRAGE`);
    console.log(`   Chain  : ${chain}`);
    console.log(`   Pair   : ${pair}`);
    console.log(`   Expected profit: $${netProfitUSD}`);
    console.log(`   Direction: ${direction.buyOn} → ${direction.sellOn}`);

    try {
      const contract = this.contracts[chain];
      const loanAmount = ethers.parseEther("1"); // 1 ETH worth
      const minProfit = ethers.parseUnits(netProfitUSD, raw.decimalsOut);

      const { minFirst, minSecond } = this.calculateMinAmounts(opportunity);

      const minProfitWei = ethers.parseUnits(
        (
          parseFloat(netProfitUSD) / parseFloat(opportunity.uniPrice)
        ).toString(),
        18,
      );

      const tx = await contract.initiateFlashLoan(
        raw.tokenIn,
        loanAmount,
        raw.tokenOut,
        raw.uniswapFee,
        minProfitWei,
        direction.direction,
        minFirst,
        minSecond,
        {
          gasLimit: 500000,
        },
      );

      console.log(`   📤 Tx sent: ${tx.hash}`);
      console.log(`   ⏳ Waiting for confirmation...`);

      const receipt = await tx.wait(1);

      if (receipt.status === 1) {
        this.stats.successes++;
        this.stats.totalProfitUSD += parseFloat(netProfitUSD);
        this.lastExecuted[`${chain}-${pair}`] = Date.now();

        console.log(`   ✅ SUCCESS — block ${receipt.blockNumber}`);
        console.log(
          `   💰 Total profit so far: $${this.stats.totalProfitUSD.toFixed(2)}\n`,
        );

        // Try to withdraw profit
        await this.withdrawProfit(chain, raw.tokenIn);
      } else {
        this.stats.failures++;
        console.log(`   ❌ TX REVERTED — ${tx.hash}\n`);
      }
    } catch (err) {
      this.stats.failures++;
      console.error(`   ❌ Execution error: ${err.message}\n`);
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
    console.log(
      `   Success Rate: ${((this.stats.successes / this.stats.attempts) * 100).toFixed(2)}%`,
    );
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
