# Real-market research report — 2026-11-17

**Conclusion: NO VALID EDGE FOUND.** On real 5-minute data for SPY, QQQ, NVDA and TSLA, the system
evaluated 2,466 strategies over 7 research cycles and none passed validation. It never placed a paper
order and ended in no-trade mode. This is a genuine result, not a failure of the software.

Everything below was read from the stored experiment database of the run (`data_alpaca/`, git-ignored).
Reproduce with `./scripts/real_run.sh init`, `cycle`, `advance 120`, `ablation` (credentials required).

## 1. Market data

| | |
| --- | --- |
| Provider | Alpaca Market Data v2, `https://data.alpaca.markets`, authenticated (HTTP 200) |
| Feed | **SIP** for every request; no entitlement refusal was returned for any of the 188 symbol-months |
| Bars | 5-minute, split-adjusted, regular session only |
| Coverage | 2023-01-03 → 2026-11-16, 972 sessions |
| Valid bars | **75,528 per symbol, 302,112 in total** |
| Integrity | 0 duplicates, 0 invalid OHLCV rows, 0 missing bars, 0 data issues logged; the 8 short sessions are exactly the 8 scheduled early closes (42 bars each) |
| Corporate actions | Alpaca reports one split in the window: NVDA 10:1, ex 2024-06-10. Adjusted prices are continuous across it (close 120.87 → next open 120.35). Dividends are **not** adjusted (irrelevant intraday, positions are never held overnight). |
| USD/CAD | Bank of Canada FXUSDCAD, 974 daily rates, previous business day's rate used for each session; oldest rate used was 5 days old (holiday weekends) |
| Requests | 197 in total, 0 retries, rate limit 200/min never reached |
| Storage | month-partitioned Parquet with sha256 per file and a manifest; re-running fetches only the open month |

Restrictions that still apply: quotes (bid/ask) were not downloaded, so spreads are **modelled**
(0.5–2 bps half-spread, 1 bp slippage, USD 0.005/share with a USD 1 minimum, 3× stress). The universe is
four instruments chosen with present-day knowledge. The Bank of Canada host was later removed from this
environment's allow-list, so FX cannot refresh here until it is re-added; the cache runs to 2026-11-13.

## 2. Design of the evaluation

- Research partition: first 852 sessions (2023-01-03 → 2026-05-27): development 2023-03-30 → 2024-10-10,
  validation 2024-10-11 → 2025-07-22, **holdout 2025-07-23 → 2026-05-27**.
- The last 120 sessions (2026-05-28 → 2026-11-16) were held back and delivered one session at a time
  (a controlled sequential test on real data). Every 40 new sessions a new epoch was locked with those
  never-searched sessions as the next holdout, and the models were retrained.
- Labels never cross a session, so a session-level split needs no further purge; decisions fill at the
  next bar's open.
- The strategy-selection holdout was **never consumed**: no candidate got far enough to earn a look.
  The only holdout use is one recorded ablation evaluation.

## 3. Findings

**Failed-pattern statistics (Lie Detector), 2023-03-30 → 2026-09-21, fade direction, 12 bars from next open:**

| Pattern | n | Mean (bps) | 95% CI | Net of modelled costs (bps) |
| --- | --- | --- | --- | --- |
| ORB fail up | 1,132 | +2.8 | [−1.4, +7.4] | −1.3 |
| ORB fail down | 1,192 | −0.6 | [−5.2, +4.0] | −4.7 |
| Prev-day-high fail | 983 | +2.7 | [−3.0, +9.5] | −1.6 |
| Prev-day-low fail | 871 | −1.6 | [−8.8, +4.9] | −5.9 |
| VWAP reclaim fail | 1,582 | −0.3 | [−3.8, +2.9] | −4.5 |
| VWAP loss fail | 1,769 | +1.4 | [−1.4, +4.1] | −2.9 |
| Momentum fail up / down | 808 / 917 | −2.2 / +0.1 | spans 0 | −6.3 / −4.1 |
| Range re-entry up / down | 3,581 / 3,484 | −0.2 / +0.2 | spans 0 | −4.5 / −4.1 |
| Squeeze fail | 2,653 | −1.3 | [−5.3, +1.3] | −5.7 |
| Volume climax reversal | 587 | −4.9 | [−21.0, +9.0] | −9.0 |
| False breakdown recovery | 3,190 | −1.2 | [−3.9, +1.5] | −5.3 |
| Sweep-high fail | 1,350 | −4.8 | [−14.2, +2.3] | −9.0 |

**Every one of the 14 patterns has a confidence interval that includes zero, and every one is negative
after costs.** None of these "failed breakout" ideas shows a reliable tendency on this data.

