/**
 * Dense (every-block) scan of the WETH/USDC spread between Uniswap V3 (0.05% pool)
 * and Aerodrome's volatile pool on Base. Mirror of scanDense.js but for Aerodrome.
 *
 * Fee floor = V3 0.05% + Aerodrome 0.30% = 0.35% (Aerodrome getFee confirmed 30 bps).
 *
 *   node scripts/scanAeroDense.js
 *   BLOCKS=21600 node scripts/scanAeroDense.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Interface } = require('ethers');

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const V3_POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224';
const AERO_POOL = '0xcDAC0d6c6C59727a65F871236188350531885C43'; // volatile WETH/USDC
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

const BLOCKS = parseInt(process.env.BLOCKS || '7200');
const BATCH = parseInt(process.env.BATCH || '30');
const DELAY_MS = parseInt(process.env.DELAY_MS || '250');
const FEE_FLOOR_PCT = 0.35;

const mc3 = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)']);

const Q192 = 2n ** 192n;
const E18 = 10n ** 18n;

let _id = 1;
async function rpc(method, params, attempt = 0) {
  try {
    const res = await fetch(RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: _id++, method, params }) });
    if (res.status === 429) throw new Error('429');
    const j = await res.json();
    if (j.error) throw new Error(`RPC ${j.error.code}: ${j.error.message}`);
    return j.result;
  } catch (e) {
    if (attempt >= 5) throw e;
    await sleep(500 * 2 ** attempt);
    return rpc(method, params, attempt + 1);
  }
}
const toHex = n => '0x' + n.toString(16);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function v3Price(sqrt) { return Number(sqrt * sqrt * E18 / Q192) / 1e6; }
function ammPrice(r0, r1) { return Number(r1 * E18 / r0) / 1e6; }

async function spreadAt(block) {
  const callData = mc3.encodeFunctionData('aggregate3', [[
    { target: V3_POOL, allowFailure: false, callData: '0x3850c7bd' },   // slot0()
    { target: AERO_POOL, allowFailure: false, callData: '0x0902f1ac' }, // getReserves()
  ]]);
  const raw = await rpc('eth_call', [{ to: MULTICALL3, data: callData }, toHex(block)]);
  const [results] = mc3.decodeFunctionResult('aggregate3', raw);
  const sqrt = BigInt('0x' + results[0].returnData.slice(2, 66));
  const r0 = BigInt('0x' + results[1].returnData.slice(2, 66));
  const r1 = BigInt('0x' + results[1].returnData.slice(66, 130));
  if (sqrt === 0n || r0 === 0n) return null;
  const f3 = v3Price(sqrt), fa = ammPrice(r0, r1);
  const ratio = f3 > fa ? f3 / fa : fa / f3;
  return { f3, fa, spreadPct: (ratio - 1) * 100 };
}

async function main() {
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const end = latest, start = end - BLOCKS + 1;
  console.log(`V3 vs Aerodrome WETH/USDC — every block ${start.toLocaleString()}..${end.toLocaleString()} (${BLOCKS.toLocaleString()} blks, ~${(BLOCKS*2/3600).toFixed(1)}h)\n`);

  const edges = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.50, 1.00];
  const buckets = new Array(edges.length + 1).fill(0);
  const label = i => i === 0 ? `< ${edges[0]}%` : i === edges.length ? `>= ${edges[edges.length-1]}%` : `${edges[i-1]}% - ${edges[i]}%`;

  let ok = 0, failed = 0, sum = 0, max = { spreadPct: -1 };
  const above = { '0.20': 0, '0.35': 0, '0.50': 0 };
  let cur = 0, best = 0;
  const t0 = Date.now();

  for (let b = start; b <= end; b += BATCH) {
    const blocks = [];
    for (let i = 0; i < BATCH && b + i <= end; i++) blocks.push(b + i);
    const results = await Promise.allSettled(blocks.map(blk => spreadAt(blk).then(s => ({ blk, s }))));
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value.s) { failed++; cur = 0; continue; }
      const s = r.value.s; ok++; sum += s.spreadPct;
      if (s.spreadPct > max.spreadPct) max = { blk: r.value.blk, ...s };
      let bi = edges.findIndex(e => s.spreadPct < e); if (bi === -1) bi = edges.length;
      buckets[bi]++;
      if (s.spreadPct >= 0.20) above['0.20']++;
      if (s.spreadPct >= 0.35) above['0.35']++;
      if (s.spreadPct >= 0.50) above['0.50']++;
      if (s.spreadPct >= FEE_FLOOR_PCT) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    const done = ok + failed;
    if (done % (BATCH * 20) < BATCH) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`progress ${((done/BLOCKS)*100).toFixed(0)}%  ${rate.toFixed(1)} blk/s  max-so-far ${max.spreadPct.toFixed(4)}%`);
    }
    await sleep(DELAY_MS);
  }

  console.log('\n' + '='.repeat(72));
  console.log(`${ok.toLocaleString()} blocks measured, ${failed} failed (${((Date.now()-t0)/60000).toFixed(1)} min)\n`);
  console.log(`Mean spread: ${(sum/ok).toFixed(4)}%`);
  console.log(`Max spread:  ${max.spreadPct.toFixed(4)}%  at block ${max.blk?.toLocaleString()} (V3=${max.f3?.toFixed(2)} Aero=${max.fa?.toFixed(2)})\n`);
  console.log('Distribution:');
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i];
    console.log(`  ${label(i).padStart(14)}  ${String(n).padStart(7)}  ${((n/ok)*100).toFixed(2).padStart(6)}%  ${'#'.repeat(Math.round((n/ok)*60))}`);
  }
  console.log(`\nBlocks spread >= 0.20%: ${above['0.20']}  (${((above['0.20']/ok)*100).toFixed(2)}%) — gross gap, below fee floor`);
  console.log(`Blocks spread >= 0.35%: ${above['0.35']}  (${((above['0.35']/ok)*100).toFixed(2)}%) — clears fee floor`);
  console.log(`Blocks spread >= 0.50%: ${above['0.50']}  (${((above['0.50']/ok)*100).toFixed(2)}%) — floor + margin`);
  console.log(`Longest consecutive run >= ${FEE_FLOOR_PCT}%: ${best} blocks (~${best*2}s)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
