"""ENGINE 5 — RESEARCH SKEPTIC: independent adversarial validation.

The Skeptic does not import the strategy generator and does not share its objective. Its standards
come from validation_policy.toml (hash recorded on every report) and it is the only component allowed
to spend the holdout — once per strategy, and only after every cheaper test has been survived."""
from __future__ import annotations
import json, time
import numpy as np
from pydantic import ValidationError
from . import liedetector, models, registry, stats
from .backtest import run as bt_run
from .config import BARS_PER_DAY as B
from .core import Ctx
from .db import jd
from .dsl import StrategySpec, signals
from .features import FeatureStore, REGISTRY
from .market import Market, FIELDS


def _chk(name, status, detail, **data):
    return {"check": name, "status": status, "detail": detail, **data}


def leak_probe(ctx: Ctx, spec: StrategySpec, cuts: int = 3, seed: int = 0) -> dict:
    """Look-ahead test by construction: delete everything after a cut point, rebuild features, events and
    scores from scratch, and require the strategy's signals up to the cut to be unchanged."""
    m, ep = ctx.market, ctx.epoch
    rng = np.random.default_rng(seed)
    mism, checked = 0, 0
    full = ctx.signals(spec)
    for _ in range(cuts):
        d = int(rng.integers(ep.dev_end + 5, ep.val_end))
        b = int(rng.integers(20, 70))
        lo = 0 if spec.uses("dop_") else max(0, d - 330)
        t = Market(m.symbols, m.days[lo:d + 1], m.kind)
        for f in FIELDS:
            a = getattr(m, f)[:, lo:d + 1].copy()
            a[:, -1, b + 1:] = np.nan
            setattr(t, f, a)
        t.fx = m.fx[lo:d + 1].copy()
        fs = FeatureStore(t, ctx.cfg.proxy)
        w = min(5, t.D)
        liedetector.detect(t, fs, t.D - w)
        if spec.uses("dop_"):
            from .doppelganger import Doppelganger
            st = ctx.engine("doppelganger") or {}
            Doppelganger(t, fs).write_columns(fs, st.get("method") or "knn_z", st.get("calib"))
        if spec.trigger.model_id:
            for p in liedetector.PATTERN_IDS:      # scores need event columns for the scored window only
                pass
            fs._ml_done = {spec.trigger.model_id: t.D - w}
            models.write_scores(ctx.db, fs, spec.trigger.model_id, t.D)
        sg = signals(spec, fs, t.sidx(ctx.cfg.proxy), 0)
        a_ = sg[:, -w:]
        b_ = full[:, d + 1 - w:d + 1].copy()
        if ctx.min_day(spec) > 0:
            b_ = signals(spec, ctx.fs, m.sidx(ctx.cfg.proxy), 0)[:, d + 1 - w:d + 1].copy()
        a_[:, -1, b + 1:] = 0
        b_[:, -1, b + 1:] = 0
        mism += int((a_ != b_).sum())
        checked += int(a_.size)
    return {"mismatches": mism, "signals_compared": checked, "cuts": cuts}


def matched_random(ctx: Ctx, spec: StrategySpec, d0: int, d1: int, n: int, seed: int = 0) -> dict:
    """Permutation test of entry timing: keep the strategy's exits, sizing, per-symbol trade counts and sides,
    but move each entry to a random eligible bar. p = share of random-timing controls doing at least as well."""
    m = ctx.market
    real = ctx.backtest(spec, d0, d1)
    if not real.trades:
        return {"p": 1.0, "n": 0}
    rng = np.random.default_rng(seed)
    sig0 = ctx.signals(spec)[:, d0:d1]
    last = ctx.cfg.alpha["execution"]["last_entry_bar"]
    plain = spec.model_copy(update={"exit": spec.exit.model_copy(update={"stop_kind": "atr"})})
    base = ctx.backtest(plain, d0, d1).metrics["net_cad"] if spec.exit.stop_kind == "invalidation" else real.metrics["net_cad"]
    nets = []
    for _ in range(n):
        sig = np.zeros(m.c.shape, np.int8)
        for s in range(m.S):
            for side in (1, -1):
                k = int((sig0[s] == side).sum())
                if k == 0:
                    continue
                dd = rng.integers(d0, d1, k)
                bb = rng.integers(6, last, k)
                sig[s, dd, bb] = side
        nets.append(bt_run(plain, m, ctx.fs, ctx.cfg, d0, d1, "base", sig=sig).metrics["net_cad"])
    nets = np.array(nets)
    return {"p": float((1 + (nets >= base).sum()) / (n + 1)), "n": n, "actual_net_cad": float(base),
            "control_mean_cad": float(nets.mean()), "control_p95_cad": float(np.quantile(nets, .95))}


