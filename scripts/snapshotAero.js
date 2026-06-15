/**
 * Live snapshot of WETH/USDC across Uniswap V3, Uniswap V2, and Aerodrome on Base.
 * Resolves the Aerodrome volatile pool from the factory, reads reserves/price for
 * each venue, and prints prices + liquidity so we can judge whether a V3<->Aerodrome
 * arb is even worth a contract rewrite.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { ethers } = require('ethers');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const provider = new ethers.JsonRpcProvider(RPC_URL);

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const V3_POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224'; // 0.05%
const V2_PAIR = '0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C';
const AERO_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

const Q192 = 2n ** 192n;
const E18 = 10n ** 18n;

const slot0Iface = new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)']);
const reservesIface = new ethers.Interface(['function getReserves() view returns (uint256 r0, uint256 r1, uint256 ts)']);
const factoryIface = new ethers.Interface(['function getPool(address,address,bool) view returns (address)']);
const erc20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);

// USDC per WETH (human), token0=WETH(18) token1=USDC(6)
function v3Price(sqrt) { return Number(sqrt * sqrt * E18 / Q192) / 1e6; }
function ammPrice(r0, r1) { return Number(r1 * E18 / r0) / 1e6; }

async function call(to, data) {
  return provider.call({ to, data });
}

async function main() {
  console.log(`RPC: ${RPC_URL.replace(/\/v2\/.*/, '/v2/***')}`);
  const block = await provider.getBlockNumber();
  console.log(`Block: ${block.toLocaleString()}\n`);

  // V3
  const s0 = slot0Iface.decodeFunctionResult('slot0', await call(V3_POOL, slot0Iface.encodeFunctionData('slot0')));
  const v3 = v3Price(s0.sqrtPriceX96);
  const v3Weth = ethers.formatEther(BigInt(await call(WETH, erc20.encodeFunctionData('balanceOf', [V3_POOL]))));

  // V2
  const v2r = reservesIface.decodeFunctionResult('getReserves', await call(V2_PAIR, reservesIface.encodeFunctionData('getReserves')));
  const v2 = ammPrice(v2r.r0, v2r.r1);

  // Aerodrome volatile pool
  let aeroPool = factoryIface.decodeFunctionResult('getPool', await call(AERO_FACTORY, factoryIface.encodeFunctionData('getPool', [WETH, USDC, false])))[0];
  let stable = false;
  if (aeroPool === ethers.ZeroAddress) {
    aeroPool = factoryIface.decodeFunctionResult('getPool', await call(AERO_FACTORY, factoryIface.encodeFunctionData('getPool', [WETH, USDC, true])))[0];
    stable = true;
  }

  let aero = null, aeroWeth = null;
  if (aeroPool && aeroPool !== ethers.ZeroAddress) {
    const ar = reservesIface.decodeFunctionResult('getReserves', await call(aeroPool, reservesIface.encodeFunctionData('getReserves')));
    aero = ammPrice(ar.r0, ar.r1);
    aeroWeth = ethers.formatEther(ar.r0);
  }

  console.log(`Uniswap V3 (0.05%)  price: $${v3.toFixed(2)}   WETH in pool: ${Number(v3Weth).toFixed(1)}`);
  console.log(`Uniswap V2          price: $${v2.toFixed(2)}   WETH reserve: ${ethers.formatEther(v2r.r0)}`);
  console.log(`Aerodrome ${stable ? 'stable ' : 'volatile'} pool ${aeroPool}`);
  if (aero !== null) {
    console.log(`Aerodrome           price: $${aero.toFixed(2)}   WETH reserve: ${Number(aeroWeth).toFixed(1)}`);
    const spread = Math.abs(v3 - aero) / Math.min(v3, aero) * 100;
    console.log(`\nV3 vs Aerodrome spread: ${spread.toFixed(4)}%  (Aerodrome fee ~0.30% + V3 0.05% = 0.35% floor)`);
  } else {
    console.log(`Aerodrome: no volatile/stable pool found via factory`);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
