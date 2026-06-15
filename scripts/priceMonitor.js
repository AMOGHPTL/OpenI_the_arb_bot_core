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
      morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue — matches deployed contract
      weth: "0x4200000000000000000000000000000000000006",

      // These two venues mirror the deployed FlashLoanArbitrage contract exactly
      // (UNISWAP_ROUTER = V3 SwapRouter02, SUSHI_ROUTER = the Uni V2 router below,
      // see backend/deployments/base.json). The contract can ONLY arb V3 <-> V2, so
      // the monitor must quote precisely these venues — Aerodrome/Slipstream were
      // removed because the contract has no router for them.
      dexes: [
        {
          name: "uniswap_v3",
          router: "0x2626664c2603336E57B271c5C0b26F421741e481", // contract UNISWAP_ROUTER
          quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
          type: "v3",
          defaultFee: 500,
        },
        {
          name: "uniswap_v2",
          router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // contract SUSHI_ROUTER (Uni V2-compatible)
          type: "v2",
          defaultFee: 3000,
        },
      ],

      pairs: [
        {
          name: "WETH/USDC",
          tokenIn: "0x4200000000000000000000000000000000000006", // WETH
          tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
          decimalsIn: 18,
          decimalsOut: 6,
          amountIn: ethers.parseEther("1"),
          uniswapFee: 500,
          slipstreamTickSpacing: 100,
          enabled: true,
        },
        // WETH/USDT and WETH/DAI disabled: bridged USDT and DAI have near-zero liquidity
        // on Base — both DEXes consistently fail the 5% internal-spread sanity check.
        // {
        //   name: "WETH/USDT",
        //   tokenIn: "0x4200000000000000000000000000000000000006",
        //   tokenOut: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
        //   decimalsIn: 18, decimalsOut: 6,
        //   amountIn: ethers.parseEther("1"), uniswapFee: 500, enabled: false,
        // },
        // {
        //   name: "WETH/DAI",
        //   tokenIn: "0x4200000000000000000000000000000000000006",
        //   tokenOut: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        //   decimalsIn: 18, decimalsOut: 18,
        //   amountIn: ethers.parseEther("1"), uniswapFee: 500, enabled: false,
        // },
        {
          name: "USDC/USDT",
          tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // USDC
          tokenOut: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", // USDT
          decimalsIn: 6,
          decimalsOut: 6,
          amountIn: ethers.parseUnits("1000", 6),
          uniswapFee: 100,
          stablePool: true,
          slipstreamTickSpacing: 1,
          enabled: true,
        },
        // cbETH/USDC disabled: Aerodrome only has cbETH/WETH liquidity on Base.
        // {
        //   name: "cbETH/USDC",
        //   tokenIn: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", // cbETH
        //   tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
        //   decimalsIn: 18, decimalsOut: 6,
        //   amountIn: ethers.parseEther("1"), uniswapFee: 500, enabled: true,
        // },
      ],
    },

    ethereum: {
      rpc: process.env.ETH_RPC_URL || "https://eth.llamarpc.com",
      chainId: 1,
      morpho: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue (canonical, same address as Base)
      weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",

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
          router: "0x2E6cd2d30aa43f40aa81619ff4b6E0a41479B13F",
          quoter: "0x64e8802FE490fa7cc61d3463958199161Bb608A7",
          type: "v3",
          defaultFee: 500,
        },
        {
          name: "sushiswap_v2",
          router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
          type: "v2",
          defaultFee: 3000,
        },
        {
          // tricrypto2: USDT(0) / WBTC(1) / WETH(2)
          name: "curve_tricrypto",
          pool: "0xD51a44d3FaE010294C616388b506AcdA1bfAAE46",
          type: "curve_crypto",
          defaultFee: 3000,
          coinIndex: {
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": 2, // WETH
            "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": 1, // WBTC
            "0xdAC17F958D2ee523a2206206994597C13D831ec7": 0, // USDT
          },
        },
      ],

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
          name: "WETH/USDT",
          tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
          tokenOut: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
          decimalsIn: 18,
          decimalsOut: 6,
          amountIn: ethers.parseEther("1"),
          uniswapFee: 500,
          enabled: true,
        },
        {
          name: "WBTC/USDT",
          tokenIn: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
          tokenOut: "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
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
  pollIntervalMs: 3_000,
  quoteTimeoutMs: 5_000,   // per-DEX quote timeout; hung RPC won't stall the whole poll
  oppCooldownMs: 30_000,   // minimum ms between re-emitting the same direction opportunity
  estimatedGasUnits: 400_000n,
  morphoFeePercent: 0.0005,
  slippageBuffer: 0.005,
  maxOpportunitiesStored: 500,
  gasEstimateFallbackUSD: 5,
};

