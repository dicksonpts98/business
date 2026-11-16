# Research report

## Status of the evidence

**No real market data was evaluated.** The build environment's network policy blocks every
market-data host that was tried (Stooq, Yahoo Finance, Alpaca) and no broker or data credentials were
available. The required "genuine out-of-sample backtests on real data" therefore **could not be done**
and are not reported here.

**Update (2026-11-16).** A live connection to the official Alpha Vantage MCP server now works, and
real data was fetched with a free key: 100 daily bars each for SPY, QQQ, NVDA and TSLA (2026-06-25 →
2026-11-13) and 100 USD/CAD rates. The free plan refuses 5-minute bars, which every engine here
requires, so there is still **no real-data evaluation of any strategy**. The only use made of the real
data is a plausibility check of the synthetic market's scale: real annualised close-to-close
volatility over those 100 sessions was 14% (SPY), 24% (QQQ), 41% (NVDA), 54% (TSLA) — the same order
as the generator's instruments. That says the synthetic volatilities are not absurd; it says nothing
about intraday structure or about any edge.

Everything below comes from a **synthetic** market produced by `alpha_genesis.synthetic` — a
regime-switching factor model for SPY/QQQ/NVDA/TSLA-like instruments. The names are labels; the
prices are generated. These experiments answer one question only: *does the research machinery behave
correctly when the truth is known?* They are a positive control (an effect was planted: can it be
found, and is its disappearance noticed?) and a null control (nothing planted: does the system
refuse to find anything?).

**No claim is made that any strategy here is profitable in real markets.** Dollar figures are paper
P&L on a CAD 10,000 simulated account and are reported so the mechanics can be checked, not as
performance.

Reproduce: `./scripts/demo_run.sh 196` (positive control) and
`python scripts/null_experiment.py <dir> 60` (null control). All figures were read from the stored
experiment database of those runs.

## Experiment 1 — positive control with a disappearing effect

**Setup.** 756 sessions of 5-minute bars (2023-01-03 → 2026-01-06, synthetic). Planted: after a
failed opening-range break, a reversal drift of 0.30 bar-σ per bar for 12 bars; and a weak pull toward
VWAP in the calm regime. **The planted reversal is switched off at session 660 (2025-08-20).** The
first 560 sessions were available to research; the last 196 arrived one at a time. Costs: USD
0.005/share (USD 1 minimum), modelled half-spreads of 0.5–2 bps, 1 bp slippage; 3× stress scenario.

### What the system did, unattended

| Phase | Record |
| --- | --- |
| Search | 10 research cycles, 3,542 strategies evaluated (all recorded), 140 hypotheses: 17 supported on validation, 63 rejected, 60 skipped as already rejected on unchanged data |
| Review | 30 candidates reached the Skeptic: 17 approved, 13 rejected — every rejection at the holdout gate |
| Epochs | 5 partitions locked (a new one each time 40 never-searched sessions accumulated); models retrained to v5; 26 holdout looks in total, never more than 5 per epoch |
| Paper trading | Started 2025-04-10 after the 10-session shadow period; 384 trades |
| Before the effect was removed | 237 trades, **+CAD 3,743**, mean +0.36 R; equity peaked at CAD 13,760 on 2025-08-20 |
| After the effect was removed | 147 trades, **−CAD 978**, mean −0.17 R |
| Reaction | Champions quarantined on 08-26, 09-19, 10-06, 10-22 and 11-10 (p between <0.0001 and 0.002); from 2025-11-11 the system **stopped trading** for the remaining 38 sessions. Research cycles 9 and 10 approved nothing. |
| Final | Equity CAD 12,765; no champion; no-trade benchmark ranked #1 in the Arena on the last 74 out-of-sample sessions |

Paper execution matched the research backtest to within CAD 0.00 on all 120 traded sessions that had
no risk intervention (two independent implementations).

### Findings

1. **The planted effect was found by the right engine.** The first approved strategy was a fade of
   failed opening-range breaks. Its review: validation Sharpe 6.4 against 4.3 expected from the best of
   356 unskilled trials (Deflated Sharpe 0.98), PBO 0.00, timing-permutation p = 0.005, profitable at 3×
   costs, 100% of perturbed neighbours profitable, holdout +CAD 4,660 over 206 trades. Numbers this
   clean are a property of a strong planted effect; nothing like them should be expected from real data.
2. **Darwin did not beat the simple benchmark.** On the epoch-1 holdout of this same market (measured
   in a development run), the untuned `BASE-FAILED-BREAKOUT` rule (fade four failed-break patterns,
   stop at invalidation) ranked first in the Arena, ahead of every evolved strategy. The search added conditions and tuned exits but found no
   structure the hand-written rule lacked. On this market, evolutionary search bought nothing over
   reading the hypothesis off the event statistics.
3. **Costs dominate at this account size.** Across champions, costs consumed 32–97% of gross paper
   profit (e.g. CAD 929 of 2,908 for the best, CAD 201 of 207 for the worst). With a weaker planted
   effect (0.15σ) the same strategy was profitable before costs and unprofitable at 3× costs. The
   commission minimum on CAD ~10,000 positions is roughly 4 bps round trip before any spread.
