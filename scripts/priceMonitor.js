/**
 * Price Monitoring Bot with Morpho Integration
 * Watches Uniswap V3 vs SushiSwap on Base & Ethereum
 */

const { ethers } = require("ethers");
const EventEmitter = require("events");

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const CONFIG = {
  chains: {
    base: {
      rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFFa", // Morpho Blue on Base
      uniswapV3Quoter: "0x3d4e44Eb1374240CE5F1B136041212501e4a3569",
      sushiswapRouter: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
    },
    ethereum: {
      rpc: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
      chainId: 1,
      morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFFa", // Morpho Blue on Ethereum
      uniswapV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      sushiswapRouter: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    },
  },

  // Token pairs to monitor
  pairs: [
    {
      name: "WETH/USDC",
      tokenIn: "0x4200000000000000000000000000000000000006", // WETH on Base
      tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
      decimalsIn: 18,
      decimalsOut: 6,
      amountIn: ethers.parseEther("1"), // quote 1 WETH
      uniswapFee: 500, // 0.05% pool
    },
    {
      name: "WETH/USDT",
      tokenIn: "0x4200000000000000000000000000000000000006",
      tokenOut: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimalsIn: 18,
      decimalsOut: 6,
      amountIn: ethers.parseEther("1"),
      uniswapFee: 500,
    },
  ],

  // Minimum spread (%) to flag as opportunity
  minSpreadPercent: 0.3,

  // How often to poll (ms)
  pollIntervalMs: 3000,

  // Gas estimate for arbitrage tx (used in profit calc)
  estimatedGasUnits: 400000n,

  // Morpho flash loan fee (usually 0.05% or less)
  morphoFeePercent: 0.0005,
};

// ─── ABIs ──────────────────────────────────────────────────────────────────────

const UNISWAP_V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const SUSHI_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)",
];

// ─── PRICE MONITOR CLASS ───────────────────────────────────────────────────────

class PriceMonitor extends EventEmitter {
  constructor() {
    super();
    this.providers = {};
    this.contracts = {};
    this.running = false;
    this.opportunities = [];
  }

  async init() {
    console.log("🔌 Connecting to chains...");

    for (const [chainName, cfg] of Object.entries(CONFIG.chains)) {
      const provider = new ethers.JsonRpcProvider(cfg.rpc);
      this.providers[chainName] = provider;

      this.contracts[chainName] = {
        uniQuoter: new ethers.Contract(
          cfg.uniswapV3Quoter,
          UNISWAP_V3_QUOTER_ABI,
          provider,
        ),
        sushiRouter: new ethers.Contract(
          cfg.sushiswapRouter,
          SUSHI_ROUTER_ABI,
          provider,
        ),
      };

      const block = await provider.getBlockNumber();
      console.log(`  ✅ ${chainName}: connected at block ${block}`);
    }

    console.log("✅ Monitor initialized\n");
  }

  async getUniswapPrice(chainName, pair) {
    try {
      const { uniQuoter } = this.contracts[chainName];

      const result = await uniQuoter.quoteExactInputSingle.staticCall({
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        amountIn: pair.amountIn,
        fee: pair.uniswapFee,
        sqrtPriceLimitX96: 0n,
      });

      const amountOut = result[0];
      const price = Number(ethers.formatUnits(amountOut, pair.decimalsOut));
      return { price, amountOut, source: "uniswap_v3" };
    } catch (err) {
      console.warn(
        `  ⚠️ Uniswap quote failed [${chainName}/${pair.name}]: ${err.message}`,
      );
      return null;
    }
  }

  async getSushiPrice(chainName, pair) {
    try {
      const { sushiRouter } = this.contracts[chainName];
      const path = [pair.tokenIn, pair.tokenOut];
      const amounts = await sushiRouter.getAmountsOut(pair.amountIn, path);

      const amountOut = amounts[1];
      const price = Number(ethers.formatUnits(amountOut, pair.decimalsOut));
      return { price, amountOut, source: "sushiswap" };
    } catch (err) {
      console.warn(
        `  ⚠️ Sushi quote failed [${chainName}/${pair.name}]: ${err.message}`,
      );
      return null;
    }
  }

  async estimateGasCostUSD(chainName, ethPriceUSD) {
    try {
      const provider = this.providers[chainName];
      const feeData = await provider.getFeeData();
      const gasPriceWei = feeData.gasPrice || feeData.maxFeePerGas;
      const gasCostWei = gasPriceWei * CONFIG.estimatedGasUnits;
      const gasCostETH = Number(ethers.formatEther(gasCostWei));
      return gasCostETH * ethPriceUSD;
    } catch {
      return 0;
    }
  }

