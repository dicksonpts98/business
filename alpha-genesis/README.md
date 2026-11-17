# ALPHA GENESIS

An autonomous quantitative research and **paper-trading** platform: six integrated engines that
discover, test, reject, promote and monitor intraday trading strategies without a human in the loop,
with a dashboard that shows every stored experiment.

> **Read this first.**
> - **Real-data result: NO VALID EDGE FOUND.** On 302,112 real 5-minute bars (Alpaca SIP, SPY/QQQ/NVDA/TSLA,
>   2023-01-03 → 2026-11-16) the system evaluated 2,466 strategies, none passed validation, and it never
>   traded. See [docs/REAL_DATA_REPORT.md](docs/REAL_DATA_REPORT.md).
> - **v3** corrected the fee model (commission-free, as at Alpaca) and improved the search; costs roughly
>   halved but still nothing passed validation, on 4 or on 10 symbols. See [docs/V3_REPORT.md](docs/V3_REPORT.md).
> - The synthetic experiments ([docs/RESEARCH_REPORT.md](docs/RESEARCH_REPORT.md)) show the machinery can
>   find, trade and then abandon an effect that is deliberately planted. They are not market evidence.
> - **Paper only.** There is no live order routing in this codebase, and the Risk Guardian refuses to
>   start if `paper_only` is turned off.

## Quick start

**From the release zip:** Windows — double-click `start.bat`; Linux/macOS/WSL — `./start.sh`. Then open
http://127.0.0.1:8000. The dashboard is pre-built; only Python 3.11+ is needed.

**From source:**

```bash
cd alpha-genesis
pip install -r requirements.txt && pip install -e backend
(cd frontend && npm ci && npm run build)
python -m alpha_genesis.cli serve            # http://127.0.0.1:8000
```

The first start generates the synthetic market, builds features, trains the first models and locks the
first data partition (about a minute). Then, in the dashboard's Command Center:
**Run research cycle** → **Ingest next session** (repeat, or use +20). Or from the shell:

```bash
./scripts/demo_run.sh 196     # init + first research cycle + replay all reserved sessions + ablation
```

Docker: `docker compose up --build` (the image definition is provided but was not built in the
development environment — no Docker daemon was available).

## The six engines

| Engine | Module | What it does |
| --- | --- | --- |
| Market Doppelgänger | `doppelganger.py` | Finds earlier market states resembling now (4 retrieval methods), reports what followed, and **disables itself** when it cannot beat unconditional and base-rate baselines out of sample. |
| Market Lie Detector | `liedetector.py` | 14 failed-pattern detectors written as bar-by-bar state machines, so no event can be seen before its confirming bar closes. Event replay shows exactly what was known. |
| Darwin Trader | `darwin.py`, `dsl.py` | Observes → hypothesises → evolves typed strategies (genetic search + Optuna tuning + family-level Thompson sampling) on development data, shortlists on validation with FDR control, records every trial. |
| Alpha Arena | `arena.py` | Every strategy version and 8+ benchmarks (no-trade, random, passive, momentum, mean-reversion, failed-breakout, similarity, ML) under identical conditions; ranks by a lower confidence bound, applies the promotion policy. |
| Research Skeptic | `skeptic.py` | Independent adversarial review: look-ahead probe, block bootstrap, Deflated Sharpe, PBO, entry-timing permutation test, cost stress, parameter sensitivity, concentration, ablation, then one budgeted look at the holdout. |
| Risk Guardian | `guardian.py`, `broker.py`, `paper.py` | Frozen CAD risk limits, kill switch, idempotent orders, stale-data/FX/session checks, reconciliation, hash-chained audit log. Research code has no API to change it. |

`learning.py` + `jobs.py` tie them into a persistent loop: each completed session is ingested,
paper-traded, scored, checked for drift and deterioration, and may trigger a new epoch, retraining and
a research cycle. Everything is checkpointed and resumes after a crash or restart.

## Documentation

- [docs/OPERATIONS.md](docs/OPERATIONS.md) — running it, credentials, importing data, scheduling, backups
- [docs/V3_REPORT.md](docs/V3_REPORT.md) — fee audit, improved search, original vs improved on real data
- [docs/REAL_DATA_REPORT.md](docs/REAL_DATA_REPORT.md) — the real-market evaluation (Alpaca SIP data)
- [docs/RESEARCH_REPORT.md](docs/RESEARCH_REPORT.md) — synthetic positive and null controls
- [docs/TESTING_REPORT.md](docs/TESTING_REPORT.md) — test commands, results, defects found and fixed
- [docs/AUDIT.md](docs/AUDIT.md) — implemented vs tested vs unverified vs not built
- [docs/RESOURCES.md](docs/RESOURCES.md) — hardware, compute, optional provider costs, maintenance
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow, partitions, lifecycle, statistical design

## Tests

```bash
cd backend && python -m pytest tests -q          # 114 tests, ~7 minutes on 4 cores
node scripts/smoke.cjs http://127.0.0.1:8000     # browser check of all ten screens (server must be running)
```

## Screenshots

Real-data run: [docs/screenshots_real/](docs/screenshots_real/). Synthetic demo run: [docs/screenshots/](docs/screenshots/)
(`command`, `radar`, `twins`, `traps`, `darwin`, `arena`, `skeptic`, `paper`, `learning`, `settings`).
