# Architecture

One Python process: FastAPI (API + built dashboard), one worker thread, SQLite (WAL) for state,
Parquet for bars. No message broker, no separate services.

```
providers ─► quality ─► Market grid [symbol × session × 78 five-minute bars]  (Parquet + sha256 + version)
                              │
                 features.py  │  causal, bounded look-back; batch == incremental
                              ▼
      ┌──────────── FeatureStore (every column the strategy language can read) ────────────┐
      │  liedetector: ev:<PATTERN>, inv:<PATTERN>     doppelganger: dop_mean_z, dop_pup    │
      │  models: ml:<id> (usable only after its training window)                           │
      └─────────────────────────────────────────────────────────────────────────────────────┘
                              │
   Darwin (dev + val only) ──► trials ──► candidates ──► Skeptic (val, then one holdout look)
                                                              │ APPROVED / REJECTED
                                                              ▼
                               Arena (holdout + forward, all benchmarks) ──► promotion policy
                                                              │ SHADOW → CHAMPION (frozen artifact)
                                                              ▼
            new session ─► paper engine ─► Risk Guardian ─► paper broker ─► trades, attribution
                              │
                 drift · prediction scoring · champion health ─► research trigger / quarantine / rollback
```

## Timing contract

A signal exists at the close of bar *t*. The earliest fill is the open of bar *t+1*. This is enforced
in one place for research (`backtest.run`) and one for paper (`paper.PaperEngine`); the two are
independent implementations and every paper session is compared with the research backtest of the
same session (`paper_session.discrepancy_cad`). Disagreement without a risk intervention raises an
alert — this check found three real inconsistencies during development.

## Data partitions and the holdout

```
epoch k:  | warm-up 60 | development (2/3) | validation (1/3) | holdout | forward → paper …
epoch k+1:| warm-up 60 | development ………………………………… | validation | holdout = epoch k's forward sessions |
```

- Darwin can touch development and validation only (`core.ResearchView` raises and audits otherwise).
- The Skeptic spends the holdout: once per strategy, only for candidates that passed everything else,
  at most `max_holdout_uses_per_epoch` times. Every use is in `holdout_ledger`.
- A new epoch is locked only from sessions no search has seen. The old, consumed holdout is folded
  into development/validation and is never again called untouched.
- Models are retrained per epoch as new immutable versions; a model's scores are unusable inside its
  own training window (`min_day`).

## Strategy lifecycle

`CANDIDATE → APPROVED → SHADOW → CHAMPION → RETIRED | QUARANTINED | ROLLED_BACK`, plus `REJECTED`.
All transitions go through `registry.transition`, which checks the evidence (a genuine APPROVED
Skeptic report; shadow days; forward P&L; the active risk-limit hash). A database trigger independently
refuses SHADOW/CHAMPION without an approved report, strategy specs are immutable at the SQL level, and
the promotions and audit tables are append-only. Promotion freezes a JSON artifact (spec, model hash,
risk and policy hashes, `PAPER_ONLY`); the paper engine trades the artifact, and rollback re-activates
the predecessor's original artifact after re-checking its hash.

## Statistical design choices

- **Unit of independence is the session.** Bootstraps are circular block bootstraps over daily P&L
  (block 5); event statistics cluster by session.
- **Search size is always known.** Every evaluated strategy is a row in `trials`; Deflated Sharpe uses
  the cumulative count for the epoch; PBO (CSCV) is computed over the cycle's top 40 configurations.
- **Fitness is not return.** ½·t(all development days) + ½·t(weakest third) − complexity charge.
- **Ranking is not return.** Arena score = 5% lower bound of mean daily P&L on post-selection sessions;
  the no-trade benchmark scores 0 and must be beaten.
- **Costs are first-class.** Commission (USD 0.005/share, USD 1 minimum), modelled half-spread per
  instrument, slippage, a 3× stress scenario that candidates must survive, a 2% participation cap.
  Quotes are not available, so every review carries a "fill realism limited" warning.
- **Engines must earn their place.** The similarity engine is gated on out-of-sample skill; the
  ablation study measures each engine's increment on sessions no arm has searched.

## Modules (backend/alpha_genesis)

`config` · `db` · `mcal` (calendar) · `market` · `synthetic` · `quality` · `providers` · `features` ·
`liedetector` · `doppelganger` · `stats` · `dsl` · `backtest` · `models` · `registry` · `core` ·
`darwin` · `skeptic` · `arena` · `guardian` · `broker` · `paper` · `learning` · `jobs` · `runtime` ·
`api` · `cli` — about 5,100 lines, plus 1,500 lines of tests and 870 lines of TypeScript.

Deliberate departures from the preferred stack: pandas/NumPy instead of Polars (dense 3-D arrays made
vectorised features and leakage tests simpler), no DuckDB (SQLite covers the query load), a small
purpose-built trial store instead of MLflow, brute-force similarity instead of a vector index (the
library is tens of thousands of rows).
