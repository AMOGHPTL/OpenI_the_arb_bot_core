/**
 * Price Monitoring Bot with Morpho Integration
 * Watches Uniswap V3, Aerodrome, SushiSwap V3 across multiple pairs
 */

const { ethers } = require("ethers");
const EventEmitter = require("events");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const CONFIG = {
  chains: {
    base: {
      rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFFa",

      // Multiple DEXs on Base
      dexes: [
        {
          name: "uniswap_v3",
          router: "0x2626664c2603336E57B271c5C0b26F421741e481",
          quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
          type: "v3",
          defaultFee: 500,
        },
        {
          name: "aerodrome",
          router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
          factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
          type: "aerodrome",
          defaultFeePercent: 0.003,
        },
        {
          name: "sushiswap_v3",
          router: "0x2A9391c7eEF7A39b5e26C9c2a24669c53DAF5026",
          quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
          type: "v3",
          defaultFee: 500,
        },
      ],

      // Only use pairs that actually exist on Base
      pairs: [
        {
          name: "WETH/USDC",
          tokenIn: "0x4200000000000000000000000000000000000006", // WETH
          tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
          decimalsIn: 18,
          decimalsOut: 6,
          amountIn: ethers.parseEther("1"),
          uniswapFee: 500,
          enabled: true,
        },
        // WBTC/USDC commented out - doesn't have enough liquidity on Base DEXs
        // {
        //   name: "WBTC/USDC",
        //   tokenIn: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
        //   tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        //   decimalsIn: 8,
        //   decimalsOut: 6,
        //   amountIn: ethers.parseUnits("0.1", 8),
        //   uniswapFee: 500,
        //   enabled: false,
        // },
        // USDC/DAI commented out - DAI on Base has different address
        // {
        //   name: "USDC/DAI",
        //   tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        //   tokenOut: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        //   decimalsIn: 6,
        //   decimalsOut: 18,
        //   amountIn: ethers.parseUnits("5000", 6),
        //   uniswapFee: 100,
        //   enabled: false,
        // },
      ],
    },

    ethereum: {
      rpc: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
      chainId: 1,
      morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFFa",

      // Multiple DEXs on Ethereum
      dexes: [
        {
          name: "uniswap_v3",
          router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
          quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
          type: "v3",
          defaultFee: 500,
        },
        {
          name: "sushiswap_v3",
          router: "0x64e8802FE490fa7cc61d3463958199161Bb608A7",
          quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
          type: "v3",
          defaultFee: 3000,
        },
      ],

      // Only use pairs that actually exist on Ethereum
      pairs: [
        {
          name: "WETH/USDC",
          tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
          tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
          decimalsIn: 18,
          decimalsOut: 6,
          amountIn: ethers.parseEther("1"),
          uniswapFee: 500,
          enabled: true,
        },
        {
          name: "WBTC/USDC",
          tokenIn: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
          tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
          decimalsIn: 8,
          decimalsOut: 6,
          amountIn: ethers.parseUnits("0.01", 8),
          uniswapFee: 500,
          enabled: true,
        },
        {
          name: "WETH/DAI",
          tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
          tokenOut: "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
          decimalsIn: 18,
          decimalsOut: 18,
          amountIn: ethers.parseEther("1"),
          uniswapFee: 500,
          enabled: true,
        },
      ],
    },
  },

  // Global settings
  minNetProfitUSD: 1,
  minSpreadPercent: 0.1,
  pollIntervalMs: 3000,
  estimatedGasUnits: 400_000n,
  morphoFeePercent: 0.0005,
  slippageBuffer: 0.005,
  maxOpportunitiesStored: 500,
  maxStalePollCount: 500,
  stalenessPriceToleranceUSD: 2,
  gasEstimateFallbackUSD: 5,
};

// ─── ABIs ──────────────────────────────────────────────────────────────────────

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const AERODROME_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) external view returns (uint256[] memory amounts)",
];

// ─── PRICE MONITOR CLASS ───────────────────────────────────────────────────────

class PriceMonitor extends EventEmitter {
  constructor() {
    super();
    this.providers = {};
    this.contracts = {};
    this.running = false;
    this.opportunities = [];
    this._priceHistory = {};
  }

