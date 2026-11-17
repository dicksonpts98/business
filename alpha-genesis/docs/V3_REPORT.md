# v3 report — strategy economics, improved search, and what changed (2026-11-17)

**Bottom line: the changes roughly halved the cost drag, but no strategy passes independent validation.
NO VALID EDGE FOUND, again, on real data — under the cheaper fee model, with the improved search, on both
the original four symbols and a ten-symbol universe.** Validation standards were not changed.

Everything here is computed from stored runs: `data_alpaca` (v2, legacy fees), `data_alpaca_v3a`
(v3, 4 symbols), `data_alpaca_v3` (v3, 10 symbols). All are git-ignored; reproduce with
`scripts/real_run.sh` and `scripts/economics_audit.py`.

## 1. What was wrong with the economics

Before v3 every trade paid **USD 0.005/share with a USD 1 minimum per order** — an IBKR-fixed-style
schedule, not Alpaca's. Alpaca US-equity trading is commission-free, with small pass-through regulatory
fees. v3 models that (`fee_model = "alpaca"`) and keeps the old schedule (`"legacy"`) for comparison.

> The regulatory rates (SEC Section 31 by date, FINRA TAF, CAT) come from my own knowledge. Alpaca's,
> FINRA's and the SEC's sites were unreachable from the build environment, so **they are not verified**.
> They are configurable, flagged `verified = false`, and amount to pennies per trade either way; the
> decisive change is the commission going to zero, which is not in doubt.

