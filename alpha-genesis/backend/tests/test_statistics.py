"""Statistical reliability: null experiments, multiple-testing behaviour, overfitting diagnostics,
out-of-sample deterioration, benchmark comparison and engine ablations."""
import json
import numpy as np
import pytest
from alpha_genesis import arena, learning, registry, skeptic, stats
from alpha_genesis.runtime import Runtime
from conftest import make_cfg


# ---------------------------------------------------------------- pure statistics
def test_block_bootstrap_interval_covers_the_true_mean():
    rng = np.random.default_rng(0)
    hits = 0
    for i in range(200):
        e = rng.normal(0, 1, 260)
        x = 0.1 + e + 0.5 * np.concatenate([[0], e[:-1]])           # autocorrelated daily P&L with true mean 0.1
        bs = stats.block_bootstrap_means(x, 5, 400, rng)
        hits += np.quantile(bs, 0.05) <= 0.1 <= np.quantile(bs, 0.95)
    assert 0.80 <= hits / 200 <= 0.97                                # nominal 90%


def test_deflated_sharpe_falls_as_the_number_of_trials_rises():
    rng = np.random.default_rng(1)
    x = rng.normal(0, 1.0, 250)
    x = (x - x.mean()) / x.std(ddof=1) + 0.12                        # exactly 0.12 daily Sharpe
    d = [stats.deflated_sharpe(x, n)["dsr"] for n in (1, 10, 100, 1000, 100000)]
    assert all(a > b for a, b in zip(d, d[1:])) and d[0] > 0.9 and d[-1] < 0.5
    assert stats.deflated_sharpe(rng.normal(0, 1, 250), 100)["dsr"] < 0.5
    assert stats.deflated_sharpe(np.zeros(250), 10)["dsr"] == 0.0


def test_best_of_many_noise_strategies_fails_dsr_but_would_pass_a_naive_test():
    rng = np.random.default_rng(2)
    M = rng.normal(0, 1, (250, 500))
    best = M[:, np.argmax(M.mean(0))]
    assert stats.t_pvalue_pos(best) < 0.05                           # looks "significant" in isolation
    assert stats.deflated_sharpe(best, 500)["dsr"] < 0.8             # not after accounting for the search


def test_pbo_separates_noise_from_a_real_edge():
    rng = np.random.default_rng(3)
    noise = rng.normal(0, 1, (400, 30))
    real = noise.copy()
    real[:, 7] += 0.35
    p_noise = np.mean([stats.pbo_cscv(np.random.default_rng(k).normal(0, 1, (400, 30)))["pbo"] for k in range(8)])
    p_real = stats.pbo_cscv(real)["pbo"]
    assert 0.3 < p_noise < 0.7 and p_real < 0.1                      # ~0.5 for pure noise, ~0 when one configuration is truly better
    assert stats.pbo_cscv(noise[:20])["pbo"] is None                 # declines when the sample is too small


def test_benjamini_hochberg_controls_false_discoveries():
    rng = np.random.default_rng(4)
    false = 0
    for _ in range(200):
        keep = stats.bh_fdr(rng.uniform(0, 1, 20).tolist(), 0.10)
        false += any(keep)
    assert false / 200 < 0.2
    assert stats.bh_fdr([0.001, 0.002, 0.8, 0.9], 0.10) == [True, True, False, False]


def test_psi_is_small_for_same_distribution_and_large_for_a_shift():
    rng = np.random.default_rng(5)
    a = rng.normal(0, 1, 5000)
    assert stats.psi(a, rng.normal(0, 1, 2000)) < 0.05 and stats.psi(a, rng.normal(1.0, 1.5, 2000)) > 0.25


# ---------------------------------------------------------------- null experiment
@pytest.fixture(scope="module")
def null_world(tmp_path_factory):
    """A market with NO planted effect: a random walk with regimes. Nothing should survive."""
    rt = Runtime(make_cfg(tmp_path_factory.mktemp("null"), plant=0.0, days=380, initial=330, seed=21), log=lambda *a: None)
    rt.summary = learning.run_cycle(rt.ctx, learning.start_cycle(rt.ctx, "null experiment"))
    return rt


def test_null_market_produces_no_approved_strategy(null_world):
    s, db = null_world.summary, null_world.ctx.db
    assert s["trials"] > 60 and s["approved"] == []
    assert db.one("SELECT COUNT(*) n FROM strategies WHERE status IN ('APPROVED','SHADOW','CHAMPION')")["n"] == 0
    assert "no tradable advantage" in s["conclusion"]
    null_world.advance(3)
    assert registry.champion(db) is None and db.one("SELECT COUNT(*) n FROM orders")["n"] == 0     # if nothing qualifies, do not trade


def test_null_market_disables_the_similarity_engine(null_world):
    st = null_world.ctx.engine("doppelganger")
    assert st["enabled"] is False and "disabled" in st["reason"]
    for meth, ev in st["evaluation"].items():
        assert ev["pass"] is False
        if "ic_ci90" in ev:
            assert ev["ic_ci90"][0] <= 0 or ev["brier_skill"] <= 0
    assert all(not json.loads(r["spec"])["trigger"].get("feat", "").startswith("dop_") for r in null_world.ctx.db.q("SELECT spec FROM trials")
               if json.loads(r["spec"])["trigger"].get("feat"))


