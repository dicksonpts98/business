"""Leakage prevention: nothing computed for time t may change when data after t changes."""
import numpy as np
import pytest
from alpha_genesis import liedetector, models, skeptic
from alpha_genesis.core import HoldoutAccessError, ResearchView
from alpha_genesis.doppelganger import Doppelganger, GRID
from alpha_genesis.dsl import Cond, Exit, StrategySpec, Trigger, signals
from alpha_genesis.features import FeatureStore, compute, forward_labels, REGISTRY
from alpha_genesis.market import FIELDS
from alpha_genesis.synthetic import generate

SYMS = ["SPY", "QQQ", "NVDA", "TSLA"]


@pytest.fixture(scope="module")
def mk():
    return generate(SYMS, 130, seed=5)


def scramble_future(m, d, b, seed=0):
    """Copy of m with everything after (session d, bar b) replaced by different prices."""
    rng = np.random.default_rng(seed)
    t = m.truncated(m.D)
    for f in FIELDS:
        a = getattr(t, f)
        a[:, d, b + 1:] *= rng.uniform(0.8, 1.2, a[:, d, b + 1:].shape)
        a[:, d + 1:] *= rng.uniform(0.8, 1.2, a[:, d + 1:].shape)
    for arr in (t.h, t.l):          # keep bars internally consistent
        pass
    t.h = np.maximum.reduce([t.o, t.h, t.l, t.c])
    t.l = np.minimum.reduce([t.o, t.l, t.c])
    return t


def test_future_changes_do_not_alter_earlier_features(mk):
    d, b = 100, 37
    f0, f1 = compute(mk, "SPY"), compute(scramble_future(mk, d, b), "SPY")
    for k in f0:
        a0 = np.concatenate([f0[k][:, :d].ravel(), f0[k][:, d, :b + 1].ravel()])
        a1 = np.concatenate([f1[k][:, :d].ravel(), f1[k][:, d, :b + 1].ravel()])
        assert np.allclose(a0, a1, equal_nan=True, atol=1e-9), f"feature {k} read the future"
    assert not np.allclose(f0["ret_3_z"][:, d, b + 3:], f1["ret_3_z"][:, d, b + 3:], equal_nan=True)   # the scramble did bite


def test_incremental_features_equal_batch_features(mk):
    part = FeatureStore(mk.truncated(110), "SPY")
    part.extend(mk.truncated(120))
    part.extend(mk)
    full = FeatureStore(mk, "SPY")
    for k in full.f:
        assert np.allclose(part[k], full[k], equal_nan=True, atol=1e-7), k


def test_events_are_identical_when_the_future_is_rewritten(mk):
    d, b = 100, 37
    def events(m):
        fs = FeatureStore(m, "SPY")
        return {(e["symbol"], e["d"], e["bar"], e["pattern"], e["direction"]) for e in liedetector.detect(m, fs) if (e["d"], e["bar"]) <= (d, b)}
    e0, e1 = events(mk), events(scramble_future(mk, d, b))
    assert e0 == e1 and len(e0) > 500


def test_event_timestamp_is_the_confirming_bar_close(mk):
    fs = FeatureStore(mk, "SPY")
    for e in liedetector.detect(mk, fs)[:300]:
        assert e["ts"] == mk.ts(e["d"], e["bar"])
        s = mk.sidx(e["symbol"])
        if e["pattern"] == "ORB_FAIL_UP":      # the confirming close is back inside the range it had broken
            assert mk.c[s, e["d"], e["bar"]] < e["level"] and e["invalidation"] >= e["level"]


def test_similarity_predictions_ignore_the_future(mk):
    fs = FeatureStore(mk, "SPY")
    a = Doppelganger(mk, fs)
    d = 110
    t = scramble_future(mk, d, 77, seed=3)
    b = Doppelganger(t, FeatureStore(t, "SPY"))
    for meth in a.pred:
        assert np.allclose(a.pred[meth][:, :d + 1], b.pred[meth][:, :d + 1], equal_nan=True, atol=1e-6), meth
        assert np.isfinite(a.pred[meth][:, d][:, GRID]).any()


def test_similarity_scaler_and_library_use_only_earlier_sessions(mk):
    fs = FeatureStore(mk, "SPY")
    dg = Doppelganger(mk, fs)
    q = dg.query(mk, fs, 0, 120, 40)
    assert q["available"] and all(mt["d"] < 120 for mt in q["matches"])
    assert len({mt["d"] for mt in q["matches"]}) == len(q["matches"])      # at most one match per historical session
    assert dg.query(mk, fs, 0, 30, 40)["available"] is False              # not enough history: says so instead of guessing