Costs are now recorded per trade in four separate parts — commission, regulatory fees, spread, slippage —
plus an FX translation figure (CAD result versus the same USD result at the first trade's rate).

### The earlier benchmarks, re-priced (real data, 2023-03-30 → 2026-09-21, CAD)

| Benchmark | Gross | Legacy: commission / spread / slippage → net | Alpaca: commission / regulatory / spread / slippage → net |
| --- | --- | --- | --- |
| Random entries | +184 | 3,885 / 1,735 / 1,570 → **−7,006** | 0 / 110 / 2,101 / 1,931 → **−4,067** |
| Passive (hold proxy intraday) | +1,496 | 2,378 / 656 / 1,311 → **−2,849** | 0 / 75 / 719 / 1,438 → **−648** |
| Momentum (ORB) | +3,316 | 8,620 / 2,152 / 2,318 → **−9,774** | 0 / 314 / 4,776 / 5,399 → **−3,827** |
| Mean reversion (VWAP) | −916 | 4,819 / 1,467 / 1,434 → **−8,635** | 0 / 113 / 1,937 / 1,946 → **−4,819** |
| Failed breakout | +1,901 | 7,322 / 2,226 / 2,087 → **−9,733** | 0 / 240 / 4,080 / 3,883 → **−6,970** |
| Similarity | +61 | 6,207 / 1,740 / 1,696 → **−9,583** | 0 / 175 / 2,874 / 2,916 → **−4,707** |

(Trade counts differ slightly between the two because the legacy schedule drains the account, which
shrinks later positions.) FX translation was between −110 and +80 CAD for every row: negligible.

**What actually caused the losses**

1. Under the old model, **commissions were 40–55% of all costs** — an assumption error, now corrected.
2. With commissions removed, **every benchmark still loses**, because modelled spread and slippage alone
   exceed gross profit.
3. The underlying problem is the size of the gross edge. Before any cost, on real data
   (2023-03-30 → 2026-11-16):

| Benchmark | Gross edge per round trip | Modelled cost per round trip |
| --- | --- | --- |
| Random entries (control) | 0.00 bps | 4.3 bps |
| Passive | 1.85 bps | 3.1 bps |
| Momentum (ORB) | 1.64 bps | 3.9 bps |
| Similarity | 1.07 bps | 4.1 bps |
| Failed breakout | 0.28 bps | 4.2 bps |
| Mean reversion (VWAP) | −0.66 bps | 4.1 bps |

   The random control netting exactly zero before costs confirms the backtester is unbiased. The best
   simple idea earns about 1.6 bps per round trip; it would need total execution cost below that to break
   even. Spread and slippage are **modelled** (0.5–2 bps half-spread plus 1 bp slippage per side), not
   measured: this is the single assumption that could change the picture, and only quote data can settle it.

## 2. What was changed to improve profitability potential

| Change | Implementation |
| --- | --- |
| Net expectancy first | Fitness and validation were already based on net daily P&L; unchanged. Win rate and AUC are reported, never optimised. |
| Selectivity | New causal feature `cost_ratio` = modelled round-trip cost ÷ typical one-hour move. Strategies can require the expected move to be large relative to cost; the search adds this filter to 40% of candidates. |
| Holding periods | 15, 30, 60, 120 minutes and hold-to-close are now the search's exit choices. |
| Failure analysis | Darwin reads earlier trials that earned gross profit but lost it to costs and turns each into a "trade less, hold longer, demand a bigger move" hypothesis (`cost_drag`), tested like any other. |
| Wider universe | IWM, DIA, AAPL, MSFT, AMD, META added (755,280 real SIP bars in total). |
| Unchanged on purpose | Search budget per cycle, the validation policy file, the holdout rules, the risk limits. |

## 3. Original versus improved, on the same real sessions

Same partitions, same 120 held-back sessions replayed one at a time, same validation policy.

| | v2 (legacy fees, 4 symbols) | v3a (Alpaca fees + new search, 4 symbols) | v3 (same, 10 symbols) |
| --- | --- | --- | --- |
| Strategies evaluated | 2,466 | 2,477 | 2,448 |
| Shortlisted on development | 44 | 48 | 47 |
| **Passed validation** | **0** | **0** | **0** |
| Best validation p-value | 0.094 | 0.094 | 0.328 |
| Reached the Skeptic / approved | 0 / 0 | 0 / 0 | 0 / 0 |
| Paper orders, final equity | 0, CAD 10,000 | 0, CAD 10,000 | 0, CAD 10,000 |
| Cycle overfitting probability | 0.44–0.73 | 0.16–0.77 | 0.30–0.86 |
| Cost-drag hypotheses tested | — | 13, all rejected | 14, all rejected |
| ML model AUC | 0.500–0.520 | 0.500–0.520 | 0.494–0.515 |
| Ablation | every arm: no-trade | every arm: no-trade | every arm: no-trade |

Benchmarks on the final validation window (2025-07-25 → 2026-09-21), net CAD, v2 → v3a:

| Benchmark | v2 net | v3a net | v3a max drawdown | Still negative? |
| --- | --- | --- | --- | --- |
| Passive | −1,153 | −418 | −731 | yes |
| Similarity | −2,675 | −634 | −1,011 | yes |
| Momentum (ORB) | −5,194 | −1,719 | −2,132 | yes |
| Mean reversion (VWAP) | −3,211 | −1,696 | −1,934 | yes |
| Random entries | −3,227 | −2,008 | −2,119 | yes |
| Failed breakout | −6,923 | −4,588 | −4,935 | yes |

**Did the changes help?**

- **Expectancy:** less negative everywhere (benchmark losses cut by roughly 40–75%), never positive.
- **Drawdown:** smaller, for the same reason.
- **Robustness:** the search now surfaces a few candidates that stay positive at 3× costs on validation
  (e.g. a trend-following rule on days when the market trend is down: +516 CAD over 29 trades, p = 0.094),
  but none is statistically distinguishable from luck after multiple-testing control.
- **Out-of-sample:** nothing qualified, so nothing was tested out of sample and the selection holdout was
  never consumed. The no-trade benchmark ranks first in every run.
- **Wider universe:** did not help; the best candidate was weaker (p = 0.33) and the search overfitted more.

## 4. Caveat on "unseen" data

The v3 changes were designed after I had seen v2's aggregate results, including benchmark results on the
later windows. No strategy was selected using those windows, but the *design choices* were informed by
them. Had v3 approved something, that approval would deserve extra suspicion and a fresh forward paper
period. As it stands the result is negative, which this kind of leak cannot manufacture.

## 5. What would be needed for a different answer

1. **Measured spreads.** Quote data to replace the modelled 3–4 bps round-trip cost. If true costs on SPY/QQQ
   are near 1 bp, the momentum and passive effects become roughly break-even rather than losing — still
   not an edge, but a different starting point.
2. **A different kind of signal.** Fourteen price-pattern detectors, state similarity and two model
   families all sit at or near zero gross edge on 5-minute bars. More parameter search over the same
   inputs is unlikely to change that; new information (order flow, cross-asset, event data) might.
3. **Forward paper results** for anything that does eventually pass.
