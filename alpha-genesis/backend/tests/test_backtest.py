"""Strategy engine: deterministic replay, execution timing, costs, sizing and account limits."""
from datetime import date
import numpy as np
import pytest
from alpha_genesis import backtest as bt, liedetector
from alpha_genesis.backtest import simulate_exit
from alpha_genesis.dsl import Exit, StrategySpec, Trigger
from alpha_genesis.features import FeatureStore
from alpha_genesis.synthetic import generate
from conftest import make_cfg

SYMS = ["SPY", "QQQ", "NVDA", "TSLA"]
ORB = StrategySpec(family="event", trigger=Trigger(kind="event", patterns=["ORB_FAIL_UP", "ORB_FAIL_DOWN"]), exit=Exit(max_hold=12, stop_kind="invalidation"))
RND = StrategySpec(family="baseline", trigger=Trigger(kind="random", rate=0.02, seed=9), exit=Exit(max_hold=10, stop_atr=1.5, target_r=1.5))


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    m = generate(SYMS, 90, seed=2)
    fs = FeatureStore(m, "SPY")
    liedetector.detect(m, fs)
    return m, fs, make_cfg(tmp_path_factory.mktemp("bt"))


def run(env, spec=RND, scenario="base", **kw):
    m, fs, cfg = env
    return bt.run(spec, m, fs, cfg, 30, 90, scenario, **kw)


def test_deterministic_replay(env):
    a, b = run(env), run(env)
    assert a.trades == b.trades and np.array_equal(a.daily, b.daily) and len(a.trades) > 50


def test_fills_strictly_after_signal_at_next_open(env):
    m, _, cfg = env
    for t in run(env, ORB).trades + run(env).trades:
        assert t["entry_bar"] == t["signal_bar"] + 1
        raw = m.o[t["s"], t["d"], t["entry_bar"]]
        assert t["entry"] == pytest.approx(raw * (1 + t["side"] * bt.cost_frac(cfg, SYMS[t["s"]], "base")))
        assert t["exit_bar"] >= t["entry_bar"]


def test_no_entries_in_final_thirty_minutes(env):
    assert max(t["entry_bar"] for t in run(env).trades) <= env[2].alpha["execution"]["last_entry_bar"]


def test_stop_gap_fills_at_open_not_at_stop():
    o = np.full(78, 100.0); h = o + 0.2; l = o - 0.2; c = o.copy()
    o[11], h[11], l[11], c[11] = 97.0, 97.5, 96.5, 97.2          # gaps far below a 99 stop
    xb, px, why = simulate_exit(o, h, l, c, 10, +1, 99.0, None, 30, 0.0)
    assert (xb, px, why) == (11, 97.0, "stop_gap")


def test_bar_touching_stop_and_target_resolves_to_stop():
    o = np.full(78, 100.0); h = o + 0.2; l = o - 0.2; c = o.copy()
    h[12], l[12] = 103.0, 98.0
    assert simulate_exit(o, h, l, c, 10, +1, 99.0, 102.0, 30, 0.0)[2] == "stop"
    assert simulate_exit(o, h, l, c, 10, -1, 101.0, 98.5, 30, 0.0)[2] == "stop"


def test_target_requires_trade_through_and_time_exit():
    o = np.full(78, 100.0); h = o + 0.2; l = o - 0.2; c = o.copy()
    h[12] = 102.0                                                   # touches 102 exactly: not filled
    assert simulate_exit(o, h, l, c, 10, +1, 95.0, 102.0, 5, 0.0001) == (14, 100.0, "time")
    h[12] = 102.5
    assert simulate_exit(o, h, l, c, 10, +1, 95.0, 102.0, 5, 0.0001)[1:] == (102.0, "target")


def test_missing_bars_cannot_be_used_to_exit():
    o = np.full(78, 100.0); h = o + 0.2; l = o - 0.2; c = o.copy()
    for a in (o, h, l, c):
        a[11:15] = np.nan                                           # trading halt
    o[15], l[15], c[15], h[15] = 96.0, 95.5, 96.0, 96.2
    assert simulate_exit(o, h, l, c, 10, +1, 99.0, None, 3, 0.0) == (15, 96.0, "stop_gap")