def test_null_market_random_control_is_not_profitable(null_world):
    a = arena.run(null_world.ctx)
    rnd = next(c for c in a["competitors"] if c["id"].startswith("BASE-RANDOM"))
    assert rnd["oos"]["score"] < 0 and rnd["oos"]["prob_positive"] < 0.5


# ---------------------------------------------------------------- multiple testing sensitivity on a real candidate
def test_same_candidate_passes_or_fails_with_the_size_of_the_search(world):
    ctx, db = world.ctx, world.ctx.db
    champ = registry.champion(db)
    v0, v1 = ctx.epoch.part("val")
    daily = ctx.backtest(champ["spec_obj"], v0, v1).daily
    few, many = stats.deflated_sharpe(daily, 5)["dsr"], stats.deflated_sharpe(daily, 10 ** 9)["dsr"]
    assert few >= world.cfg.policy.min_dsr and few > many
    x = np.random.default_rng(0).normal(0, 1, 120)
    marginal = (x - x.mean()) / x.std(ddof=1) + 0.2                   # a decent-looking strategy: daily Sharpe 0.2 over 120 sessions
    assert stats.deflated_sharpe(marginal, 5)["dsr"] >= world.cfg.policy.min_dsr > stats.deflated_sharpe(marginal, 1000)["dsr"]


def test_skeptic_report_contains_every_mandated_analysis(ro):
    rep = ro.ctx.db.one("SELECT checks, policy_sha FROM skeptic_reports WHERE verdict='APPROVED' ORDER BY id LIMIT 1")
    checks = {c["check"]: c for c in json.loads(rep["checks"])["checks"]}
    need = {"lookahead_truncation", "execution_timing", "sample_size", "block_bootstrap", "deflated_sharpe", "pbo", "permutation_timing", "cost_stress",
            "cost_share", "parameter_sensitivity", "concentration_trades", "concentration_symbols", "regime_dependence", "feature_ablation", "stability",
            "holdout", "survivorship", "quote_data", "data_quality", "data_provenance"}
    assert need <= set(checks)
    assert checks["holdout"]["status"] == "pass" and checks["survivorship"]["status"] == "warn" and checks["data_provenance"]["status"] == "warn"
    ps = checks["parameter_sensitivity"]
    assert len(ps["neighbor_nets"]) >= 10 and len(set(ps["neighbor_nets"])) > 3 and ps["positive_fraction"] >= ro.cfg.policy.min_sensitivity_positive
    assert checks["permutation_timing"]["p"] <= 0.05 and checks["permutation_timing"]["n"] == ro.cfg.policy.permutation_samples
    assert checks["deflated_sharpe"]["n_trials"] >= 60
    assert rep["policy_sha"] == ro.cfg.policy.sha


def test_holdout_is_spent_once_per_strategy_and_budgeted(world):
    ctx, db = world.ctx, world.ctx.db
    led = db.q("SELECT * FROM holdout_ledger WHERE purpose='final_gate'")
    assert len(led) == len({l["subject"] for l in led}) >= 1
    assert ctx.consume_holdout(led[0]["subject"], "final_gate") is False        # a second look is recorded as a repeat, not a fresh use
    for i in range(world.cfg.policy.max_holdout_uses_per_epoch):
        ctx.consume_holdout(f"filler-{i}", "final_gate")
    champ = registry.champion(db)
    from alpha_genesis.dsl import Exit
    twin = champ["spec_obj"].model_copy(update={"exit": Exit(max_hold=champ["spec_obj"].exit.max_hold + 1, stop_kind=champ["spec_obj"].exit.stop_kind, stop_atr=champ["spec_obj"].exit.stop_atr)})
    sid = registry.register(db, twin, epoch=ctx.epoch.id)
    rep = skeptic.review(ctx, sid, {"n_trials": 60})
    hold = [c for c in rep["checks"] if c["check"] == "holdout"][0]
    assert rep["verdict"] == "REJECTED" and rep["failed"] == ["holdout"] and "budget exhausted" in hold["detail"]


# ---------------------------------------------------------------- out-of-sample deterioration
def test_champion_is_quarantined_when_its_edge_disappears(tmp_path):
    """The planted effect is switched off shortly after promotion. The system must notice from paper results
    alone, quarantine the champion on statistical evidence, and stop trading (no healthy predecessor)."""
    rt = Runtime(make_cfg(tmp_path, days=480, initial=330, decay=343), log=lambda *a: None)
    ctx, db = rt.ctx, rt.ctx.db
    assert learning.run_cycle(ctx, learning.start_cycle(ctx, "initial"))["approved"]
    rt.advance(rt.cfg.policy.min_shadow_days + 1)
    champ = registry.champion(db)
    assert champ is not None
    healthy_seen, q = False, None
    for i in range(130):
        out = rt.advance(1)[0]
        h = out["health"]
        if h and h["status"] == "healthy" and h["paper_trades"] > 0:
            healthy_seen = True
        if h and h["status"] == "quarantined":
            q = h
            break
        if registry.champion(db) is None or registry.champion(db)["id"] != champ["id"]:
            break
    assert healthy_seen, "the champion was never observed trading healthily before the decay"
    assert q is not None, "deterioration was not detected"
    assert q["paper_trades"] >= rt.cfg.policy.quarantine_min_trades and q["p_deteriorated"] < rt.cfg.policy.quarantine_p / 2 and q["recent_mean_r"] < 0
    assert registry.get(db, champ["id"])["status"] == "QUARANTINED"
    assert db.one("SELECT COUNT(*) n FROM alerts WHERE source='health' AND level='critical'")["n"] == 1
    nxt = registry.champion(db)
    after = rt.advance(1)[0]
    assert after["paper"]["strategy"] == (nxt["id"] if nxt else None) != champ["id"]