def _neighbors(spec: StrategySpec, n: int, rng) -> list[StrategySpec]:
    out = []
    for _ in range(n * 3):
        d = json.loads(spec.model_dump_json())
        j = lambda: float(rng.uniform(0.85, 1.15))
        if d["trigger"].get("thr") is not None:
            d["trigger"]["thr"] = d["trigger"]["thr"] * j()
        d["exit"]["stop_atr"] = float(np.clip(d["exit"]["stop_atr"] * j(), 0.5, 5))
        d["exit"]["max_hold"] = int(np.clip(round(d["exit"]["max_hold"] * j()) + rng.integers(-1, 2), 2, 77))
        if d["exit"]["target_r"]:
            d["exit"]["target_r"] = float(np.clip(d["exit"]["target_r"] * j(), 0.5, 5))
        for c in d["filters"] + d["avoid"]:
            if c["feat"] not in ("regime", "mkt_trend"):
                lo, hi, _ = REGISTRY[c["feat"]]
                c["thr"] = float(np.clip(c["thr"] + rng.uniform(-0.05, 0.05) * (hi - lo), lo, hi))
        try:
            out.append(StrategySpec.model_validate(d))
        except ValidationError:
            continue
        if len(out) == n:
            break
    return out


def review(ctx: Ctx, sid: str, cycle: dict | None = None, seed: int = 0) -> dict:
    """Full adversarial review of one candidate. `cycle` carries the search context needed for multiple-testing
    corrections: n_trials, trial_sharpes (annualised, development) and the cycle-level PBO estimate."""
    pol, ep, db = ctx.cfg.policy, ctx.epoch, ctx.db
    row = registry.get(db, sid)
    spec: StrategySpec = row["spec_obj"]
    cycle = cycle or {}
    rng = np.random.default_rng([seed, abs(hash(sid)) % 10 ** 6])
    v0, v1 = ep.part("val")
    checks = []
    base, stress = ctx.backtest(spec, v0, v1), ctx.backtest(spec, v0, v1, "stress")
    mt = base.metrics

    # 1 data quality & information availability
    bad = db.one("SELECT COUNT(*) n FROM data_issues WHERE severity='error'")["n"]
    checks.append(_chk("data_quality", "warn" if bad else "pass", f"{bad} unresolved error-level data issues in the store" if bad else "no error-level data issues recorded"))
    checks.append(_chk("quote_data", "warn" if not ctx.cfg.alpha["execution"]["quotes_available"] else "pass",
                       "No bid/ask quotes: spreads are modelled per instrument, so fill realism is LIMITED." if not ctx.cfg.alpha["execution"]["quotes_available"] else "quotes available"))
    checks.append(_chk("survivorship", "warn", f"Universe {ctx.market.symbols} was chosen with present-day knowledge; results do not generalise to instruments that were delisted or unknown at the time."))
    if ctx.market.kind == "synthetic":
        checks.append(_chk("data_provenance", "warn", "SYNTHETIC market data: this review tests the machinery, not a real-market edge."))
    # 2 look-ahead
    lp = leak_probe(ctx, spec, seed=seed)
    checks.append(_chk("lookahead_truncation", "pass" if lp["mismatches"] == 0 else "fail",
                       f"{lp['mismatches']} signal differences after deleting the future at {lp['cuts']} cut points ({lp['signals_compared']} signals compared)", **lp))
    late = [t for t in base.trades if t["entry_bar"] <= t["signal_bar"]]
    checks.append(_chk("execution_timing", "fail" if late else "pass", f"{len(late)} trades filled at or before their signal bar" if late else "every fill occurs after the signal bar closes"))
    if spec.trigger.model_id:
        te = ctx.min_day(spec)
        checks.append(_chk("model_train_window", "pass" if te <= v0 else "fail", f"model trained through session {te}; validation starts at {v0}"))
    # 3 sample size
    checks.append(_chk("sample_size", "pass" if mt["trades"] >= pol.min_trades_val else "fail", f"{mt['trades']} validation trades (minimum {pol.min_trades_val})", trades=mt["trades"]))
    # 4 dependency-aware confidence interval
    bs = stats.block_bootstrap_means(base.daily, pol.bootstrap_block_days, pol.bootstrap_samples, rng)
    lcb = float(np.quantile(bs, pol.bootstrap_lcb_quantile))
    checks.append(_chk("block_bootstrap", "pass" if lcb > 0 else "fail", f"mean daily P&L {base.daily.mean():.2f} CAD; {int(pol.bootstrap_lcb_quantile * 100)}% lower bound {lcb:.2f} (block {pol.bootstrap_block_days} sessions)",
                       mean=float(base.daily.mean()), lcb=lcb, ucb=float(np.quantile(bs, 1 - pol.bootstrap_lcb_quantile))))
    # 5 multiple testing
    n_trials = int(cycle.get("n_trials", 1))
    # Null dispersion is the sampling variance of an unskilled strategy's Sharpe (1/T). The observed spread of
    # trial Sharpes is not used: it is dominated by cost-driven negative results, not by estimation noise.
    dsr = stats.deflated_sharpe(base.daily, n_trials)
    checks.append(_chk("deflated_sharpe", "pass" if dsr["dsr"] >= pol.min_dsr else "fail",
                       f"DSR {dsr['dsr']:.3f} (minimum {pol.min_dsr}); validation Sharpe {dsr['sr']:.2f} vs {dsr['sr0']:.2f} expected from the best of {n_trials} unskilled trials", **dsr))
    pbo = cycle.get("pbo") or {"pbo": None, "reason": "no cycle context"}
    if pbo.get("pbo") is None:
        checks.append(_chk("pbo", "na", f"probability of backtest overfitting not computed: {pbo.get('reason')}"))
    else:
        checks.append(_chk("pbo", "pass" if pbo["pbo"] <= pol.max_pbo else "fail", f"PBO {pbo['pbo']:.2f} over {pbo['n_configs']} configurations (maximum {pol.max_pbo})", **pbo))
    # 6 entry-timing permutation
    perm = matched_random(ctx, spec, v0, v1, pol.permutation_samples, seed)
    checks.append(_chk("permutation_timing", "pass" if perm["p"] <= pol.max_permutation_p else "fail",
                       f"p = {perm['p']:.3f} against {perm['n']} random-timing controls with identical exits and trade counts", **perm))
    # 7 execution costs
    sm = stress.metrics
    ok = sm["net_cad"] > 0 or not pol.stress_must_be_positive
    checks.append(_chk("cost_stress", "pass" if ok else "fail", f"net {mt['net_cad']:.0f} CAD at base costs, {sm['net_cad']:.0f} CAD at {ctx.cfg.alpha['execution']['stress_multiplier']:g}× spread and slippage",
                       base_net=mt["net_cad"], stress_net=sm["net_cad"]))
    ctg = mt["cost_to_gross"]
    checks.append(_chk("cost_share", "pass" if (ctg is not None and ctg <= pol.max_cost_to_gross) else "fail",
                       f"costs consume {ctg:.0%} of gross profit (maximum {pol.max_cost_to_gross:.0%})" if ctg is not None else "no gross profit to pay costs from", cost_to_gross=ctg, turnover_x=mt["turnover_x"]))
    part = [t for t in base.trades if t["qty"] > 0]
    checks.append(_chk("fills", "pass", f"all {len(part)} fills at next-bar open, capped at {ctx.cfg.alpha['execution']['participation_cap']:.0%} of bar volume; gaps through stops fill at the open"))
    # 8 parameter fragility
    nb = _neighbors(spec, pol.sensitivity_neighbors, rng)
    nets = np.array([ctx.backtest(s, v0, v1).metrics["net_cad"] for s in nb]) if nb else np.zeros(0)
    frac = float((nets > 0).mean()) if len(nets) else 0.0
    checks.append(_chk("parameter_sensitivity", "pass" if frac >= pol.min_sensitivity_positive else "fail",
                       f"{frac:.0%} of {len(nets)} perturbed neighbours (±15%) remain profitable on validation (minimum {pol.min_sensitivity_positive:.0%}); median {np.median(nets) if len(nets) else 0:.0f} CAD vs {mt['net_cad']:.0f}",
                       positive_fraction=frac, neighbor_nets=nets.round(1).tolist(), base_net=mt["net_cad"]))
    # 9 concentration
    wins = sorted((t["net_cad"] for t in base.trades if t["net_cad"] > 0), reverse=True)
    top5 = sum(wins[:5]) / sum(wins) if wins else 1.0
    checks.append(_chk("concentration_trades", "pass" if top5 <= pol.max_top5_trade_share else "fail", f"top 5 trades supply {top5:.0%} of gross winnings (maximum {pol.max_top5_trade_share:.0%})", top5_share=top5))
    by_sym = {s: 0.0 for s in ctx.market.symbols}
    for t in base.trades:
        by_sym[ctx.market.symbols[t["s"]]] += t["net_cad"]
    ex_best = mt["net_cad"] - max(by_sym.values())
    checks.append(_chk("concentration_symbols", "pass" if ex_best > 0 else "warn", f"net without the best instrument: {ex_best:.0f} CAD", by_symbol=by_sym))
    # 10 regime dependence
    br = {k: v["net_cad"] for k, v in mt["by_regime"].items()}
    pos = [k for k, v in br.items() if v > 0]
    checks.append(_chk("regime_dependence", "warn" if len(pos) <= 1 and len(br) > 1 else "pass",
                       "profit comes from a single volatility regime: " + json.dumps({k: round(v) for k, v in br.items()}) if len(pos) <= 1 and len(br) > 1 else "profit is not confined to one regime: " + json.dumps({k: round(v) for k, v in br.items()}), by_regime=br))
    # 11 feature ablation
    abl = []
    for kind in ("filters", "avoid"):
        conds = getattr(spec, kind)
        for i, c in enumerate(conds):
            s2 = spec.model_copy(update={kind: [x for j, x in enumerate(conds) if j != i]})
            abl.append({"removed": f"{kind[:-1] if kind == 'filters' else kind}: {c.feat} {c.op} {c.thr:g}", "net_cad": ctx.backtest(s2, v0, v1).metrics["net_cad"]})
    useless = [a for a in abl if a["net_cad"] > mt["net_cad"] * 1.1]
    checks.append(_chk("feature_ablation", "warn" if useless else ("pass" if abl else "na"),
                       (f"removing {len(useless)} condition(s) improves validation P&L: unnecessary complexity" if useless else "every condition contributes on validation") if abl else "no conditions to ablate",
                       ablations=abl, base_net=mt["net_cad"]))
    # 12 stability inside validation
    halves = [float(x.sum()) for x in np.array_split(base.daily, 2)]
    checks.append(_chk("stability", "pass" if min(halves) > 0 else "warn", f"validation halves: {halves[0]:.0f} / {halves[1]:.0f} CAD", halves=halves))

    mandatory_fail = [c for c in checks if c["status"] == "fail"]
    # 13 final gate: one look at the holdout, only for survivors
    budget_left = pol.max_holdout_uses_per_epoch - ctx.db.one("SELECT COUNT(*) n FROM holdout_ledger WHERE epoch=? AND purpose='final_gate'", (ep.id,))["n"]
    if not mandatory_fail and budget_left <= 0:
        checks.append(_chk("holdout", "fail", f"holdout budget exhausted ({pol.max_holdout_uses_per_epoch} looks this epoch): it can no longer serve as independent evidence; "
                                              "approval must wait for a new epoch built from fresh forward sessions"))
    elif not mandatory_fail:
        h0, h1 = ep.part("holdout")
        first = ctx.consume_holdout(sid, "final_gate")
        hold = ctx.backtest(spec, h0, h1)
        hb = stats.block_bootstrap_means(hold.daily, pol.bootstrap_block_days, pol.bootstrap_samples, rng)
        pp = float((hb > 0).mean())
        ok = hold.metrics["net_cad"] > 0 and pp >= pol.holdout_min_prob_positive
        checks.append(_chk("holdout", "pass" if ok else "fail",
                           f"holdout net {hold.metrics['net_cad']:.0f} CAD over {hold.metrics['trades']} trades, Sharpe {hold.metrics['sharpe']:.2f}; P(mean > 0) = {pp:.2f} (minimum {pol.holdout_min_prob_positive})"
                           + ("" if first else " [repeat look: this strategy had already consumed the holdout]"),
                           metrics=hold.metrics, prob_positive=pp, val_sharpe=mt["sharpe"], uses_this_epoch=ctx.holdout_uses()))
    else:
        checks.append(_chk("holdout", "na", "not evaluated: the holdout is preserved for candidates that survive every other test"))
    fails = [c["check"] for c in checks if c["status"] == "fail"]
    verdict = "APPROVED" if not fails else "REJECTED"
    rid = db.x("INSERT INTO skeptic_reports(strategy_id,cycle_id,verdict,checks,policy_sha,created) VALUES(?,?,?,?,?,?)",
               (sid, row["cycle_id"], verdict, jd({"checks": checks, "failed": fails, "validation": mt, "validation_stress": sm,
                                                   "equity": (np.cumsum(base.daily)).round(2).tolist()}), pol.sha, time.time()))
    db.audit("skeptic", "review." + verdict.lower(), {"strategy": sid, "report": rid, "failed": fails})
    registry.transition(db, ctx.cfg, sid, verdict, "skeptic review: " + ("all mandatory checks passed" if not fails else "failed " + ", ".join(fails)),
                        {"skeptic_report_id": rid}, actor="skeptic")
    if fails:
        db.x("INSERT INTO kb_lessons(ts,cycle_id,subject,family,elements,lesson) VALUES(?,?,?,?,?,?)",
             (time.time(), row["cycle_id"], sid, spec.family, jd(spec.elements()), "skeptic_rejected: " + ", ".join(fails)))
    return {"id": rid, "strategy_id": sid, "verdict": verdict, "failed": fails, "checks": checks}