def test_cost_accounting_identities(env):
    base, stress, free = run(env), run(env, scenario="stress"), run(env, scenario="frictionless")
    for t in base.trades:
        assert t["net_cad"] == pytest.approx(t["gross_cad"] - t["cost_cad"]) and t["cost_cad"] > 0
    assert base.metrics["net_cad"] == pytest.approx(base.daily.sum())
    assert free.metrics["cost_cad"] == pytest.approx(0.0)
    assert stress.metrics["cost_cad"] / max(stress.metrics["trades"], 1) > base.metrics["cost_cad"] / base.metrics["trades"]
    assert free.metrics["net_cad"] > base.metrics["net_cad"] > stress.metrics["net_cad"]


def test_commission_minimum_applies(env):
    m, _, cfg = env
    ex = cfg.alpha["execution"]
    t = run(env).trades[0]
    spread = abs(t["entry"] / m.o[t["s"], t["d"], t["entry_bar"]] - 1) * m.o[t["s"], t["d"], t["entry_bar"]] * t["qty"]
    assert t["cost_cad"] / m.fx[t["d"]] >= 2 * max(ex["commission_min_usd"], ex["commission_per_share_usd"] * t["qty"]) + spread - 1e-6


def test_position_sizing_respects_cad_risk_and_exposure(env):
    m, _, cfg = env
    L = cfg.risk
    for t in run(env).trades + run(env, ORB).trades:
        planned = t["qty"] * abs(m.o[t["s"], t["d"], t["entry_bar"]] - t["stop"]) * m.fx[t["d"]]
        assert planned <= L.risk_per_trade_cad + 1e-6
        assert t["notional_cad"] <= L.max_instrument_exposure_x * (L.starting_capital_cad + 5000)


def test_non_shortable_instrument_is_never_shorted(env):
    m, fs, cfg = env
    cfg.alpha["instruments"]["TSLA"]["shortable"] = False
    try:
        tr = bt.run(RND, m, fs, cfg, 30, 90).trades
        assert not any(t["s"] == SYMS.index("TSLA") and t["side"] < 0 for t in tr)
        assert any(t["s"] == SYMS.index("TSLA") and t["side"] > 0 for t in tr) and any(t["side"] < 0 for t in tr)
    finally:
        cfg.alpha["instruments"]["TSLA"]["shortable"] = True


def test_one_position_per_symbol_and_max_positions(env):
    m, _, cfg = env
    busy = {}
    tr = run(env).trades
    for t in tr:
        g0, g1 = t["d"] * 78 + t["entry_bar"], t["d"] * 78 + t["exit_bar"]
        assert busy.get(t["s"], -1) < g0
        busy[t["s"]] = g1
    for t in tr:
        g = t["d"] * 78 + t["entry_bar"]
        assert sum(1 for u in tr if u["d"] * 78 + u["entry_bar"] <= g <= u["d"] * 78 + u["exit_bar"]) <= cfg.risk.max_positions


def test_daily_entry_cap_and_daily_loss_stop(env):
    m, fs, _ = env
    spam = StrategySpec(family="baseline", trigger=Trigger(kind="random", rate=0.05, seed=1), exit=Exit(max_hold=2, stop_atr=0.5))
    cfg = make_cfg(env[2].data_dir)
    r = bt.run(spam, m, fs, cfg, 30, 90)
    per_day = np.bincount([t["d"] for t in r.trades])
    assert per_day.max() <= cfg.risk.max_entries_per_day
    for d in set(t["d"] for t in r.trades):                         # no entry once realised loss has hit the limit
        day = sorted((t for t in r.trades if t["d"] == d), key=lambda t: t["entry_bar"])
        for t in day:
            realised = sum(u["net_cad"] for u in day if u["exit_bar"] < t["entry_bar"])
            assert realised > -cfg.risk.max_daily_loss_cad


def test_no_fx_rate_means_no_trading(env):
    m, fs, cfg = env
    keep = m.fx.copy()
    m.fx[40:50] = np.nan
    try:
        assert not any(40 <= t["d"] < 50 for t in bt.run(RND, m, fs, cfg, 30, 90).trades)
    finally:
        m.fx[:] = keep


def test_partial_fill_by_participation_cap(env):
    m, fs, cfg = env
    keep = m.v.copy()
    m.v[:] = 100.0                                                  # 2% participation => at most 2 shares per order
    try:
        tr = bt.run(RND, m, fs, cfg, 30, 90).trades
        assert tr and max(t["qty"] for t in tr) <= 2
    finally:
        m.v[:] = keep


def test_signal_on_last_bar_is_never_filled(env):
    m, fs, cfg = env
    sig = np.zeros(m.c.shape, np.int8)
    sig[:, 30:90, 77] = 1
    assert bt.run(RND, m, fs, cfg, 30, 90, sig=sig).trades == []
