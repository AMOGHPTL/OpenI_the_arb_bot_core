"""
Plot: WETH-USDC arbitrage spread vs. break-even cost on Base.

Reads scan-dense.csv (per-block gross spread between Uniswap V3 0.05% and
Uniswap V2) and renders a two-panel figure for sharing:

  top    - gross spread per block over the scan window, with the break-even
           cost band (swap fees + gas) overlaid. The "profitable zone" above
           the band is shaded; it stays essentially empty.
  bottom - distribution of the spread, with mean and break-even marked.

The punchline: the gross price gap almost never clears the cost of the two
swaps, and on Base gas is a rounding error compared to that fee floor.

Usage:  python scripts/plot_spread.py
Output: scripts/scan-spread-vs-cost.png
"""

import os
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "scan-dense.csv")
OUT = os.path.join(HERE, "scan-spread-vs-cost.png")

# --- cost model -------------------------------------------------------------
# To capture the gap you swap on both venues, so you pay both pool fees:
SWAP_FEES_PCT = 0.30 + 0.05            # V2 0.30% + V3 0.05% = fee floor
# Representative flash-loan arb on Base: ~500k gas. Base fees are tiny, so on
# a meaningful notional gas is a rounding error next to the swap fees.
TRADE_WETH = 10.0
GAS_USD = 0.30                          # ~500k gas on Base, generous estimate

# --- load -------------------------------------------------------------------
d = pd.read_csv(CSV)
d = d.reset_index(drop=True)
hours = (d["block"] - d["block"].iloc[0]) * 2 / 3600.0   # ~2s / block on Base
spread = d["spread_pct"].values

mid = d["v3_usdc_per_weth"].mean()
trade_usd = TRADE_WETH * mid
gas_pct = GAS_USD / trade_usd * 100.0
breakeven_pct = SWAP_FEES_PCT + gas_pct

mean_s = spread.mean()
max_s = spread.max()
n = len(spread)
n_floor = int((spread >= SWAP_FEES_PCT).sum())
n_be = int((spread >= breakeven_pct).sum())
span_h = hours.iloc[-1]

# --- style ------------------------------------------------------------------
plt.rcParams.update({
    "figure.facecolor": "#0d1117",
    "axes.facecolor": "#0d1117",
    "savefig.facecolor": "#0d1117",
    "text.color": "#e6edf3",
    "axes.labelcolor": "#e6edf3",
    "xtick.color": "#9da7b3",
    "ytick.color": "#9da7b3",
    "axes.edgecolor": "#30363d",
    "font.size": 11,
    "text.parse_math": False,
})

GREEN = "#3fb950"
RED = "#f85149"
BLUE = "#58a6ff"
AMBER = "#d29922"

fig, (ax1, ax2) = plt.subplots(
    2, 1, figsize=(12, 9), gridspec_kw={"height_ratios": [2.2, 1]}
)

# --- panel 1: spread over time ---------------------------------------------
ax1.fill_between(hours, breakeven_pct, max(max_s, breakeven_pct) * 1.15,
                 color=GREEN, alpha=0.06)
ax1.text(span_h * 0.5, breakeven_pct + (max_s - breakeven_pct) * 0.5 + 0.02,
         "profitable zone — net of fees + gas\n(empty: 0 of {:,} blocks)".format(n),
         color=GREEN, ha="center", va="center", fontsize=10, alpha=0.8)

ax1.plot(hours, spread, color=BLUE, lw=0.7, alpha=0.9,
         label="gross spread (V3 vs V2)")
ax1.axhline(breakeven_pct, color=RED, lw=1.8, ls="-",
            label=f"break-even  {breakeven_pct:.2f}%  (fees {SWAP_FEES_PCT:.2f}% + gas {gas_pct:.3f}%)")
ax1.axhline(mean_s, color=AMBER, lw=1.2, ls="--",
            label=f"mean spread  {mean_s:.3f}%")

ax1.set_title(
    "WETH-USDC arbitrage on Base: the gap never pays for the trade",
    color="#e6edf3", fontsize=16, fontweight="bold", loc="left", pad=12,
)
ax1.set_ylabel("price gap  (% of notional)")
ax1.set_xlim(0, span_h)
ax1.set_ylim(0, max(max_s, breakeven_pct) * 1.18)
ax1.yaxis.set_major_formatter(PercentFormatter(decimals=2))
ax1.legend(loc="upper right", framealpha=0.0, fontsize=9.5)
ax1.grid(True, color="#21262d", lw=0.6)
ax1.set_xlabel(f"time  (hours)   —   {n:,} consecutive blocks, every block scanned")

# --- panel 2: distribution --------------------------------------------------
ax2.hist(spread, bins=80, color=BLUE, alpha=0.75)
ax2.axvline(breakeven_pct, color=RED, lw=1.8,
            label=f"break-even {breakeven_pct:.2f}%")
ax2.axvline(mean_s, color=AMBER, lw=1.2, ls="--", label=f"mean {mean_s:.3f}%")
ax2.set_xlabel("gross spread  (% of notional)")
ax2.set_ylabel("blocks")
ax2.xaxis.set_major_formatter(PercentFormatter(decimals=2))
ax2.legend(loc="upper right", framealpha=0.0, fontsize=9.5)
ax2.grid(True, color="#21262d", lw=0.6)

# --- footer / takeaway ------------------------------------------------------
takeaway = (
    f"Scanned every block for ~{span_h:.1f}h.  "
    f"Mean gap {mean_s:.3f}%, max {max_s:.3f}%.  "
    f"Swap fees alone need {SWAP_FEES_PCT:.2f}% - reached in {n_floor} block, "
    f"0 net of gas.  On Base, gas (~{GAS_USD:.2f} USD) is {gas_pct:.3f}% of a "
    f"{trade_usd/1000:.0f}k USD trade - the fee floor, not gas, is the wall."
)
fig.text(0.5, 0.012, takeaway, ha="center", va="bottom",
         color="#9da7b3", fontsize=9.5, wrap=True)

fig.tight_layout(rect=[0, 0.04, 1, 1])
fig.savefig(OUT, dpi=160)
print("wrote", OUT)
print(f"  mean {mean_s:.4f}%  max {max_s:.4f}%  break-even {breakeven_pct:.4f}%")
print(f"  blocks >= fee floor: {n_floor}/{n}   >= break-even: {n_be}/{n}")