// ─── ABIs ──────────────────────────────────────────────────────────────────────

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const AERODROME_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) external view returns (uint256[] memory amounts)",
];

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
];

const CURVE_CRYPTO_ABI = [
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
];

const SLIPSTREAM_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// ─── PRICE MONITOR CLASS ───────────────────────────────────────────────────────

class PriceMonitor extends EventEmitter {
  constructor() {
    super();
    this.providers = {};
    this.contracts = {};
    this.running = false;
    this.opportunities = [];
    this._ethPriceUSD = {};       // per-chain ETH price derived from WETH pair quotes
    this._cachedGasPriceWei = {}; // per-chain gas price refreshed once per poll cycle
    this._lastEmitted = {};       // oppKey → timestamp, prevents flooding execution engine
    this._pollTimer = null;
  }

  async init() {
    console.log("🔌 Connecting to chains...");

    for (const [chainName, cfg] of Object.entries(CONFIG.chains)) {
      const provider = new ethers.JsonRpcProvider(cfg.rpc);
      this.providers[chainName] = provider;
      this.contracts[chainName] = {};

      for (const dex of cfg.dexes) {
        try {
          if (dex.type === "aerodrome") {
            const contract = new ethers.Contract(dex.router, AERODROME_ROUTER_ABI, provider);
            this.contracts[chainName][dex.name] = { contract, config: dex };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          } else if (dex.type === "v3") {
            const contract = new ethers.Contract(dex.quoter, V3_QUOTER_ABI, provider);
            this.contracts[chainName][dex.name] = { contract, config: dex };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          } else if (dex.type === "v2") {
            const contract = new ethers.Contract(dex.router, V2_ROUTER_ABI, provider);
            this.contracts[chainName][dex.name] = { contract, config: dex };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          } else if (dex.type === "curve_crypto") {
            const contract = new ethers.Contract(dex.pool, CURVE_CRYPTO_ABI, provider);
            this.contracts[chainName][dex.name] = { contract, config: dex };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          } else if (dex.type === "slipstream") {
            const contract = new ethers.Contract(dex.quoter, SLIPSTREAM_QUOTER_ABI, provider);
            this.contracts[chainName][dex.name] = { contract, config: dex };
            console.log(`  ✅ ${chainName}: ${dex.name} initialized`);
          }
        } catch (err) {
          console.error(`  ❌ ${chainName}: Failed to initialize ${dex.name}: ${err.message}`);
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
      let fee = dexConfig.defaultFee ?? 0;

      const buyAmount =
        pair.decimalsIn === 8
          ? ethers.parseUnits("1000", 6)
          : ethers.parseUnits("1000", pair.decimalsOut);

      if (dexConfig.type === "v3") {
        fee = pair.uniswapFee || dexConfig.defaultFee;

        const sellResult = await contract.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          amountIn: pair.amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        sellAmountOut = sellResult[0];

        const buyResult = await contract.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenOut,
          tokenOut: pair.tokenIn,
          amountIn: buyAmount,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        buyAmountOut = buyResult[0];
      } else if (dexConfig.type === "aerodrome") {
        fee = dexConfig.defaultFeePercent * 1_000_000;

        const isStable = pair.stablePool ?? false;
        const routes = [{ from: pair.tokenIn, to: pair.tokenOut, stable: isStable, factory: dexConfig.factory }];
        const amounts = await contract.getAmountsOut(pair.amountIn, routes);
        sellAmountOut = amounts[amounts.length - 1];

        const buyRoutes = [{ from: pair.tokenOut, to: pair.tokenIn, stable: isStable, factory: dexConfig.factory }];
        const buyAmounts = await contract.getAmountsOut(buyAmount, buyRoutes);
        buyAmountOut = buyAmounts[buyAmounts.length - 1];
      } else if (dexConfig.type === "v2") {
        const weth = CONFIG.chains[chainName].weth;
        // V2 has no direct WBTC/stablecoin pool — route through WETH when neither token is WETH
        const sellPath = (pair.tokenIn !== weth && pair.tokenOut !== weth)
          ? [pair.tokenIn, weth, pair.tokenOut]
          : [pair.tokenIn, pair.tokenOut];
        const buyPath = [...sellPath].reverse();
        const sellAmounts = await contract.getAmountsOut(pair.amountIn, sellPath);
        sellAmountOut = sellAmounts[sellAmounts.length - 1];
        const buyAmounts = await contract.getAmountsOut(buyAmount, buyPath);
        buyAmountOut = buyAmounts[buyAmounts.length - 1];
      } else if (dexConfig.type === "curve_crypto") {
        const indexIn = dexConfig.coinIndex?.[pair.tokenIn];
        const indexOut = dexConfig.coinIndex?.[pair.tokenOut];
        if (indexIn === undefined || indexOut === undefined) return null;
        sellAmountOut = await contract.get_dy(indexIn, indexOut, pair.amountIn);
        buyAmountOut = await contract.get_dy(indexOut, indexIn, buyAmount);
      } else if (dexConfig.type === "slipstream") {
        const tickSpacing = pair.slipstreamTickSpacing;
        if (tickSpacing === undefined) return null; // pair has no Slipstream pool
        const sellResult = await contract.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenIn,
          tokenOut: pair.tokenOut,
          amountIn: pair.amountIn,
          tickSpacing,
          sqrtPriceLimitX96: 0n,
        });
        sellAmountOut = sellResult[0];
        const buyResult = await contract.quoteExactInputSingle.staticCall({
          tokenIn: pair.tokenOut,
          tokenOut: pair.tokenIn,
          amountIn: buyAmount,
          tickSpacing,
          sqrtPriceLimitX96: 0n,
        });
        buyAmountOut = buyResult[0];
        fee = tickSpacing;
      } else {
        return null;
      }

      let sellPrice, buyPrice;

      if (pair.decimalsIn === 8) {
        const wbtcAmount = Number(ethers.formatUnits(pair.amountIn, 8));
        const usdReceived = Number(ethers.formatUnits(sellAmountOut, 6));
        sellPrice = usdReceived / wbtcAmount;
        const wbtcReceived = Number(ethers.formatUnits(buyAmountOut, 8));
        buyPrice = wbtcReceived > 0 ? 1000 / wbtcReceived : Infinity;
      } else if (pair.decimalsIn === 6) {
        // Stablecoin-base pairs (USDC/USDT, USDC/DAI, etc.)
        const amountIn = Number(ethers.formatUnits(pair.amountIn, pair.decimalsIn));
        const amountOut = Number(ethers.formatUnits(sellAmountOut, pair.decimalsOut));
        sellPrice = amountOut / amountIn;
        const received = Number(ethers.formatUnits(buyAmountOut, pair.decimalsIn));
        const buyAmountNum = Number(ethers.formatUnits(buyAmount, pair.decimalsOut));
        buyPrice = received > 0 ? buyAmountNum / received : Infinity;
      } else {
        // WETH pairs
        const ethAmount = Number(ethers.formatEther(pair.amountIn));
        const usdcReceived = Number(ethers.formatUnits(sellAmountOut, pair.decimalsOut));
        sellPrice = usdcReceived / ethAmount;
        const ethReceived = Number(ethers.formatUnits(buyAmountOut, 18));
        buyPrice = ethReceived > 0 ? 1000 / ethReceived : Infinity;
      }

      if (sellPrice <= 0 || !isFinite(sellPrice)) return null;
      if (buyPrice <= 0 || !isFinite(buyPrice)) return null;

      // If a single DEX's own sell/buy prices diverge by >5%, the pool is too
      // thin for our trade sizes — the quote is dominated by slippage, not price.
      const internalSpread = Math.abs(sellPrice - buyPrice) / Math.min(sellPrice, buyPrice);
      if (internalSpread > 0.05) return null;

      return { dex: dexName, sellPrice, buyPrice, sellAmountOut, buyAmountOut, fee };
    } catch (err) {
      return null;
    }
  }