4. **Deterioration was detected, but slowly and expensively.** The first quarantine came 4 sessions
   after the effect was removed, but each rollback restored a predecessor that depended on the same
   dead effect, and each needed its own 20–40 paper trades before it too could be removed. The sequence
   took about 58 sessions and cost CAD 978. *Rollback to a predecessor is only safe when the predecessor
   fails independently of the strategy being removed.* A sensible change is to require a restored
   champion to re-pass a recent-window check before it trades.
5. **The holdout gate leaked for one epoch.** Epoch 4's holdout (2025-07-24 → 09-19) straddled the
   removal date, so two strategies were approved in cycles 7–8 on evidence that was half stale. Both
   were stopped by shadow/health checks, and epoch 5 (holdout entirely after removal) rejected
   everything. A holdout is only as current as its oldest session.
6. **An earlier version of the health test failed outright.** In the first full run the champion was
   never demoted after the effect vanished, because its poor recent trades were averaged with its good
   earlier ones. The fix (a most-recent-trades test alongside the full-record test) is what produced
   the behaviour above. This is recorded in the testing report as defect 6.
7. **Losing trades were mostly ordinary.** Of 154 attributed losing paper trades: 118 ordinary
   variance, 20 turned negative by costs, 10 gap/slippage beyond the planned 1R, 3 volatility
   expansion, 3 regime misclassification.

### Engine contribution (ablation)

Run at the end, on epoch 5's holdout (2025-09-22 → 11-17, 41 sessions, **after** the effect was
removed). Each arm searched with the same budget and seed, selected on validation, scored once.

| Arm | Selected | Net (CAD) | Trades |
| --- | --- | --- | --- |
| A Benchmarks only | no-trade | 0 | 0 |
| B + Doppelgänger | no-trade | 0 | 0 |
| C + Lie Detector | fade failed ORB (+ filter) | −701 | 108 |
| D + both | fade failed ORB (+ avoid rule) | −526 | 98 |
| E Full Darwin (+ ML + tuning) | fade failed ORB | −630 | 118 |
| F Full architecture | same as E | −630 | 118 |

| Increment | CAD/session | P(improvement) | Verdict |
| --- | --- | --- | --- |
| Lie Detector alone (C−A) | −17.1 | 0.01 | **harmful in this window** |
| Doppelgänger alone (B−A) | 0.0 | 0.50 | no measurable value |
| Doppelgänger given Lie Detector (D−C) | +4.3 | 0.79 | unproven |
| Darwin ML + tuning (E−D) | −2.5 | 0.26 | no measurable value |
| Adaptive regime selection (F−E) | 0.0 | 0.50 | no measurable value |

Read this carefully: every arm that traded did so on validation evidence from before the effect was
removed, and lost money afterwards. **On independent data, no component of the architecture added
value over not trading.** In the automated test suite, where the ablation runs while the effect is
still present, the Lie Detector arm does show a supported improvement (P ≥ 0.9); that confirms the
harness can detect a contribution when there is one. The honest summary is: the Lie Detector is the
only engine that ever demonstrably helped, and only while the effect it was built to see existed.
The ML models (internal AUC 0.51–0.55) and adaptive regime selection never showed measurable value,
and all five ML baselines ranked last in the Arena. On this evidence they are candidates for removal.

### Market Doppelgänger

| Method | Rank IC | 90% CI | Brier skill | Gate |
| --- | --- | --- | --- | --- |
| Learned metric | 0.045 | [0.029, 0.061] | +0.0003 | pass |
| Normalised features | 0.046 | [0.031, 0.062] | −0.0013 | fail |
| Regime-conditioned | 0.038 | [0.021, 0.055] | −0.0013 | fail |
| Return-path shape | 0.021 | [0.008, 0.033] | −0.0000 | fail |

Similarity retrieval carried a small, real rank signal here (it partially recovers the planted
structure), enough for one method to pass the gate. It was not enough to matter: the similarity
baseline lost money after costs, and the ablation shows no supported increment. More complex retrieval
did not beat plain normalised distance on rank IC.

## Experiment 2 — null control

Same generator, different seed, **nothing planted**; 560 sessions for research plus 60 forward.

| | Result |
| --- | --- |
| Research cycles | 4, with 1,419 strategies evaluated |
| Passed validation (FDR-controlled) | 0 |
| Reached the Skeptic / approved | 0 / 0 |
| Champion, paper orders | none, 0 |
| First-cycle PBO | 0.79 (the search itself was flagged as overfitting) |
| Doppelgänger | all four methods failed the gate (rank-IC intervals include or lie below zero); **engine disabled itself** |

The system concluded that no tradable advantage existed and did not trade.

## A methodological pitfall worth recording

During development the similarity engine showed a rank IC of 0.04–0.08 with tight confidence
intervals **on the null market**. No future data was leaking into features. The evaluation metric was
at fault: computing a rank correlation *within each session* de-means by that session's realised path,
and on any finite random walk "move so far" and "move still to come" are negatively related within the
sample. Raw trailing-return features showed within-session ICs of −0.15 to −0.26 against forward
returns on pure noise. Pooled IC with a session-cluster bootstrap removes the artefact (null IC ≈ 0,
intervals covering zero). Anyone evaluating intraday signals session by session should check their
metric against a random walk first.

## What would change these conclusions

Real data. The base expectation for intraday strategies on four liquid US instruments, after
commissions and spread on a CAD 10,000 account, is that nothing survives — and the cost findings
above suggest why. Supplying real 5-minute history regenerates every table in this report from stored
experiments; see OPERATIONS.md §3.