  async analyseSpread(chainName, pair, uniPrice, sushiPrice) {
    const spread = Math.abs(uniPrice.price - sushiPrice.price);
    const spreadPct =
      (spread / Math.min(uniPrice.price, sushiPrice.price)) * 100;

    const ethPriceUSD = Math.max(uniPrice.price, sushiPrice.price);
    const gasCostUSD = await this.estimateGasCostUSD(chainName, ethPriceUSD);

    const grossProfitUSD = spread;

    // Fees: Morpho flash loan + swap fees
    const flashLoanFeeUSD = uniPrice.price * CONFIG.morphoFeePercent;
    const uniSwapFeeUSD = uniPrice.price * 0.0005; // 0.05%
    const sushiSwapFeeUSD = uniPrice.price * 0.003; // 0.30%
    const totalFeesUSD = flashLoanFeeUSD + uniSwapFeeUSD + sushiSwapFeeUSD;

    const netProfitUSD = grossProfitUSD - totalFeesUSD - gasCostUSD;

    const buyOn =
      uniPrice.price < sushiPrice.price ? "uniswap_v3" : "sushiswap";
    const sellOn = buyOn === "uniswap_v3" ? "sushiswap" : "uniswap_v3";
    const direction = buyOn === "uniswap_v3" ? 0 : 1;

    return {
      chain: chainName,
      pair: pair.name,
      timestamp: Date.now(),
      uniPrice: uniPrice.price,
      sushiPrice: sushiPrice.price,
      spreadPct: spreadPct.toFixed(4),
      grossProfitUSD: grossProfitUSD.toFixed(2),
      flashLoanFeeUSD: flashLoanFeeUSD.toFixed(2),
      swapFeesUSD: (uniSwapFeeUSD + sushiSwapFeeUSD).toFixed(2),
      gasCostUSD: gasCostUSD.toFixed(2),
      netProfitUSD: netProfitUSD.toFixed(2),
      isProfitable: netProfitUSD > 0 && spreadPct >= CONFIG.minSpreadPercent,
      direction: { buyOn, sellOn, direction },
      raw: {
        amountIn: pair.amountIn.toString(),
        uniAmountOut: uniPrice.amountOut.toString(),
        sushiAmountOut: sushiPrice.amountOut.toString(),
        tokenIn: pair.tokenIn,
        tokenOut: pair.tokenOut,
        uniswapFee: pair.uniswapFee,
      },
    };
  }

  async poll() {
    for (const chainName of Object.keys(CONFIG.chains)) {
      for (const pair of CONFIG.pairs) {
        const [uniPrice, sushiPrice] = await Promise.all([
          this.getUniswapPrice(chainName, pair),
          this.getSushiPrice(chainName, pair),
        ]);

        if (!uniPrice || !sushiPrice) continue;

        const opportunity = await this.analyseSpread(
          chainName,
          pair,
          uniPrice,
          sushiPrice,
        );

        this.emit("price", opportunity);

        if (opportunity.isProfitable) {
          this.opportunities.push(opportunity);
          this.emit("opportunity", opportunity);
          console.log(`\n🚨 OPPORTUNITY FOUND`);
          console.log(`   Chain     : ${opportunity.chain}`);
          console.log(`   Pair      : ${opportunity.pair}`);
          console.log(`   Spread    : ${opportunity.spreadPct}%`);
          console.log(`   Gross     : $${opportunity.grossProfitUSD}`);
          console.log(`   Net Profit: $${opportunity.netProfitUSD}`);
          console.log(
            `   Direction : ${opportunity.direction.buyOn} → ${opportunity.direction.sellOn}\n`,
          );
        } else {
          process.stdout.write(
            `\r📡 [${chainName}] ${pair.name} | UNI: $${uniPrice.price.toFixed(2)} | SUSHI: $${sushiPrice.price.toFixed(2)} | Spread: ${opportunity.spreadPct}%   `,
          );
        }
      }
    }
  }

  async start() {
    await this.init();
    this.running = true;
    console.log(
      `👀 Monitoring prices every ${CONFIG.pollIntervalMs / 1000}s...\n`,
    );

    const loop = async () => {
      if (!this.running) return;
      await this.poll();
      setTimeout(loop, CONFIG.pollIntervalMs);
    };

    loop();
  }

  stop() {
    this.running = false;
    console.log("\n🛑 Monitor stopped.");
  }
}

module.exports = { PriceMonitor, CONFIG };

if (require.main === module) {
  const monitor = new PriceMonitor();
  monitor.start();

  process.on("SIGINT", () => {
    monitor.stop();
    process.exit(0);
  });
}