  // Wraps each DEX call with an individual timeout so a hanging RPC can't stall the poll.
  // The timer is cancelled as soon as the quote resolves, avoiding lingering handles.
  async getAllQuotes(chainName, pairName) {
    const dexNames = Object.keys(this.contracts[chainName] || {});

    const quotes = await Promise.all(
      dexNames.map(
        (dexName) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), CONFIG.quoteTimeoutMs);
            this.getDexQuote(chainName, pairName, dexName)
              .then((result) => { clearTimeout(timer); resolve(result); })
              .catch(() => { clearTimeout(timer); resolve(null); });
          }),
      ),
    );

    return quotes.filter(
      (q) => q !== null && isFinite(q.sellPrice) && isFinite(q.buyPrice) && q.sellPrice > 0 && q.buyPrice > 0,
    );
  }

  // Synchronous: uses gas price pre-fetched at the start of each poll cycle.
  estimateGasCostUSD(chainName, ethPriceUSD) {
    const gasPriceWei = this._cachedGasPriceWei[chainName];
    if (!gasPriceWei) return CONFIG.gasEstimateFallbackUSD;
    const gasCostWei = gasPriceWei * CONFIG.estimatedGasUnits;
    return Number(ethers.formatEther(gasCostWei)) * ethPriceUSD;
  }

  // Synchronous: all inputs (gas price, ETH price) are pre-fetched before this is called.
  analyseArbitrage(chainName, pairName, quoteA, quoteB, ethPriceUSD = null) {
    const chain = CONFIG.chains[chainName];
    const pair = chain.pairs.find((p) => p.name === pairName);
    if (!pair) return null;

    const buyOnA = quoteA.buyPrice < quoteB.buyPrice;
    const buyPrice = buyOnA ? quoteA.buyPrice : quoteB.buyPrice;
    const sellPrice = buyOnA ? quoteB.sellPrice : quoteA.sellPrice;

    const tradeAmount = Number(ethers.formatUnits(pair.amountIn, pair.decimalsIn));
    const grossProfitUSD = (sellPrice - buyPrice) * tradeAmount;
    if (grossProfitUSD <= 0) return null;

    const spreadPct = ((sellPrice - buyPrice) / buyPrice) * 100;
    const midPrice = (sellPrice + buyPrice) / 2;
    // For WETH pairs midPrice IS the ETH price. For non-WETH (e.g. WBTC), the caller
    // passes the cached ETH price so gas cost isn't computed using the asset price.
    const gasEthPrice = ethPriceUSD ?? midPrice;
    const netGrossProfitUSD = grossProfitUSD * (1 - CONFIG.slippageBuffer);

    const buyFeeRate = (buyOnA ? quoteA.fee : quoteB.fee) / 1_000_000;
    const sellFeeRate = (buyOnA ? quoteB.fee : quoteA.fee) / 1_000_000;
    const totalSwapFeesUSD = midPrice * tradeAmount * (buyFeeRate + sellFeeRate);

    const flashLoanFeeUSD = buyPrice * tradeAmount * CONFIG.morphoFeePercent;
    const gasCostUSD = this.estimateGasCostUSD(chainName, gasEthPrice);
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
      isProfitable: netProfitUSD > CONFIG.minNetProfitUSD && spreadPct >= CONFIG.minSpreadPercent,
    };
  }

  // ── Execution-data builder (what the deployed contract actually needs) ───────
  //
  // The contract is a fixed Uniswap V3 <-> Uniswap V2 machine. A price-level spread
  // isn't enough to act on — we must know the exact loan size, per-leg outputs, and
  // direction. This simulates BOTH directions of the round trip
  // (borrow tokenIn -> tokenOut -> tokenIn) at the real loan amount, using the V3
  // quoter and the V2 router's getAmountsOut, then picks the direction that returns
  // the most borrowed token. Returns null if neither direction is on-chain profitable
  // or the chain lacks both a V3 and a V2 venue.
  //
  //   direction 0 = leg1 on V3 (tokenIn->tokenOut), leg2 on V2 (tokenOut->tokenIn)
  //   direction 1 = leg1 on V2 (tokenIn->tokenOut), leg2 on V3 (tokenOut->tokenIn)
  async buildExecutionData(chainName, pair) {
    const dexes = this.contracts[chainName] || {};
    let v3, v2;
    for (const name of Object.keys(dexes)) {
      const t = dexes[name].config.type;
      if (t === "v3" && (!v3 || name.startsWith("uniswap"))) v3 = dexes[name];
      else if (t === "v2" && !v2) v2 = dexes[name];
    }
    if (!v3 || !v2) return null;

    const loan = pair.amountIn;
    const fee = pair.uniswapFee || v3.config.defaultFee;
    const { tokenIn, tokenOut } = pair; // tokenIn = borrowed, tokenOut = intermediate

    const quoteV3 = async (tIn, tOut, amt) => {
      const r = await v3.contract.quoteExactInputSingle.staticCall({
        tokenIn: tIn, tokenOut: tOut, amountIn: amt, fee, sqrtPriceLimitX96: 0n,
      });
      return r[0];
    };
    const quoteV2 = async (tIn, tOut, amt) => {
      const a = await v2.contract.getAmountsOut(amt, [tIn, tOut]);
      return a[a.length - 1];
    };

    // Leg 1 of each direction (both start by selling the borrowed token)
    const [d0Leg1, d1Leg1] = await Promise.all([
      quoteV3(tokenIn, tokenOut, loan).catch(() => null),
      quoteV2(tokenIn, tokenOut, loan).catch(() => null),
    ]);

    // Leg 2 of each direction (round-trips back to the borrowed token)
    const [d0Final, d1Final] = await Promise.all([
      d0Leg1 ? quoteV2(tokenOut, tokenIn, d0Leg1).catch(() => null) : null,
      d1Leg1 ? quoteV3(tokenOut, tokenIn, d1Leg1).catch(() => null) : null,
    ]);

    const candidates = [];
    if (d0Leg1 && d0Final) candidates.push({ direction: 0, leg1: d0Leg1, final: d0Final, sellOn: "uniswap_v3", buyOn: "uniswap_v2" });
    if (d1Leg1 && d1Final) candidates.push({ direction: 1, leg1: d1Leg1, final: d1Final, sellOn: "uniswap_v2", buyOn: "uniswap_v3" });
    if (candidates.length === 0) return null;

    // Pick the direction that returns the most of the borrowed token
    const best = candidates.reduce((a, b) => (b.final > a.final ? b : a));
    if (best.final <= loan) return null; // no on-chain profit at the real loan size

    const borrowedPriceUSD = pair.decimalsIn === 6 ? 1 : (this._ethPriceUSD[chainName] ?? null);

    return {
      direction: { direction: best.direction, buyOn: best.buyOn, sellOn: best.sellOn },
      borrowedPriceUSD,
      raw: {
        tokenIn,
        tokenOut,
        uniswapFee: fee,
        decimalsIn: pair.decimalsIn,
        decimalsOut: pair.decimalsOut,
        loanAmount: loan.toString(),
        expectedOutFirst: best.leg1.toString(),   // leg-1 output (intermediate-token units)
        expectedOutSecond: best.final.toString(),  // round-trip output (borrowed-token units)
      },
    };
  }

  async poll() {
    // ── Phase 1: refresh gas prices and fetch all quotes in parallel ─────────────
    //
    // Gas prices and quotes are independent — run concurrently.
    // Quotes are also fully parallel across all chains and pairs.
    const [, allPairData] = await Promise.all([
      Promise.all(
        Object.keys(CONFIG.chains).map(async (chainName) => {
          try {
            const feeData = await this.providers[chainName].getFeeData();
            this._cachedGasPriceWei[chainName] = feeData.gasPrice ?? feeData.maxFeePerGas ?? null;
          } catch {
            // keep last cached value; estimateGasCostUSD falls back to gasEstimateFallbackUSD
          }
        }),
      ),
      Promise.all(
        Object.entries(CONFIG.chains).flatMap(([chainName, chain]) =>
          chain.pairs
            .filter((p) => p.enabled)
            .map(async (pair) => ({
              chainName,
              pair,
              quotes: await this.getAllQuotes(chainName, pair.name),
            })),
        ),
      ),
    ]);

    // ── Phase 2: warm per-chain ETH price cache from WETH pair results ───────────
    //
    // Must complete before Phase 3 so WBTC analysis uses ETH price, not WBTC price,
    // for gas cost estimation. Doing this as a separate pass avoids the race condition
    // that would appear if we updated the cache while other pairs were running.
    for (const { chainName, pair, quotes } of allPairData) {
      if (pair.name.includes("WETH") && quotes.length >= 1) {
        const midPrices = quotes.map((q) => (q.sellPrice + q.buyPrice) / 2);
        this._ethPriceUSD[chainName] = midPrices.reduce((a, b) => a + b, 0) / midPrices.length;
      }
    }

    // ── Phase 3: analyse each pair and build output lines ────────────────────────
    const outputLines = [];

    for (const { chainName, pair, quotes } of allPairData) {
      if (quotes.length < 2) {
        const total = Object.keys(this.contracts[chainName] || {}).length;
        const msg =
          quotes.length === 0
            ? `\x1b[31m❌ [${chainName}] ${pair.name}: All ${total} DEX quotes failed\x1b[0m`
            : `\x1b[90m⚠️  [${chainName}] ${pair.name}: ${quotes.length}/${total} DEX quoted — need ≥2\x1b[0m`;
        outputLines.push(`\r\x1b[K${msg}`);
        continue;
      }

      const ethPrice = this._ethPriceUSD[chainName] ?? null;

      // analyseArbitrage is now synchronous — no await needed inside this loop
      let bestOpportunity = null;
      for (let i = 0; i < quotes.length; i++) {
        for (let j = i + 1; j < quotes.length; j++) {
          const opp = this.analyseArbitrage(chainName, pair.name, quotes[i], quotes[j], ethPrice);
          if (!opp) continue;
          if (!bestOpportunity || parseFloat(opp.netProfitUSD) > parseFloat(bestOpportunity.netProfitUSD)) {
            bestOpportunity = opp;
          }
        }
      }

      // Always compute raw best prices for display (used in both the no-opp and non-profitable branches)
      const bestSell = Math.max(...quotes.map((q) => q.sellPrice));
      const bestSellDex = quotes.find((q) => q.sellPrice === bestSell)?.dex;
      const bestBuy = Math.min(...quotes.map((q) => q.buyPrice));
      const bestBuyDex = quotes.find((q) => q.buyPrice === bestBuy)?.dex;

      if (!bestOpportunity) {
        // No positive gross spread in any direction — show raw prices
        const crossSpread = ((bestSell - bestBuy) / bestBuy) * 100;
        outputLines.push(
          `\r\x1b[K📊 \x1b[36m[${chainName}]\x1b[0m \x1b[37m${pair.name.padEnd(12)}\x1b[0m | ` +
            `Best Sell: \x1b[32m${bestSellDex?.padEnd(12)} $${bestSell.toFixed(2)}\x1b[0m | ` +
            `Best Buy: \x1b[31m${bestBuyDex?.padEnd(12)} $${bestBuy.toFixed(2)}\x1b[0m | ` +
            `Spread: \x1b[90m${crossSpread.toFixed(3)}%\x1b[0m`,
        );
        continue;
      }

      if (bestOpportunity.isProfitable) {
        // Cooldown: re-emit the same direction at most once per oppCooldownMs.
        // Prevents flooding the execution engine when an opportunity persists across polls.
        const oppKey = `${bestOpportunity.chain}:${bestOpportunity.pair}:${bestOpportunity.buyDex}:${bestOpportunity.sellDex}`;
        if (Date.now() - (this._lastEmitted[oppKey] ?? 0) > CONFIG.oppCooldownMs) {
          // Build the exact V3<->V2 round-trip args the deployed contract needs.
          // If neither direction is profitable at the real loan size, the price-level
          // spread was an illusion (slippage/stale quotes) — don't emit something the
          // contract would only revert on.
          const execData = await this.buildExecutionData(chainName, pair);
          if (execData) {
            this._lastEmitted[oppKey] = Date.now();
            const executable = { ...bestOpportunity, ...execData };
            if (this.opportunities.length >= CONFIG.maxOpportunitiesStored) {
              this.opportunities.splice(0, Math.floor(CONFIG.maxOpportunitiesStored / 2));
            }
            this.opportunities.push(executable);
            this.emit("opportunity", executable);
          }
        }

        outputLines.push(
          `\r\x1b[K\x1b[31m🚨 [${chainName}] ${pair.name} | NET: $${bestOpportunity.netProfitUSD} | ` +
            `${bestOpportunity.buyDex} @ $${bestOpportunity.buyPrice} → ${bestOpportunity.sellDex} @ $${bestOpportunity.sellPrice} | ` +
            `Spread: ${bestOpportunity.spreadPct}% | Gas: $${bestOpportunity.gasCostUSD}\x1b[0m`,
        );
      } else {
        outputLines.push(
          `\r\x1b[K📊 \x1b[36m[${chainName}]\x1b[0m \x1b[37m${pair.name.padEnd(12)}\x1b[0m | ` +
            `Best Sell: \x1b[32m${bestSellDex?.padEnd(12)} $${bestSell.toFixed(2)}\x1b[0m | ` +
            `Best Buy: \x1b[31m${bestBuyDex?.padEnd(12)} $${bestBuy.toFixed(2)}\x1b[0m | ` +
            `Spread: \x1b[90m${bestOpportunity.spreadPct}%\x1b[0m`,
        );
      }
    }

    // ── Render ───────────────────────────────────────────────────────────────────
    // Screen-clear escape codes only work in an interactive terminal. In PM2, Docker,
    // or piped output they produce garbage — skip them and let each poll print a block.
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[0J");
      process.stdout.write("\x1b[H");
    }

    console.log(`\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
    console.log(`\x1b[33m🤖 Flash Loan Arbitrage Monitor\x1b[0m`);
    console.log(`\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
    console.log(`\x1b[90mTime: ${new Date().toLocaleTimeString()} | Polling every ${CONFIG.pollIntervalMs / 1000}s\x1b[0m\n`);

    for (const line of outputLines) {
      console.log(line);
    }

    console.log(`\n\x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
    console.log(`\x1b[90m📊 Last update: ${new Date().toLocaleTimeString()} | Opportunities: ${this.opportunities.length}\x1b[0m`);
  }

  // setTimeout-based scheduling: the next poll is only queued AFTER the current one
  // finishes, preventing polls from stacking up if one takes longer than pollIntervalMs.
  // Adaptive delay: if a poll takes 2s on a 3s interval, the next fires in 1s, not 3s.
  async _runPoll() {
    if (!this.running) return;
    const start = Date.now();
    try {
      await this.poll();
    } catch (err) {
      console.error("❌ Poll error:", err.message);
    }
    if (this.running) {
      const elapsed = Date.now() - start;
      this._pollTimer = setTimeout(() => this._runPoll(), Math.max(0, CONFIG.pollIntervalMs - elapsed));
    }
  }

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

    this._runPoll();
  }

  stop() {
    this.running = false;
    if (this._pollTimer) clearTimeout(this._pollTimer);
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
``