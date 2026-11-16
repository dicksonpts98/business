# ALPHA GENESIS

An autonomous quantitative research and **paper-trading** platform: six integrated engines that
discover, test, reject, promote and monitor intraday trading strategies without a human in the loop,
with a dashboard that shows every stored experiment.

> **Read this first.**
> - This build has **never seen real market data**. The environment it was built in blocks every
>   market-data host and has no broker credentials, so all results come from a clearly labelled
>   **synthetic** market. They demonstrate that the machinery works. They say nothing about whether any
>   edge exists in real markets.
> - **No profitable trading edge is claimed.** The synthetic market contains a deliberately planted
>   effect (a positive control) and the system finds it; on a market with nothing planted it approves
>   nothing. See [docs/RESEARCH_REPORT.md](docs/RESEARCH_REPORT.md).
> - **Paper only.** There is no live order routing in this codebase, and the Risk Guardian refuses to
>   start if `paper_only` is turned off.

## Quick start

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
- [docs/RESEARCH_REPORT.md](docs/RESEARCH_REPORT.md) — what the experiments found, including negatives
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

Captured by `scripts/smoke.cjs` from the finished synthetic demo run: [docs/screenshots/](docs/screenshots/)
(`command`, `radar`, `twins`, `traps`, `darwin`, `arena`, `skeptic`, `paper`, `learning`, `settings`).
