# Development audit

Status key — **Tested**: implemented and covered by automated tests that were run. **Implemented**:
works in the demo run but has thin or no dedicated tests. **Unverified**: code exists, never exercised
against the real thing. **Not built**: absent.

## Core engines

| Item | Status | Notes |
| --- | --- | --- |
| Market Doppelgänger: 4 retrieval methods, walk-forward, baselines, calibration, self-disabling gate | Tested | "Time-series distance" is Euclidean distance on the normalised return path; DTW is not implemented. "Learned embedding" is a ridge-weighted metric, not a neural embedding. |
| Market Lie Detector: 14 patterns, causal state machines, outcome statistics, replay | Tested | Pattern #10 (liquidity) is a volume proxy: no quote or order-book data exists. Alternative entries are limited to next-open and one-bar confirmation. |
| Darwin: typed language, hypotheses, GA, Optuna, Thompson sampling over families, lineage, knowledge base | Tested | Position sizing in the language is fixed-risk or half-risk only. Bandit use is family-level budget allocation, not a per-trade contextual bandit. Ensembles of strategies are not built. |
| Alpha Arena: benchmarks, identical conditions, LCB ranking, head-to-head, promotion policy | Tested | One champion at a time; no portfolio of concurrent strategies. |
| Research Skeptic: 20 checks, holdout budget, ablation study | Tested | Survivorship is flagged, not corrected (fixed present-day universe). PBO is per cycle. |
| Risk Guardian: limits, kill switch, reconciliation, audit chain | Tested | Limits are immutable in-process; anyone with file access can still edit `risk.toml` and restart (the hash on later decisions will differ). |

## Self-learning and operations

| Item | Status | Notes |
| --- | --- | --- |
| Post-session pipeline, drift (PSI), prediction scoring, champion health, quarantine, rollback | Tested | |
| Epoch rolling and model retraining as new immutable versions | Tested | |
| Checkpointed research cycle; persistent job queue with retries and recovery | Tested | Single worker by design. |
| Paper engine: bar-by-bar, idempotent orders, partial fills, crash resume, explanations, loss attribution | Tested | Attribution is rule-based; it informs hypotheses only through per-regime champion weakness. |
| Timer-driven schedule inside `serve` | Implemented | Scheduler and queue are tested; the long demo was driven synchronously through the same pipeline function, not by the timer. |
| Backup / restore, CSV export, `verify` | Tested | |
| Structured JSON logs, health endpoint | Implemented | No log rotation or external notification channel. |
| Docker image and compose file | Unverified | Written; no Docker daemon available to build them. |
| Windows / WSL2 | Unverified | Linux only. Nothing OS-specific is used. |

## Data

| Item | Status | Notes |
| --- | --- | --- |
| Synthetic market with planted and null modes, simulated session feed | Tested | Not historical data. |
| CSV import, validation, split/dividend adjustment, 1→5-minute aggregation, checksums, versions | Tested | |
| Parquet import | Implemented | Same path as CSV after file reading; no dedicated round-trip test. |
| Exchange calendar with holidays, early closes, DST | Tested | Rule-based; ad-hoc closures need manual entries. |
| USD/CAD handling with as-of dates and staleness block | Tested | No automated FX fetcher. |
| MCP client + Alpha Vantage MCP provider: handshake, bearer auth, tool discovery, daily bars, USD/CAD | Tested (simulated server) and verified live | Real data fetched 2026-11-16 with a free key: 100 daily bars × 4 instruments and 100 USD/CAD rates. |
| Alpha Vantage MCP 5-minute bars | Unverified | The free plan refuses `TIME_SERIES_INTRADAY` (premium endpoint). Code follows the published tool schema; tested only against a simulated server. |
| Alpaca market-data adapter | Unverified | Never connected. |
| Alpaca paper-broker adapter | Unverified / incomplete | Submit and positions written; fills are not wired into the paper engine. |
| Databento or other providers | Not built | Implement `Provider` (3 methods). |
| Bid/ask quotes, spreads, order book | Not built | Spreads are modelled constants; flagged on every review. |
| Real historical evaluation | **Not done** | Real *daily* bars are now reachable, but the engines need 5-minute bars, which no free source reachable from here provides. Still the largest gap. |

## Dashboard

All ten screens load real stored results and label their data kind and segment (browser smoke check).
Interactions exercised by hand through the API tests rather than by UI automation. Not built:
drag-to-select replay ranges, per-chart export, mobile-optimised layouts (it is responsive down to
tablet width; desktop-first), authentication beyond the optional operator token.

## Known limitations that affect conclusions

1. **Synthetic-only evidence.** Every number in the research report comes from a generated market.
2. **Small-account cost drag is modelled, not measured.** Commission minimums and modelled spreads
   consumed 35–80% of gross profit in the demo; real fills could be better or worse.
3. **The holdout gate is one look at ~40–140 sessions.** It has limited power; the demo shows it both
   passing strategies that later died with the planted effect and rejecting everything once the effect
   was gone.
4. **Regime classification lags** (20-session trailing volatility); about 18 losing paper trades in
   the first demo run were attributed to a misclassified session.
5. **Stops on synthetic bars** are tested against generated wicks, which are not a faithful model of
   intrabar paths.

## Sensible next steps

1. Supply real 5-minute history (CSV/Parquet) plus `fx_usdcad.csv` and rerun: the whole report
   regenerates from stored experiments. Expect "no edge found" as the base case.
2. Verify the Alpaca adapters with paper credentials; wire broker fills into the paper engine.
3. Add quote data and replace modelled spreads; re-run the cost stress.
4. Build the Docker image in CI and run the test suite there.
5. Widen the universe only after (1)–(3); add survivorship-free constituent lists if it grows.
