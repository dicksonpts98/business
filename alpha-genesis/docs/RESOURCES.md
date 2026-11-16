# Resource report

## Hardware

| | Minimum | Measured on the build machine (4 vCPU, 15 GB RAM) |
| --- | --- | --- |
| CPU | 2 cores | 4 cores; the worker is single-threaded apart from BLAS and LightGBM (2 threads) |
| Memory | 4 GB | ≈ 1.5 GB resident with 756 sessions × 4 instruments |
| Disk | 1 GB | data directory ≈ 150 MB after the full demo (bars, similarity cache, 10 models, database) |
| GPU | none | not used |

## Compute per operation (4 instruments, ~560–756 sessions of 5-minute bars)

| Operation | Time |
| --- | --- |
| First initialisation (generate, features, 14 detectors, similarity walk-forward, 2 models) | ≈ 60–80 s |
| Process start on existing data (rebuild features and events, load similarity cache) | ≈ 8–20 s |
| One backtest of one strategy over 2+ years | 20–50 ms |
| Post-session pipeline (ingest → paper trade → drift → health → Arena) | ≈ 2 s, growing with the number of Arena competitors |
| Research cycle (≈ 350 strategies, up to 3 Skeptic reviews with 200 permutation backtests each) | ≈ 1–2 min |
| Engine ablation study | ≈ 1–2 min |
| Full test suite | ≈ 7 min |
| Full 196-session demo with 10 research cycles and 4 retrainings | ≈ 25–35 min |

Scaling: feature and detection cost is linear in instruments × sessions. Similarity search is
quadratic in sessions (each new session is compared with all earlier ones); it is cached, so the
ongoing cost per session is small, but a from-scratch rebuild at 10 years of history would take
minutes and should be windowed. Beyond roughly 30 instruments the dense in-memory grid and the
pure-Python detector loop are the first things to rework.

## Optional provider costs (indicative — check current pricing; none are required)

| Need | Option | Note |
| --- | --- | --- |
| Offline research | built-in synthetic market, your own CSV/Parquet | free |
| US equity bars + paper broker | Alpaca | a free tier with IEX-only data has existed; consolidated (SIP) data is a paid subscription. Adapter unverified. |
| Research-grade history and quotes | Databento or similar | usage-based pricing; no adapter written — implement the 3-method `Provider` interface |
| USD/CAD | Bank of Canada daily rates (free) exported to `fx_usdcad.csv` | no automated fetcher written |

Running costs are otherwise electricity for one small always-on machine. No language model is used at
run time; the platform does not depend on Claude or any external AI service to keep learning.

## Ongoing maintenance

- **Each year:** check the exchange calendar (`mcal.py` is rule-based; ad-hoc closures and changes to
  early-close rules must be added by hand).
- **Each corporate action:** add splits/dividends to `corporate_actions.csv` unless the provider
  delivers adjusted data. Unadjusted splits are detected and quarantined, not fixed.
- **Weekly:** read the alerts, the recovery log and the data-issue list; take a backup.
- **When limits or validation thresholds change:** edit the TOML files deliberately and restart —
  hashes on later decisions will show the change.
- **Dependencies:** `requirements.txt` gives minimum versions; pin exact versions (or build the Docker
  image) for a reproducible deployment. Stored models are pickles: re-train after upgrading
  scikit-learn or LightGBM rather than loading old artifacts.
- **Database growth:** the audit log and trial table grow without bound (≈ 1 MB per 10 sessions with
  research). Archive old rows from a backup if that ever matters.
