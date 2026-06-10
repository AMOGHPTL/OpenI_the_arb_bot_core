/**
 * Scans historical Base blocks for profitable USDC/WETH arb between
 * Uniswap V3 (SwapRouter02) and Uniswap V2.
 *
 * Usage:
 *   node scripts/scanArb.js
 *
 * Requires an ARCHIVE-capable RPC (free public RPCs only keep ~128 blocks).
 * Set BASE_RPC_URL in your .env or export it before running:
 *   export BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
 *
 * Alchemy free tier on Base supports full archive queries.
 * Sign up at https://dashboard.alchemy.com/ (free, no credit card).
 *
 * When an opportunity is found the script prints the exact forge command.
 */

// Look for .env in the scripts/ dir first, then one level up (backend/)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Uniswap V3 WETH/USDC 500 bp pool on Base (token0=WETH, token1=USDC)
const V3_POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224';
// Uniswap V2 WETH/USDC pair on Base (token0=WETH, token1=USDC)
const V2_PAIR = '0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C';

// ---- combined V2 (0.30%) + V3 (0.05%) fee threshold ----
const MIN_RATIO = 1.0035;

// ---- scan settings (edit these) ----
const BLOCKS_BACK  = parseInt(process.env.BLOCKS_BACK  || '500000'); // ~11 days on Base (2 s blocks)
const STEP         = parseInt(process.env.STEP         || '500');    // sample every N blocks
const BATCH        = parseInt(process.env.BATCH        || '20');     // parallel calls per round
const DELAY_MS     = parseInt(process.env.DELAY_MS     || '200');    // ms between batches (rate-limit)

// -------------------------------------------------------------------
// Raw JSON-RPC — no npm install needed beyond ethers already present
// -------------------------------------------------------------------
let _id = 1;
async function rpc(method, params) {
    const res = await fetch(RPC_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`RPC error ${j.error.code}: ${j.error.message}`);
    return j.result;
}

