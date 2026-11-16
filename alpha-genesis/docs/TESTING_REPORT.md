# Testing report

All market data used by the tests is synthetic and generated inside the test run.

## Commands and results

```bash
cd backend && python -m pytest tests -q -p no:cacheprovider
# 114 passed in 402.68s (0:06:42)        — last full run, Python 3.13, 4 cores

cd frontend && npm run build              # tsc --noEmit + vite build: clean
node scripts/smoke.cjs http://127.0.0.1:8000 docs/screenshots     # against the finished demo run
# ok × 10 screens (command, radar, twins, traps, darwin, arena, skeptic, paper, learning, settings);
# no console errors, no "NaN"/"undefined" text, ≥ 2 data panels each
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `test_data_integrity.py` | 15 | holidays, early closes, DST, naive/wrong time zones, missing and duplicate bars, impossible OHLCV, corrupted files, unadjusted splits and split adjustment, stale bars, 1→5-minute aggregation, CSV import round trip, missing symbol-sessions, checksum tampering, dataset versioning |
| `test_leakage.py` | 14 | rewriting the future leaves earlier features, events and similarity predictions unchanged; incremental = batch features; labels never cross a session; one similarity match per earlier session; research view cannot reach holdout/forward; a model cannot trade inside its training window; the Skeptic's probe convicts a deliberately planted one-bar look-ahead |
| `test_backtest.py` | 16 | deterministic replay, fills strictly after the signal, gap-through-stop fills, stop-before-target, trade-through targets, halts, cost identities, commission minimum, CAD risk and exposure sizing, short constraints, position/entry/daily-loss limits, missing FX, partial fills |
| `test_guardian.py` | 20 | every limit and rejection reason, oversize resizing, duplicates, stale feed/FX, session and final-30-minute checks, kill switch, unauthorised orders, reconciliation halt, immutable limits, refusal of a live configuration, append-only and tamper-evident audit log |
| `test_paper.py` | 7 | paper P&L equals the research backtest, explanations and loss post-mortems, broker rejection / disconnect / partial fill, crash mid-session then resume with identical results and no duplicate orders, daily-loss block, kill switch, no champion ⇒ no orders |
| `test_self_learning.py` | 17 | the self-learning proof (below), feed failure and partial feed handling, bounded job retries |
| `test_statistics.py` | 16 | bootstrap coverage, Deflated Sharpe vs number of trials, PBO on noise vs a real edge, FDR control, PSI, the null-market experiment, holdout budget, quarantine on edge decay, no over-reaction to a losing streak, Arena ranking rules, engine ablation |
| `test_integration.py` | 9 | the end-to-end pipeline, all API endpoints, dashboard numbers equal stored experiments, replay separation, operator controls and token, scheduler, CLI backup/restore, no secrets in config |

### Required self-learning proof → executable tests

| Requirement | Test |
| --- | --- |
| Train a first model | `test_first_models_are_trained_versioned_and_hashed` |
| Receive new completed observations; detect a reason to re-evaluate; generate and evaluate a versioned challenger; reject or promote by rule; preserve the previous champion | `test_new_observations_trigger_retraining_and_a_versioned_challenger` |
| Reject a challenger without contaminating anything | `test_rejected_challenger_is_isolated` |
| Roll back a faulty promotion | `test_faulty_promotion_is_rolled_back_to_the_preserved_champion`, `test_rollback_with_no_predecessor_falls_back_to_not_trading` |
| Prevent unauthorised promotion | `test_unauthorised_promotion_is_impossible`, `test_shadow_strategy_needs_forward_evidence_before_promotion` |
| Drift detection | `test_drift_detection_flags_a_shifted_distribution` |
| Interrupted training recovery | `test_interrupted_research_cycle_resumes_from_its_checkpoint`, `test_job_queue_survives_restart_and_retries_from_checkpoint` |
| Continue correctly after restart | `test_state_is_identical_after_restart_and_learning_continues`, `test_crash_mid_session_resumes_without_duplicates` |

### Required end-to-end test

`test_integration.py::test_end_to_end_pipeline` runs, on a fresh data directory: ingestion → pattern
detection → historical similarity → candidate generation → backtesting → independent validation →
tournament → promotion or rejection → 41 new sessions → new epoch and retraining (model v2) →
re-evaluation in a third research cycle, and checks the audit chain at the end.

## Defects the tests and monitors found (all fixed, relevant suites re-run)

| # | Defect | How it surfaced | Fix |
| --- | --- | --- | --- |
| 1 | **Evaluation bias**: a per-session rank IC showed "skill" for similarity retrieval on a pure random walk (ranking inside a session de-means by that session's realised path). | Null-market sanity run during development | Pooled IC with a session-cluster bootstrap; the pitfall is documented in code and in the research report |
| 2 | **Sizing look-ahead in the backtester**: account equity used for exposure caps included P&L of trades that had not yet closed. | Paper-vs-research discrepancy assertion in the end-to-end test | Equity now only includes trades closed before the decision time |
| 3 | **Weak look-ahead probe**: the Skeptic's probe missed a one-bar peek, because only the boundary bar reveals it and it used 3 cut points. | `test_leak_probe_catches_a_lookahead_feature` | 24 cut points; compares every input column the strategy reads, not just its signals |
| 4 | Session-boundary mismatch: the Guardian allowed an entry exactly 30 minutes before the close, the backtester did not. | Discrepancy monitor in a demo run | Guardian comparison made inclusive |
| 5 | Re-entry mismatch: the paper engine accepted a signal on the bar a position exited, the backtester skipped it. | Discrepancy monitor alerts in the full demo run | Backtester aligned with the paper engine |
| 6 | Champion health diluted a newly dead edge with older good trades (champion not demoted for ~75 sessions after the planted effect was switched off). | Reading the demo run's final Arena | Added a most-recent-trades test, Bonferroni-corrected with the full-record test |
| 7 | Deflated Sharpe used the dispersion of trial Sharpes, which cost-driven negative results inflated until nothing could pass. | First Skeptic run | Uses the null sampling variance 1/T |
| 8 | Model artifact paths stored as absolute paths (copies of a data directory shared one file; backups were not portable). | A tampering test corrupted a sibling fixture | Paths stored relative to the data directory |
| 9 | Labels existed on shortened sessions where the outcome window was incomplete. | `test_labels_never_cross_a_session_boundary` | Adverse-excursion label masked wherever the return label is missing |
| 10 | Unbounded holdout reuse across cycles; six near-identical candidates each took a holdout look. | Reading the first multi-cycle run | Holdout budget per epoch, one candidate per structure, three per cycle |
| 11 | `Infinity` (profit factor with no losers) broke JSON responses. | API smoke test | Strict JSON serialisation |

Defects 1, 2, 3 and 6 are the ones that matter most: each would have produced over-optimistic research.

## Not tested

- Docker image build and `docker compose up` (no Docker daemon in the build environment).
- `AlpacaProvider` and `AlpacaPaperBroker` against the real service (no credentials, host blocked).
- Windows/WSL2 and macOS (Linux only).
- Any real market data. Parquet import shares the CSV code path after file reading but only CSV has a
  round-trip test; Parquet reading is exercised by the store itself.
- Multi-day soak of the timer-driven schedule (the scheduler, queue, retry and recovery paths are unit
  tested; the full run was driven through the same pipeline function synchronously).
- Dashboard interactions beyond page load (the smoke check loads and screenshots; it does not click).
- Load, concurrency beyond one worker, and security hardening of the HTTP API.
