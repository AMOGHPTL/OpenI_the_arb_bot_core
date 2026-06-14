/**
 * Dense (contiguous, every-block) scan of the USDC/WETH spread between
 * Uniswap V3 (500bp pool) and Uniswap V2 on Base.
 *
 * Unlike scanArb.js (which samples 1 block in 500 and therefore misses
 * short-lived spreads ~99.6% of the time), this checks EVERY block in the
 * window and records the full spread distribution — so "no opportunities"
 * becomes a quantified statement, not an absence of data.
 *
 * Usage:
 *   node scripts/scanDense.js                 # last 7200 blocks (~4h)
 *   BLOCKS=21600 node scripts/scanDense.js    # last 12h
 *   END_BLOCK=12345678 node scripts/scanDense.js  # window ending at block
 *
 * Output: stats to stdout + per-block CSV at scripts/scan-dense.csv
 *
 * Uses Multicall3 so each block costs ONE eth_call (26 CU on Alchemy)
 * instead of two — ~12 blocks/sec fits the free-tier rate limit.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const V3_POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224'; // WETH/USDC 0.05%
const V2_PAIR = '0x88A43bbDF9D098eEC7bCEda4e2494615dfD9bB9C'; // WETH/USDC V2
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const BLOCKS   = parseInt(process.env.BLOCKS   || '7200');  // window size
const BATCH    = parseInt(process.env.BATCH    || '12');    // blocks per round
const DELAY_MS = parseInt(process.env.DELAY_MS || '1000');  // ms between rounds
const END_BLOCK = process.env.END_BLOCK ? parseInt(process.env.END_BLOCK) : null;

// combined fee floor: V2 0.30% + V3 0.05%
const FEE_FLOOR_PCT = 0.35;

const CSV_PATH = path.join(__dirname, 'scan-dense.csv');

const mc3 = new Interface([
    'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
]);

let _id = 1;
async function rpc(method, params, attempt = 0) {
    try {
        const res = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params }),
        });
        if (res.status === 429) throw new Error('429 rate limited');
        const j = await res.json();
        if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
        return j.result;
    } catch (e) {
        if (attempt >= 5) throw e;
        await sleep(500 * 2 ** attempt); // 0.5s, 1s, 2s, 4s, 8s
        return rpc(method, params, attempt + 1);
    }
}

function toHex(n) { return '0x' + n.toString(16); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const Q192 = 2n ** 192n;
const E18 = 10n ** 18n;

// both return USDC-per-WETH scaled by 1e6
function v3Price(sqrtPriceX96) {
    return sqrtPriceX96 * sqrtPriceX96 * E18 / Q192;
}
function v2Price(r0, r1) {
    return r1 * E18 / r0;
}

async function spreadAt(block) {
    const callData = mc3.encodeFunctionData('aggregate3', [[
        { target: V3_POOL, allowFailure: false, callData: '0x3850c7bd' }, // slot0()
        { target: V2_PAIR, allowFailure: false, callData: '0x0902f1ac' }, // getReserves()
    ]]);
    const raw = await rpc('eth_call', [{ to: MULTICALL3, data: callData }, toHex(block)]);
    const [results] = mc3.decodeFunctionResult('aggregate3', raw);

    const sqrtPX96 = BigInt('0x' + results[0].returnData.slice(2, 66));
    const r0 = BigInt('0x' + results[1].returnData.slice(2, 66));
    const r1 = BigInt('0x' + results[1].returnData.slice(66, 130));
    if (sqrtPX96 === 0n || r0 === 0n) return null;

    const f3 = Number(v3Price(sqrtPX96)) / 1e6;
    const f2 = Number(v2Price(r0, r1)) / 1e6;
    const ratio = f3 > f2 ? f3 / f2 : f2 / f3;
    return { f3, f2, spreadPct: (ratio - 1) * 100, dir: f3 > f2 ? 'V2->V3' : 'V3->V2' };
}

async function main() {
    console.log(`RPC: ${RPC_URL.replace(/\/v2\/.*/, '/v2/***')}`);

    const latest = parseInt(await rpc('eth_blockNumber', []), 16);
    const end = END_BLOCK || latest;
    const start = end - BLOCKS + 1;
    console.log(`Latest block: ${latest.toLocaleString()}`);
    console.log(`Scanning EVERY block ${start.toLocaleString()} .. ${end.toLocaleString()} (${BLOCKS.toLocaleString()} blocks, ~${(BLOCKS * 2 / 3600).toFixed(1)}h of chain time)\n`);

    fs.writeFileSync(CSV_PATH, 'block,v3_usdc_per_weth,v2_usdc_per_weth,spread_pct,direction\n');

    // distribution buckets in spread % terms
    const bucketEdges = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.50, 1.00];
    const buckets = new Array(bucketEdges.length + 1).fill(0);
    const bucketLabel = i =>
        i === 0 ? `< ${bucketEdges[0]}%`
        : i === bucketEdges.length ? `>= ${bucketEdges[bucketEdges.length - 1]}%`
        : `${bucketEdges[i - 1]}% - ${bucketEdges[i]}%`;

    let ok = 0, failed = 0;
    let max = { spreadPct: -1 };
    let sum = 0;
    const above = { '0.20': 0, '0.35': 0, '0.50': 0 };
    // streaks: how many CONSECUTIVE blocks stay above the fee floor —
    // this is the persistence an executing bot would actually need
    let curStreak = 0, bestStreak = 0, streakBlocks = [];
    const t0 = Date.now();
    const rows = [];

    for (let b = start; b <= end; b += BATCH) {
        const blocks = [];
        for (let i = 0; i < BATCH && b + i <= end; i++) blocks.push(b + i);

        const results = await Promise.allSettled(blocks.map(blk => spreadAt(blk).then(s => ({ blk, s }))));

        for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value.s) { failed++; curStreak = 0; continue; }
            const { blk, s } = r.value;
            ok++;
            sum += s.spreadPct;
            if (s.spreadPct > max.spreadPct) max = { blk, ...s };

            let bi = bucketEdges.findIndex(e => s.spreadPct < e);
            if (bi === -1) bi = bucketEdges.length;
            buckets[bi]++;

            if (s.spreadPct >= 0.20) above['0.20']++;
            if (s.spreadPct >= 0.35) above['0.35']++;
            if (s.spreadPct >= 0.50) above['0.50']++;

            if (s.spreadPct >= FEE_FLOOR_PCT) {
                curStreak++;
                if (curStreak > bestStreak) { bestStreak = curStreak; }
                streakBlocks.push(blk);
            } else {
                curStreak = 0;
            }

            rows.push(`${blk},${s.f3.toFixed(4)},${s.f2.toFixed(4)},${s.spreadPct.toFixed(5)},${s.dir}`);
        }

        if (rows.length >= 500) { fs.appendFileSync(CSV_PATH, rows.join('\n') + '\n'); rows.length = 0; }

        const done = ok + failed;
        if (done % (BATCH * 25) < BATCH) {
            const pct = ((done / BLOCKS) * 100).toFixed(1);
            const rate = done / ((Date.now() - t0) / 1000);
            const eta = ((BLOCKS - done) / rate / 60).toFixed(1);
            console.log(`progress ${pct}%  (${done.toLocaleString()}/${BLOCKS.toLocaleString()})  ${rate.toFixed(1)} blk/s  ETA ${eta} min  max-so-far ${max.spreadPct >= 0 ? max.spreadPct.toFixed(4) + '%' : 'n/a'}`);
        }

        await sleep(DELAY_MS);
    }
    if (rows.length) fs.appendFileSync(CSV_PATH, rows.join('\n') + '\n');

    console.log('\n' + '='.repeat(72));
    console.log(`RESULTS — ${ok.toLocaleString()} blocks measured, ${failed} failed (${((Date.now() - t0) / 60000).toFixed(1)} min)\n`);
    console.log(`Mean spread:  ${(sum / ok).toFixed(4)}%`);
    console.log(`Max spread:   ${max.spreadPct.toFixed(4)}%  at block ${max.blk?.toLocaleString()}  (V3=${max.f3?.toFixed(2)} V2=${max.f2?.toFixed(2)} ${max.dir})`);
    console.log(`\nDistribution:`);
    for (let i = 0; i < buckets.length; i++) {
        const n = buckets[i];
        const bar = '#'.repeat(Math.round((n / ok) * 60));
        console.log(`  ${bucketLabel(i).padStart(14)}  ${String(n).padStart(7)}  ${((n / ok) * 100).toFixed(2).padStart(6)}%  ${bar}`);
    }
    console.log(`\nBlocks with spread >= 0.20%: ${above['0.20']}  (gross gap, below fee floor)`);
    console.log(`Blocks with spread >= 0.35%: ${above['0.35']}  (fee floor — both swap fees covered)`);
    console.log(`Blocks with spread >= 0.50%: ${above['0.50']}  (fee floor + margin)`);
    console.log(`Longest consecutive run >= ${FEE_FLOOR_PCT}%: ${bestStreak} blocks (${bestStreak * 2}s)`);
    if (streakBlocks.length) {
        console.log(`Blocks at/above fee floor: ${streakBlocks.slice(0, 20).join(', ')}${streakBlocks.length > 20 ? ` ... (+${streakBlocks.length - 20} more)` : ''}`);
    }
    console.log(`\nPer-block CSV: ${CSV_PATH}`);
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