function toHex(n) { return '0x' + n.toString(16); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -------------------------------------------------------------------
// Price calculation (pure BigInt — no floating-point precision loss)
// Returns USDC per WETH scaled by 1e6  (i.e. "$1640.23" → 1640230000n)
// -------------------------------------------------------------------
const Q192 = 2n ** 192n;
const E12  = 10n ** 12n;
const E6   = 10n ** 6n;

function v3Price(sqrtPriceX96Hex) {
    const sq = BigInt(sqrtPriceX96Hex);
    // price_raw = sq^2 / 2^192,  price_USDC_per_WETH = price_raw * 1e12
    // We keep extra 1e6 for sub-dollar precision:  result = sq^2 * 1e18 / 2^192
    return sq * sq * E12 * E6 / Q192;
}

function v2Price(reserve0Hex, reserve1Hex) {
    const r0 = BigInt(reserve0Hex); // WETH (18 dp)
    const r1 = BigInt(reserve1Hex); // USDC (6 dp)
    // USDC_per_WETH = r1 * 1e12 / r0,  keep extra 1e6:  result = r1 * 1e18 / r0
    return r1 * E12 * E6 / r0;
}

function toFloat(scaled) { return Number(scaled) / 1e6; }

// -------------------------------------------------------------------
// Fetch both prices at a given block in one batch-friendly way
// -------------------------------------------------------------------
async function pricesAt(block) {
    const tag = toHex(block);

    const [slot0Data, reservesData] = await Promise.all([
        rpc('eth_call', [{ to: V3_POOL, data: '0x3850c7bd' }, tag]),
        rpc('eth_call', [{ to: V2_PAIR, data: '0x0902f1ac' }, tag]),
    ]);

    if (!slot0Data || slot0Data === '0x' || !reservesData || reservesData === '0x') return null;

    // slot0: first 32 bytes = sqrtPriceX96 (uint160, right-padded to 32 bytes in ABI)
    const sqrtPX96 = '0x' + slot0Data.slice(2, 66);

    // getReserves: (uint112 r0, uint112 r1, uint32 ts), each 32-byte slot
    const r0 = '0x' + reservesData.slice(2,  66);
    const r1 = '0x' + reservesData.slice(66, 130);

    const p3 = v3Price(sqrtPX96);
    const p2 = v2Price(r0, r1);

    if (p3 === 0n || p2 === 0n) return null;

    return { p3, p2 };
}

// -------------------------------------------------------------------
// Main scanner
// -------------------------------------------------------------------
async function main() {
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Pools: V3=${V3_POOL}  V2=${V2_PAIR}`);
    console.log(`Scanning ${BLOCKS_BACK.toLocaleString()} blocks back, step=${STEP}\n`);

    // Test the RPC first
    let latest;
    try {
        latest = parseInt(await rpc('eth_blockNumber', []), 16);
    } catch (e) {
        console.error('Could not reach RPC:', e.message);
        process.exit(1);
    }
    console.log(`Latest block: ${latest.toLocaleString()}`);

    // Check archive depth: if the oldest block we want to query isn't supported
    // the RPC will return an empty result and we'll skip gracefully.
    const fromBlock = Math.max(1, latest - BLOCKS_BACK);
    const totalSamples = Math.ceil(BLOCKS_BACK / STEP);
    console.log(`Sampling every ${STEP} blocks → ${totalSamples.toLocaleString()} samples (${BATCH} per batch)\n`);

    const opportunities = [];
    let checked = 0;

    for (let b = latest; b >= fromBlock; b -= BATCH * STEP) {
        const batch = [];
        for (let i = 0; i < BATCH; i++) {
            const blk = b - i * STEP;
            if (blk < fromBlock) break;
            batch.push(blk);
        }

        const results = await Promise.allSettled(batch.map(blk => pricesAt(blk).then(p => ({ blk, p }))));

        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value.p) continue;
            const { blk, p } = r.value;
            const { p3, p2 } = p;

            // ratio as a float (we only need ~4 sig figs for the comparison)
            const f3 = toFloat(p3);
            const f2 = toFloat(p2);
            const ratio = f3 > f2 ? f3 / f2 : f2 / f3;

            if (ratio > MIN_RATIO) {
                const direction = f3 > f2 ? 1 : 0;
                const spread = ((ratio - 1) * 100).toFixed(4);
                opportunities.push({ blk, f3, f2, ratio, direction, spread });
                console.log(
                    `  FOUND block=${blk}  V3=${f3.toFixed(2)}  V2=${f2.toFixed(2)}  ` +
                    `spread=${spread}%  dir=${direction}`
                );
            }
        }

        checked += batch.length;
        if (checked % (BATCH * 10) === 0) {
            const pct = (((latest - b) / BLOCKS_BACK) * 100).toFixed(0);
            process.stdout.write(`\rProgress: ${pct}% (${checked.toLocaleString()} samples)   `);
        }

        await sleep(DELAY_MS);
    }

    console.log('\n');

    if (opportunities.length === 0) {
        console.log('No arb opportunities found in this range.');
        console.log('Tips:');
        console.log('  • Use an archive RPC (Alchemy free tier works)');
        console.log('  • Increase BLOCKS_BACK: BLOCKS_BACK=2000000 node scripts/scanArb.js');
        console.log('  • Decrease STEP to catch short-lived spreads: STEP=100');
        return;
    }

    // Sort by spread (best first)
    opportunities.sort((a, b) => b.ratio - a.ratio);

    console.log('='.repeat(70));
    console.log(`Top ${Math.min(10, opportunities.length)} opportunities:\n`);

    for (const { blk, f3, f2, spread, direction } of opportunities.slice(0, 10)) {
        const dir = direction === 0 ? 'V3→V2 (buy WETH on V3, sell on V2)' : 'V2→V3 (buy WETH on V2, sell on V3)';
        console.log(`Block ${blk.toLocaleString()} — spread ${spread}% — ${dir}`);
        console.log(`  V3 price: ${f3.toFixed(4)} USDC/WETH`);
        console.log(`  V2 price: ${f2.toFixed(4)} USDC/WETH`);
        console.log(`  forge test --match-contract RealDex --fork-url $BASE_RPC_URL --fork-block-number ${blk} -vvv`);
        console.log();
    }
}

main().catch(e => { console.error('\nFatal:', e.message); process.exit(1); });