def test_labels_never_cross_a_session_boundary(mk):
    fwd, mae = forward_labels(mk, 12)
    assert np.isnan(fwd[:, :, 78 - 12:]).all()
    s, d, b = 1, 50, 20
    assert fwd[s, d, b] == pytest.approx(np.log(mk.c[s, d, b + 12] / mk.o[s, d, b + 1]))
    assert (mae[np.isfinite(mae)] <= fwd[np.isfinite(mae)] + 1e-12).all()


def test_signals_identical_after_truncation_and_missing_values_never_pass(mk):
    fs = FeatureStore(mk, "SPY")
    liedetector.detect(mk, fs)
    spec = StrategySpec(family="feature", trigger=Trigger(kind="feature", feat="vwap_z", thr=1.5, invert=True), filters=[Cond(feat="rel_vol", op=">", thr=1.0)])
    sg = signals(spec, fs)
    assert (sg[np.isnan(fs["rel_vol"])] == 0).all()                       # NaN filter value => no signal
    t = mk.truncated(90)
    fs2 = FeatureStore(t, "SPY")
    liedetector.detect(t, fs2)
    assert (signals(spec, fs2) == sg[:, :90]).all()


def test_research_view_blocks_holdout_and_forward(ro):
    view, ep = ResearchView(ro.ctx), ro.ctx.epoch
    spec = StrategySpec(family="event", trigger=Trigger(kind="event", patterns=["ORB_FAIL_UP"]))
    assert view.run(spec, "dev").d1 == ep.dev_end and view.run(spec, "val").d1 == ep.val_end
    with pytest.raises(HoldoutAccessError):
        view.run(spec, "holdout")
    with pytest.raises(HoldoutAccessError):
        view.run(spec, "val", d1=ep.val_end + 1)
    assert ro.ctx.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='holdout.access_denied'")["n"] >= 2


def test_partitions_are_chronological_and_disjoint(ro):
    ep = ro.ctx.epoch
    assert 0 < ep.dev_start < ep.dev_end < ep.val_end < ep.holdout_end <= ro.ctx.market.D


def test_model_cannot_trade_inside_its_training_window(ro):
    ctx = ro.ctx
    mid = ctx.db.one("SELECT id, train_end FROM models ORDER BY created LIMIT 1")
    spec = StrategySpec(family="ml", trigger=Trigger(kind="model", model_id=mid["id"], thr=0.01))
    sg = ctx.signals(spec)
    assert (sg[:, :mid["train_end"]] == 0).all() and (sg[:, mid["train_end"]:] != 0).any()
    assert ctx.backtest(spec, 0, mid["train_end"]).trades == []


def test_model_training_uses_only_sessions_before_train_end(ro):
    import json
    for r in ro.ctx.db.q("SELECT * FROM models"):
        assert json.loads(r["metrics"])["train_sessions"] == [0, r["train_end"]]
        assert r["train_end"] <= ro.ctx.db.one("SELECT dev_end FROM epochs WHERE id=?", (r["epoch"],))["dev_end"]


def test_leak_probe_catches_a_lookahead_feature(world):
    """Plant a feature that peeks one bar ahead and confirm the Skeptic's truncation probe convicts it."""
    ctx = world.ctx
    honest = StrategySpec(family="feature", trigger=Trigger(kind="feature", feat="ret_3_z", thr=1.5))
    assert skeptic.leak_probe(ctx, honest)["mismatches"] == 0
    import alpha_genesis.features as F
    real = F.compute

    def leaky(m, proxy, d0=0):
        f = real(m, proxy, d0)
        nxt = np.concatenate([f["ret_3_z"][:, :, 1:], f["ret_3_z"][:, :, -1:]], axis=2)     # value from the NEXT bar
        f["ret_3_z"] = np.where(np.isfinite(nxt), nxt, f["ret_3_z"])
        return f
    F.compute = leaky
    try:
        res = skeptic.leak_probe(ctx, honest)
        assert res["mismatches"] > 0 and "ret_3_z" in res["leaking"]
    finally:
        F.compute = real


def test_registry_rejects_unknown_features_and_out_of_range_thresholds():
    with pytest.raises(Exception):
        Cond(feat="tomorrow_close", op=">", thr=0.0)
    with pytest.raises(Exception):
        Cond(feat="rel_vol", op=">", thr=99.0)
    assert all(not k.startswith("_") for k in REGISTRY)       # raw price levels are not thresholdable features