def test_a_few_losses_do_not_trigger_quarantine_or_retraining(world):
    db = world.ctx.db
    champ = registry.champion(db)["id"]
    for i in range(6):                                                       # six straight full-R losers
        db.x("""INSERT INTO paper_trades(strategy_id,symbol,side,qty,day,d,entry_ts,exit_ts,entry_px,exit_px,gross_cad,cost_cad,net_cad,r_multiple,exit_reason,regime)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (champ, "SPY", 1, 1, "x", world.ctx.market.D, "a", "b", 1, 1, -50, 2, -52, -1.04, "stop", 1))
    n_models = db.one("SELECT COUNT(*) n FROM models")["n"]
    h = learning.champion_health(world.ctx)
    assert h["status"] == "healthy" and "needs" in h["note"]
    assert registry.champion(db)["id"] == champ and db.one("SELECT COUNT(*) n FROM models")["n"] == n_models
    assert db.one("SELECT COUNT(*) n FROM cycles")["n"] == 1


# ---------------------------------------------------------------- benchmarks and ablations
def test_arena_ranks_on_risk_adjusted_out_of_sample_evidence(ro):
    a = arena.run(ro.ctx)
    ids = {c["id"]: c for c in a["competitors"]}
    for b in ("BASE-NO-TRADE-v1", "BASE-RANDOM-v1", "BASE-PASSIVE-v1", "BASE-MOMENTUM-ORB-v1", "BASE-MEANREV-VWAP-v1", "BASE-FAILED-BREAKOUT-v1", "BASE-SIMILARITY-v1"):
        assert b in ids and ids[b]["oos"] is not None
    assert any(k.startswith("BASE-ML-") for k in ids)
    ranked = sorted((c for c in a["competitors"] if c["oos"]), key=lambda c: c["rank"])
    assert [c["oos"]["score"] for c in ranked] == sorted((c["oos"]["score"] for c in ranked), reverse=True)
    nt = ids["BASE-NO-TRADE-v1"]
    assert nt["oos"]["score"] == 0 and nt["validation"]["metrics"]["trades"] == 0
    champ = ids[registry.champion(ro.ctx.db)["id"]]
    assert champ["rank"] < nt["rank"] and champ["oos"]["score"] > 0 and champ["oos"]["prob_positive"] >= 0.75
    by_net = max((c for c in a["competitors"] if c["oos"]), key=lambda c: c["oos"]["net_cad"])
    assert champ["oos"]["score"] <= champ["oos"]["mean_daily"]                # the score is a lower bound, not the raw mean
    # identical conditions: every competitor is evaluated on the same sessions
    assert len({c["oos"]["days"] for c in ranked}) == 1
    # rejected candidates are shown but never ranked on out-of-sample data they were denied
    assert all(c["oos"] is None for c in a["competitors"] if c["status"] == "REJECTED" and c["epoch"] == a["epoch"])
    n = len(a["h2h"]["ids"])
    assert len(a["h2h"]["p"]) == n and all(a["h2h"]["p"][i][i] is None for i in range(n))


def test_engine_ablation_measures_each_component_and_reports_negatives(world):
    r = learning.ablation(world.ctx, pop=24, gens=2)
    assert set(r["arms"]) == set("ABCDEF") and r["evaluated_on"] == "holdout" and r["data_kind"] == "synthetic"
    assert world.ctx.db.one("SELECT COUNT(*) n FROM holdout_ledger WHERE purpose='ablation'")["n"] == 1
    inc = r["increments"]
    assert len(inc) == 5 and len(r["recommendations"]) == 5
    # the planted effect lives in failed opening-range breaks: the Lie Detector arm must show it…
    assert inc["liedetector_alone (C−A)"]["prob_positive"] >= 0.9 and r["arms"]["C"]["net_cad"] > r["arms"]["A"]["net_cad"]
    assert "ORB_FAIL" in r["arms"]["C"]["selected"]
    # …and components without support must be called out rather than credited
    weak = [k for k, v in inc.items() if v["prob_positive"] < 0.9]
    assert weak and all(any(k in rec and "no measurable incremental value" in rec for rec in r["recommendations"]) for k in weak)
    assert world.ctx.db.one("SELECT COUNT(*) n FROM ablations")["n"] == 1