**Market Doppelgänger.** On the first partition all four retrieval methods failed the gate (rank-IC
intervals include zero: 0.013 [−0.002, 0.029] for the best) and the engine disabled itself. After later
epochs one method passed marginally and the engine was re-enabled, but every hypothesis built on it was
rejected on validation and the similarity benchmark lost money after costs.

**Machine-learning models.** Eight model versions were trained (logistic and gradient boosting, v1–v4).
Internal AUC ranged 0.500–0.520 — indistinguishable from chance for trading purposes. Every ML benchmark
ranked at the bottom of the Arena.

**Darwin.** 7 cycles, 2,466 recorded strategy evaluations, 29 hypotheses (17 rejected, 12 skipped as
already rejected on unchanged data). 44 strategies were shortlisted on development fitness; **0 passed
the validation gate** (FDR-controlled). The best validation p-value seen was 0.094. Cycle-level
probability of backtest overfitting was 0.44–0.73: the search was mostly fitting noise, and the system
measured that.

**Alpha Arena, final (holdout 2026-09-22 → 2026-11-16, 40 sessions; validation column 2025-07-25 → 2026-09-21):**

| Rank | Competitor | OOS net (CAD) | Validation: gross → costs → net (CAD) | Val. trades |
| --- | --- | --- | --- | --- |
| 1 | **No trade** | 0 | 0 | 0 |
| 2 | Similarity | −383 | +1,467 → 4,142 → −2,675 | 769 |
| 3 | Passive (hold proxy intraday) | −367 | +366 → 1,519 → −1,153 | 289 |
| 4 | Random entries | −260 | −315 → 2,912 → −3,227 | 494 |
| 5 | Mean reversion (VWAP) | −551 | −116 → 3,095 → −3,211 | 584 |
| 6 | Failed breakout | −1,453 | −920 → 6,003 → −6,923 | 1,167 |
| 7 | Momentum (ORB) | −1,425 | +2,015 → 7,209 → −5,194 | 1,465 |
| 8–11 | ML (logit v1–v4) | −1,883 to −2,501 | ≈ ±800 → ≈ 9,000 → ≈ −9,600 | ≈ 2,200 |

The no-trade benchmark won. The momentum baseline was the only one with meaningfully positive *gross*
P&L, and costs were 3.6× that gross. On a CAD 10,000 account the commission minimum alone is roughly
4 bps per round trip, which is larger than every measured pattern effect.

**Engine ablation** (same budget and seed per arm, selected on validation, scored on the 40-session
holdout): every arm — benchmarks only, + Doppelgänger, + Lie Detector, + both, full Darwin, full
architecture — selected **no-trade**, so every increment is exactly zero. No engine demonstrated
incremental value on real data. On this evidence the added complexity is not earning anything.

**Look-ahead check on real bars.** The truncation probe compared 52,676 feature, event, score and
signal values across 24 cut points for three strategy types (event, feature + filter, ML): 0 mismatches.

## 4. Self-learning on real data (what actually ran)

| Step | Evidence |
| --- | --- |
| Initial training | logit-v1, lgbm-v1 on the first development window |
| New observations | 120 real sessions ingested one at a time, each validated (0 issues) |
| Scheduled re-evaluation | 6 research cycles triggered every 20 sessions, run through the persistent job queue (6 jobs, 0 failed) |
| Retraining | new epochs at +40, +80, +120 sessions; models retrained to v2, v3, v4; earlier versions preserved |
| Challenger generation | ≈ 350 strategies per cycle |
| Validation | 0 challengers reached the Skeptic |
| Promotion / rollback | **none occurred** — nothing qualified. Promotion, quarantine and rollback are therefore demonstrated only in the synthetic tests, not on real data. |
| Drift | 120 daily checks; no session had ≥ 3 shifted features |
| Restart | the process was restarted between every stage (init, cycle, replay, ablation, serve); state reloaded in ≈ 11 s each time |
| Paper trading | 120 sessions processed, 0 orders, equity CAD 10,000.00 throughout |

## 5. Limits of this conclusion

- Four instruments, 3.9 years, one account size, one bar size, intraday-only holding. "No edge found"
  applies to this strategy language on this data; it is not a statement about markets in general.
- Costs are modelled. With real quotes the picture could be somewhat better or worse, but a gap of
  several basis points per trade would have to close for any pattern here to matter.
- Validation windows of 190–290 sessions have limited power to detect small edges; a true edge below
  roughly 2–3 bps per trade would be invisible at these sample sizes, and also untradeable at these costs.
- Fitness requires at least 30 development trades and stability across thirds; very rare-event
  strategies are excluded by construction.