  async init() {
    console.log("🔌 Connecting to chains...");

    for (const [chainName, cfg] of Object.entries(CONFIG.chains)) {
      const provider = new ethers.JsonRpcProvider(cfg.rpc);
      this.providers[chainName] = provider;
      this.contracts[chainName] = {};

      // Initialize contracts for each DEX
      for (const dex of cfg.dexes) {
        try {
          if (dex.type === "aerodrome") {
            const contract = new ethers.Contract(
              dex.router,
              AERODROME_ROUTER_ABI,
              provider,
            );
            this.contracts[chainName][dex.name] = {
              contract,
              config: dex,
            };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          } else if (dex.type === "v3") {
            const contract = new ethers.Contract(
              dex.quoter,
              V3_QUOTER_ABI,
              provider,
            );
            this.contracts[chainName][dex.name] = {
              contract,
              config: dex,
            };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          }
        } catch (err) {
          console.error(
            `  ❌ ${chainName}: Failed to initialize ${dex.name}: ${err.message}`,
          );
        }
      }

      const block = await provider.getBlockNumber();
      console.log(`  📦 ${chainName}: block ${block}\n`);
    }

    console.log("✅ Monitor initialized\n");
  }

  async getDexQuote(chainName, pairName, dexName) {
    const chain = CONFIG.chains[chainName];
    const pair = chain.pairs.find((p) => p.name === pairName);

    if (!pair || !pair.enabled) return null;

    const dexContract = this.contracts[chainName]?.[dexName];
    if (!dexContract) return null;

    const { contract, config: dexConfig } = dexContract;

    try {
      let sellAmountOut, buyAmountOut;
      let fee;

      if (dexConfig.type === "v3") {
        fee = pair.uniswapFee || dexConfig.defaultFee;

        // Sell quote: tokenIn -> tokenOut
        const sellResult = await contract.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          amountIn: pair.amountIn,
          fee: fee,
          sqrtPriceLimitX96: 0n,
        });
        sellAmountOut = sellResult[0];

        // Buy quote: tokenOut -> tokenIn
        let buyAmount;
        if (pairName === "WBTC/USDC") {
          // For WBTC buy, use 1000 USDC
          buyAmount = ethers.parseUnits("1000", 6);
        } else {
          buyAmount = ethers.parseUnits("1000", pair.decimalsOut);
        }

        const buyResult = await contract.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenOut,
          tokenOut: pair.tokenIn,
          amountIn: buyAmount,
          fee: fee,
          sqrtPriceLimitX96: 0n,
        });
        buyAmountOut = buyResult[0];
      } else if (dexConfig.type === "aerodrome") {
        fee = dexConfig.defaultFeePercent * 1_000_000;

        const routes = [
          {
            from: pair.tokenIn,
            to: pair.tokenOut,
            stable: false,
            factory: dexConfig.factory,
          },
        ];
        const amounts = await contract.getAmountsOut(pair.amountIn, routes);
        sellAmountOut = amounts[amounts.length - 1];

        let buyAmount;
        if (pairName === "WBTC/USDC") {
          buyAmount = ethers.parseUnits("1000", 6);
        } else {
          buyAmount = ethers.parseUnits("1000", pair.decimalsOut);
        }

        const buyRoutes = [
          {
            from: pair.tokenOut,
            to: pair.tokenIn,
            stable: false,
            factory: dexConfig.factory,
          },
        ];
        const buyAmounts = await contract.getAmountsOut(buyAmount, buyRoutes);
        buyAmountOut = buyAmounts[amounts.length - 1];
      } else {
        return null;
      }

      // CRITICAL FIX: Calculate prices correctly for each pair type
      let sellPrice, buyPrice;

      if (pairName === "WBTC/USDC") {
        // For WBTC: amountIn is 0.01 WBTC, sellAmountOut is USDC amount
        const wbtcAmount = Number(ethers.formatUnits(pair.amountIn, 8)); // 0.01
        const usdcReceived = Number(ethers.formatUnits(sellAmountOut, 6));
        sellPrice = usdcReceived / wbtcAmount; // USDC per WBTC (should be ~63,000)

        // For buy: spent 1000 USDC, received buyAmountOut WBTC
        const wbtcReceived = Number(ethers.formatUnits(buyAmountOut, 8));
        buyPrice = wbtcReceived > 0 ? 1000 / wbtcReceived : Infinity;
      } else if (pairName === "USDC/DAI") {
        // Stable pair handling
        const usdcAmount = Number(ethers.formatUnits(pair.amountIn, 6));
        const daiReceived = Number(ethers.formatUnits(sellAmountOut, 18));
        sellPrice = daiReceived / usdcAmount;

        const spentAmount = 1000;
        const received = Number(ethers.formatUnits(buyAmountOut, 6));
        buyPrice = received > 0 ? spentAmount / received : Infinity;
      } else {
        // WETH pairs
        const ethAmount = Number(ethers.formatEther(pair.amountIn));
        const usdcReceived = Number(
          ethers.formatUnits(sellAmountOut, pair.decimalsOut),
        );
        sellPrice = usdcReceived / ethAmount;

        const spentAmount = 1000;
        const ethReceived = Number(ethers.formatUnits(buyAmountOut, 18));
        buyPrice = ethReceived > 0 ? spentAmount / ethReceived : Infinity;
      }

      // Price validation
      if (pairName === "WBTC/USDC") {
        if (sellPrice < 50000 || sellPrice > 80000) return null;
        if (buyPrice < 50000 || buyPrice > 80000) return null;
      } else if (pairName.includes("WETH")) {
        if (sellPrice < 1500 || sellPrice > 5000) return null;
        if (buyPrice < 1500 || buyPrice > 5000) return null;
      }

      if (sellPrice <= 0 || !isFinite(sellPrice)) return null;
      if (buyPrice <= 0 || !isFinite(buyPrice)) return null;

      return {
        dex: dexName,
        sellPrice,
        buyPrice,
        sellAmountOut,
        buyAmountOut,
        fee: fee,
      };
    } catch (err) {
      if (pairName === "WBTC/USDC") {
        console.log(
          `\x1b[31m❌ WBTC ${dexName} error: ${err.message.substring(0, 80)}\x1b[0m`,
        );
      }
      return null;
    }
  }

  async getAllQuotes(chainName, pairName) {
    const dexNames = Object.keys(this.contracts[chainName] || {});

    const quotes = await Promise.all(
      dexNames.map((dexName) => this.getDexQuote(chainName, pairName, dexName)),
    );

    return quotes.filter(
      (q) =>
        q !== null &&
        isFinite(q.sellPrice) &&
        isFinite(q.buyPrice) &&
        q.sellPrice > 0 &&
        q.buyPrice > 0,
    );
  }

  async analyseArbitrage(chainName, pairName, quoteA, quoteB) {
    const chain = CONFIG.chains[chainName];
    const pair = chain.pairs.find((p) => p.name === pairName);

    if (!pair) return null;

    // Try both directions
    const buyOnA = quoteA.buyPrice < quoteB.buyPrice;
    const buyPrice = buyOnA ? quoteA.buyPrice : quoteB.buyPrice;
    const sellPrice = buyOnA ? quoteB.sellPrice : quoteA.sellPrice;

    const tradeAmountETH = Number(ethers.formatEther(pair.amountIn));
    const grossProfitUSD = (sellPrice - buyPrice) * tradeAmountETH;

    if (grossProfitUSD <= 0) return null;

    const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
    const ethPriceUSD = (sellPrice + buyPrice) / 2;
    const netGrossProfitUSD = grossProfitUSD * (1 - CONFIG.slippageBuffer);

    // Calculate fees
    const buyFeeRate = (buyOnA ? quoteA.fee : quoteB.fee) / 1_000_000;
    const sellFeeRate = (buyOnA ? quoteB.fee : quoteA.fee) / 1_000_000;
    const tradeValueUSD = ethPriceUSD * tradeAmountETH;
    const totalSwapFeesUSD = tradeValueUSD * (buyFeeRate + sellFeeRate);

    const borrowedUSDC = buyPrice * tradeAmountETH;
    const flashLoanFeeUSD = borrowedUSDC * CONFIG.morphoFeePercent;
    const gasCostUSD = await this.estimateGasCostUSD(chainName, ethPriceUSD);

    const totalCostsUSD = flashLoanFeeUSD + totalSwapFeesUSD + gasCostUSD;
    const netProfitUSD = netGrossProfitUSD - totalCostsUSD;

    return {
      chain: chainName,
      pair: pairName,
      timestamp: Date.now(),
      buyDex: buyOnA ? quoteA.dex : quoteB.dex,
      sellDex: buyOnA ? quoteB.dex : quoteA.dex,
      buyPrice: buyPrice.toFixed(2),
      sellPrice: sellPrice.toFixed(2),
      spreadPct: spreadPct.toFixed(4),
      grossProfitUSD: netGrossProfitUSD.toFixed(2),
      flashLoanFeeUSD: flashLoanFeeUSD.toFixed(2),
      swapFeesUSD: totalSwapFeesUSD.toFixed(2),
      gasCostUSD: gasCostUSD.toFixed(2),
      totalCostsUSD: totalCostsUSD.toFixed(2),
      netProfitUSD: netProfitUSD.toFixed(2),
      isProfitable:
        netProfitUSD > CONFIG.minNetProfitUSD &&
        spreadPct >= CONFIG.minSpreadPercent,
    };
  }

  async estimateGasCostUSD(chainName, ethPriceUSD) {
    try {
      const provider = this.providers[chainName];
      const feeData = await provider.getFeeData();
      const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
      if (!gasPriceWei) throw new Error("no gas price returned");
      const gasCostWei = gasPriceWei * CONFIG.estimatedGasUnits;
      const gasCostETH = Number(ethers.formatEther(gasCostWei));
      return gasCostETH * ethPriceUSD;
    } catch (err) {
      return CONFIG.gasEstimateFallbackUSD;
    }
  }

  // async poll() {
  //   // Store all output for this poll cycle
  //   let outputLines = [];

  //   for (const [chainName, chain] of Object.entries(CONFIG.chains)) {
  //     for (const pair of chain.pairs) {
  //       if (!pair.enabled) continue;

  //       const quotes = await this.getAllQuotes(chainName, pair.name);

  //       if (quotes.length < 2) {
  //         outputLines.push(
  //           `\r\x1b[K\x1b[90m⏳ [${chainName}] ${pair.name}: Waiting for quotes...\x1b[0m`,
  //         );
  //         continue;
  //       }

  //       const validQuotes = quotes.filter(
  //         (q) => q && q.sellPrice > 0 && q.buyPrice > 0,
  //       );

  //       if (validQuotes.length >= 2) {
  //         const bestSell = Math.max(...validQuotes.map((q) => q.sellPrice));
  //         const bestBuy = Math.min(...validQuotes.map((q) => q.buyPrice));
  //         const spread = ((bestSell - bestBuy) / bestBuy) * 100;

  //         // Check for opportunities
  //         let opportunityFound = false;
  //         for (let i = 0; i < validQuotes.length; i++) {
  //           for (let j = i + 1; j < validQuotes.length; j++) {
  //             const opportunity = await this.analyseArbitrage(
  //               chainName,
  //               pair.name,
  //               validQuotes[i],
  //               validQuotes[j],
  //             );
  //             if (opportunity && opportunity.isProfitable) {
  //               opportunityFound = true;

  //               if (
  //                 this.opportunities.length >= CONFIG.maxOpportunitiesStored
  //               ) {
  //                 this.opportunities.splice(
  //                   0,
  //                   Math.floor(CONFIG.maxOpportunitiesStored / 2),
  //                 );
  //               }
  //               this.opportunities.push(opportunity);
  //               this.emit("opportunity", opportunity);

  //               // Add opportunity line
  //               outputLines.push(
  //                 `\r\x1b[K\x1b[31m🚨 [${chainName}] ${pair.name} | PROFIT: $${opportunity.netProfitUSD} | ${opportunity.buyDex} → ${opportunity.sellDex} | Spread: ${opportunity.spreadPct}%\x1b[0m`,
  //               );
  //               break;
  //             }
  //           }
  //           if (opportunityFound) break;
  //         }

  //         // Normal price display (no opportunity)
  //         if (!opportunityFound && spread > -5 && spread < 5) {
  //           let spreadColor = "\x1b[90m";
  //           let spreadSymbol = "📊";
  //           if (spread > 0.05) {
  //             spreadSymbol = "📈";
  //             spreadColor = "\x1b[32m";
  //           } else if (spread < -0.05) {
  //             spreadSymbol = "📉";
  //             spreadColor = "\x1b[31m";
  //           }

  //           outputLines.push(
  //             `\r\x1b[K${spreadSymbol} \x1b[36m[${chainName}]\x1b[0m \x1b[37m${pair.name.padEnd(12)}\x1b[0m | ` +
  //               `Sell: \x1b[32m$${bestSell.toFixed(2).padStart(8)}\x1b[0m | ` +
  //               `Buy: \x1b[31m$${bestBuy.toFixed(2).padStart(8)}\x1b[0m | ` +
  //               `Spread: ${spreadColor}${spread.toFixed(3).padStart(8)}%\x1b[0m`,
  //           );
  //         }
  //       }
  //     }
  //   }

  //   // Move cursor up to the beginning of the output block
  //   // Clear from current position to end of screen
  //   process.stdout.write("\x1b[0J");

  //   // Move cursor to top left
  //   process.stdout.write("\x1b[H");

  //   // Print header
  //   console.log(
  //     `\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
  //   );
  //   console.log(`\x1b[33m🤖 Flash Loan Arbitrage Monitor\x1b[0m`);
  //   console.log(
  //     `\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
  //   );
  //   console.log(
  //     `\x1b[90mTime: ${new Date().toLocaleTimeString()} | Polling every ${CONFIG.pollIntervalMs / 1000}s\x1b[0m\n`,
  //   );

  //   // Print all current quotes
  //   for (const line of outputLines) {
  //     console.log(line);
  //   }

  //   // Print footer with stats
  //   console.log(
  //     `\n\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
  //   );
  //   console.log(
  //     `\x1b[90m📊 Last update: ${new Date().toLocaleTimeString()} | Opportunities found: ${this.opportunities.length}\x1b[0m`,
  //   );
  // }
  async poll() {
    let outputLines = [];

    for (const [chainName, chain] of Object.entries(CONFIG.chains)) {
      for (const pair of chain.pairs) {
        if (!pair.enabled) continue;

        const quotes = await this.getAllQuotes(chainName, pair.name);

        if (quotes.length < 2) {
          outputLines.push(
            `\r\x1b[K\x1b[90m⏳ [${chainName}] ${pair.name}: Waiting for quotes...\x1b[0m`,
          );
          continue;
        }

        const validQuotes = quotes.filter(
          (q) => q && q.sellPrice > 0 && q.buyPrice > 0,
        );

        if (validQuotes.length >= 2) {
          // Find the BEST cross-DEX arbitrage opportunity
          let bestArbSpread = -Infinity;
          let bestArbBuyDex = null;
          let bestArbSellDex = null;
          let bestArbBuyPrice = 0;
          let bestArbSellPrice = 0;

          // Check all DEX pairs for arbitrage
          for (let i = 0; i < validQuotes.length; i++) {
            for (let j = 0; j < validQuotes.length; j++) {
              if (i === j) continue;

              // Try buying on DEX i, selling on DEX j
              const potentialProfit =
                validQuotes[j].sellPrice - validQuotes[i].buyPrice;
              const spread = (potentialProfit / validQuotes[i].buyPrice) * 100;

              if (spread > bestArbSpread) {
                bestArbSpread = spread;
                bestArbBuyDex = validQuotes[i].dex;
                bestArbSellDex = validQuotes[j].dex;
                bestArbBuyPrice = validQuotes[i].buyPrice;
                bestArbSellPrice = validQuotes[j].sellPrice;
              }
            }
          }

          // Also find best individual DEX prices (for reference)
          const bestSellPrice = Math.max(
            ...validQuotes.map((q) => q.sellPrice),
          );
          const bestSellDex = validQuotes.find(
            (q) => q.sellPrice === bestSellPrice,
          )?.dex;
          const bestBuyPrice = Math.min(...validQuotes.map((q) => q.buyPrice));
          const bestBuyDex = validQuotes.find(
            (q) => q.buyPrice === bestBuyPrice,
          )?.dex;

          // Determine if there's an arbitrage opportunity (positive spread)
          const isArbOpportunity = bestArbSpread > 0.05; // >0.05% spread

          if (isArbOpportunity) {
            // Show ARBITRAGE OPPORTUNITY prominently
            outputLines.push(
              `\r\x1b[K\x1b[31m🚨 [${chainName}] ${pair.name} | ARBITRAGE: Buy on ${bestArbBuyDex} @ $${bestArbBuyPrice.toFixed(2)} → Sell on ${bestArbSellDex} @ $${bestArbSellPrice.toFixed(2)} | Profit: ${bestArbSpread.toFixed(3)}%\x1b[0m`,
            );

            // Also check if this opportunity meets your threshold
            const tradeAmountETH = Number(ethers.formatEther(pair.amountIn));
            const grossProfitUSD =
              (bestArbSellPrice - bestArbBuyPrice) * tradeAmountETH;

            if (grossProfitUSD > CONFIG.minNetProfitUSD) {
              // Trigger execution engine
              this.emit("opportunity", {
                chain: chainName,
                pair: pair.name,
                buyDex: bestArbBuyDex,
                sellDex: bestArbSellDex,
                buyPrice: bestArbBuyPrice,
                sellPrice: bestArbSellPrice,
                spreadPct: bestArbSpread,
                grossProfitUSD: grossProfitUSD,
              });
            }
          } else {
            // Show normal market status (no arbitrage)
            let spreadColor = "\x1b[90m";
            let spreadSymbol = "📊";

            // Show the best individual prices across DEXs
            outputLines.push(
              `\r\x1b[K${spreadSymbol} \x1b[36m[${chainName}]\x1b[0m \x1b[37m${pair.name.padEnd(12)}\x1b[0m | ` +
                `Best Sell: \x1b[32m${bestSellDex?.padEnd(12)} $${bestSellPrice.toFixed(2)}\x1b[0m | ` +
                `Best Buy: \x1b[31m${bestBuyDex?.padEnd(12)} $${bestBuyPrice.toFixed(2)}\x1b[0m | ` +
                `Cross-DEX Spread: ${spreadColor}${bestArbSpread.toFixed(3)}%\x1b[0m`,
            );

            // Also show the best same-DEX spread for reference
            const bestSameDexSpread = Math.max(
              ...validQuotes.map(
                (q) => ((q.sellPrice - q.buyPrice) / q.buyPrice) * 100,
              ),
            );
            if (bestSameDexSpread > -0.5) {
              outputLines.push(
                `\r\x1b[K\x1b[90m   └─ Best same-DEX spread: ${bestSameDexSpread.toFixed(3)}% (not arbitrageable)\x1b[0m`,
              );
            }
          }
        }
      }
    }

    // Clear and display
    process.stdout.write("\x1b[0J");
    process.stdout.write("\x1b[H");

    console.log(
      `\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
    );
    console.log(`\x1b[33m🤖 Flash Loan Arbitrage Monitor\x1b[0m`);
    console.log(
      `\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
    );
    console.log(
      `\x1b[90mTime: ${new Date().toLocaleTimeString()} | Polling every ${CONFIG.pollIntervalMs / 1000}s\x1b[0m\n`,
    );

    for (const line of outputLines) {
      console.log(line);
    }

    console.log(
      `\n\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
    );
    console.log(
      `\x1b[90m📊 Last update: ${new Date().toLocaleTimeString()}\x1b[0m`,
    );
  }
  // async poll() {
  //   let outputLines = [];

  //   for (const [chainName, chain] of Object.entries(CONFIG.chains)) {
  //     for (const pair of chain.pairs) {
  //       if (!pair.enabled) continue;

  //       const quotes = await this.getAllQuotes(chainName, pair.name);

  //       if (quotes.length < 2) {
  //         outputLines.push(
  //           `\r\x1b[K\x1b[90m⏳ [${chainName}] ${pair.name}: Waiting for quotes...\x1b[0m`,
  //         );
  //         continue;
  //       }

  //       const validQuotes = quotes.filter(
  //         (q) => q && q.sellPrice > 0 && q.buyPrice > 0,
  //       );

  //       if (validQuotes.length >= 2) {
  //         // 🔍 DEBUG: Show all DEX quotes for Base WETH/USDC
  //         if (pair.name === "WETH/USDC" && chainName === "base") {
  //           console.log(
  //             `\n\x1b[33m📊 Detailed quotes for ${chainName} ${pair.name}:\x1b[0m`,
  //           );
  //           validQuotes.forEach((q) => {
  //             const sameDexSpread =
  //               ((q.sellPrice - q.buyPrice) / q.buyPrice) * 100;
  //             console.log(
  //               `   ${q.dex.padEnd(15)} | Sell: $${q.sellPrice.toFixed(2)} | Buy: $${q.buyPrice.toFixed(2)} | Spread: ${sameDexSpread.toFixed(3)}%`,
  //             );
  //           });
  //         }

  //         // Find the BEST cross-DEX arbitrage opportunity
  //         let bestArbSpread = -Infinity;
  //         let bestArbBuyDex = null;
  //         let bestArbSellDex = null;
  //         let bestArbBuyPrice = 0;
  //         let bestArbSellPrice = 0;

  //         // Check all DEX pairs for arbitrage
  //         for (let i = 0; i < validQuotes.length; i++) {
  //           for (let j = 0; j < validQuotes.length; j++) {
  //             if (i === j) continue;

  //             const potentialProfit =
  //               validQuotes[j].sellPrice - validQuotes[i].buyPrice;
  //             const spread = (potentialProfit / validQuotes[i].buyPrice) * 100;

  //             if (spread > bestArbSpread) {
  //               bestArbSpread = spread;
  //               bestArbBuyDex = validQuotes[i].dex;
  //               bestArbSellDex = validQuotes[j].dex;
  //               bestArbBuyPrice = validQuotes[i].buyPrice;
  //               bestArbSellPrice = validQuotes[j].sellPrice;
  //             }
  //           }
  //         }

  //         // Find best individual DEX prices
  //         const bestSellPrice = Math.max(
  //           ...validQuotes.map((q) => q.sellPrice),
  //         );
  //         const bestSellDex = validQuotes.find(
  //           (q) => q.sellPrice === bestSellPrice,
  //         )?.dex;
  //         const bestBuyPrice = Math.min(...validQuotes.map((q) => q.buyPrice));
  //         const bestBuyDex = validQuotes.find(
  //           (q) => q.buyPrice === bestBuyPrice,
  //         )?.dex;

  //         const isArbOpportunity = bestArbSpread > 0.05;

  //         if (isArbOpportunity) {
  //           outputLines.push(
  //             `\r\x1b[K\x1b[31m🚨 [${chainName}] ${pair.name} | ARBITRAGE: Buy on ${bestArbBuyDex} @ $${bestArbBuyPrice.toFixed(2)} → Sell on ${bestArbSellDex} @ $${bestArbSellPrice.toFixed(2)} | Profit: ${bestArbSpread.toFixed(3)}%\x1b[0m`,
  //           );
  //         } else {
  //           let spreadColor = "\x1b[90m";
  //           let spreadSymbol = "📊";

  //           outputLines.push(
  //             `\r\x1b[K${spreadSymbol} \x1b[36m[${chainName}]\x1b[0m \x1b[37m${pair.name.padEnd(12)}\x1b[0m | ` +
  //               `Best Sell: ${bestSellDex?.padEnd(12)} $${bestSellPrice.toFixed(2)} | ` +
  //               `Best Buy: ${bestBuyDex?.padEnd(12)} $${bestBuyPrice.toFixed(2)} | ` +
  //               `Cross-DEX Spread: ${spreadColor}${bestArbSpread.toFixed(3)}%\x1b[0m`,
  //           );
  //         }
  //       }
  //     }
  //   }

  //   // Clear and display
  //   process.stdout.write("\x1b[0J");
  //   process.stdout.write("\x1b[H");

  //   console.log(
  //     `\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
  //   );
  //   console.log(`\x1b[33m🤖 Flash Loan Arbitrage Monitor\x1b[0m`);
  //   console.log(
  //     `\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
  //   );
  //   console.log(
  //     `\x1b[90mTime: ${new Date().toLocaleTimeString()} | Polling every ${CONFIG.pollIntervalMs / 1000}s\x1b[0m\n`,
  //   );

  //   for (const line of outputLines) {
  //     console.log(line);
  //   }

  //   console.log(
  //     `\n\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`,
  //   );
  //   console.log(
  //     `\x1b[90m📊 Last update: ${new Date().toLocaleTimeString()}\x1b[0m`,
  //   );
  // }

  async start() {
    await this.init();
    this.running = true;

    const enabledPairs = Object.values(CONFIG.chains).reduce(
      (acc, chain) => acc + chain.pairs.filter((p) => p.enabled).length,
      0,
    );
    const totalDEXs = Object.values(CONFIG.chains).reduce(
      (acc, chain) => acc + chain.dexes.length,
      0,
    );

    console.log(
      `👀 Monitoring ${totalDEXs} DEXs across ${Object.keys(CONFIG.chains).length} chains with ${enabledPairs} pairs every ${CONFIG.pollIntervalMs / 1000}s...\n`,
    );

    this._pollInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.poll();
      } catch (err) {
        console.error("  ❌ Poll error:", err.message);
      }
    }, CONFIG.pollIntervalMs);

    // Run one poll immediately
    try {
      await this.poll();
    } catch (err) {
      console.error("  ❌ Initial poll error:", err.message);
    }
  }

  stop() {
    this.running = false;
    if (this._pollInterval) clearInterval(this._pollInterval);
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
