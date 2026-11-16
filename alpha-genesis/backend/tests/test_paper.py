"""Paper execution: agreement with research, order lifecycle, failure injection, crash recovery."""
import numpy as np
import pytest
from alpha_genesis import registry
from alpha_genesis.paper import InjectedCrash, PaperEngine
from alpha_genesis.providers import ingest_session


def next_session(rt):
    """Ingest the next session's data and derived state WITHOUT running the paper engine."""
    from alpha_genesis import liedetector, models
    ctx = rt.ctx
    day = rt.provider.next_session(ctx.market.days[-1])
    ingest_session(ctx.market, rt.provider, day, ctx.db)
    ctx.fs.extend(ctx.market)
    liedetector.detect(ctx.market, ctx.fs, ctx.market.D - 1)
    ctx.dop.update(ctx.market, ctx.fs)
    for r in ctx.db.q("SELECT id FROM models"):
        models.write_scores(ctx.db, ctx.fs, r["id"], ctx.market.D)
    ctx._sig_cache.clear()
    return ctx.market.D - 1


def busy_session(rt, min_signals=3):
    spec = registry.champion(rt.ctx.db)["spec_obj"]
    for _ in range(30):
        d = next_session(rt)
        if (rt.ctx.signals(spec)[:, d, :70] != 0).sum() >= min_signals:
            return d
        rt.engine.run_session(d)
    raise AssertionError("no session with enough signals")


def test_paper_matches_research_backtest(world):
    ctx = world.ctx
    spec = registry.champion(ctx.db)["spec_obj"]
    tot_p = tot_b = 0.0
    for _ in range(8):
        d = next_session(world)
        eq0 = world.engine.equity()
        out = world.engine.run_session(d)
        bt = ctx.backtest(spec, d, d + 1, equity0=eq0)
        assert out["pnl_cad"] == pytest.approx(float(bt.daily.sum()), abs=0.01), out
        tot_p += out["pnl_cad"]; tot_b += float(bt.daily.sum())
    n = ctx.db.one("SELECT COUNT(*) n FROM paper_trades")["n"]
    assert n >= 5 and ctx.db.q("SELECT * FROM positions") == [] and world.engine.broker.positions() == {}
    assert world.engine.equity() == pytest.approx(world.cfg.risk.starting_capital_cad + ctx.db.one("SELECT SUM(net_cad) s FROM paper_trades")["s"])


def test_every_trade_is_explained_and_orders_are_paper_only(world):
    d = busy_session(world)
    world.engine.run_session(d)
    import json
    tr = world.ctx.db.q("SELECT * FROM paper_trades WHERE d=?", (d,))
    assert tr
    for t in tr:
        ex = json.loads(t["explanation"])
        assert ex["why"] and ex["sizing"]["planned_risk_cad"] <= world.cfg.risk.risk_per_trade_cad + 1e-6 and "not a guaranteed" in ex["sizing"]["caveat"]
        assert t["exit_ts"] > t["entry_ts"]
        if t["net_cad"] < 0:
            assert json.loads(t["attribution"])["primary"]
    assert world.engine.broker.is_paper
    assert all(o["status"] in ("FILLED", "PARTIAL_CANCELLED", "EXPIRED", "REJECTED") for o in world.ctx.db.q("SELECT status FROM orders"))


def test_broker_rejection_disconnect_and_partial_fill(world):
    d = busy_session(world, 3)
    world.engine.broker.inject = ["reject", "disconnect", "partial"]
    out = world.engine.run_session(d)
    db = world.ctx.db
    assert db.one("SELECT COUNT(*) n FROM orders WHERE status='REJECTED'")["n"] == 1
    assert db.one("SELECT COUNT(*) n FROM audit_log WHERE action='broker.disconnected'")["n"] == 1
    assert db.one("SELECT COUNT(*) n FROM alerts WHERE source='broker'")["n"] == 1
    part = db.q("SELECT * FROM orders WHERE status='PARTIAL_CANCELLED'")
    assert len(part) == 1 and 0 < part[0]["filled_qty"] < part[0]["qty"]
    t = db.one("SELECT * FROM paper_trades WHERE d=? AND symbol=?", (d, part[0]["symbol"]))
    assert t["qty"] == part[0]["filled_qty"]                          # the position is the filled size, not the requested size
    assert db.q("SELECT * FROM positions") == [] and world.engine.broker.positions() == {} and out["reconciliation"] == []


def test_crash_mid_session_resumes_without_duplicates(world, world_base, tmp_path):
    import shutil
    from alpha_genesis.runtime import Runtime
    from conftest import make_cfg
    twin_dir = tmp_path / "twin"
    shutil.copytree(world_base, twin_dir)
    twin = Runtime(make_cfg(twin_dir), log=lambda *a: None)
    d = busy_session(world, 3)
    assert busy_session(twin, 3) == d
    ref = twin.engine.run_session(d)                                  # uninterrupted reference run
    world.engine.crash_at = 30
    with pytest.raises(InjectedCrash):
        world.engine.run_session(d)
    assert world.ctx.db.get_meta("paper_progress") == {"day": world.ctx.market.days[d].isoformat(), "bar": 30, "done": False}
    world.ctx.market.save(world.ctx.bars_dir, world.ctx.db)
    world.ctx.save_dop()
    reborn = Runtime(make_cfg(world.cfg.data_dir), log=lambda *a: None)     # brand-new process state
    assert any("interrupted after bar 30" in n for n in reborn.recovery)
    out = reborn.engine.run_session(d)
    assert out["pnl_cad"] == pytest.approx(ref["pnl_cad"], abs=1e-6) and out["entries"] == ref["entries"]
    a = [(t["symbol"], t["qty"], round(t["net_cad"], 6)) for t in reborn.ctx.db.q("SELECT * FROM paper_trades WHERE d=? ORDER BY id", (d,))]
    b = [(t["symbol"], t["qty"], round(t["net_cad"], 6)) for t in twin.ctx.db.q("SELECT * FROM paper_trades WHERE d=? ORDER BY id", (d,))]
    assert a == b and len(a) >= 1
    ids = [o["client_id"] for o in reborn.ctx.db.q("SELECT client_id FROM orders")]
    assert len(ids) == len(set(ids))
    assert reborn.engine.run_session(d) == {"day": reborn.ctx.market.days[d].isoformat(), "skipped": "already processed"}


def test_daily_loss_limit_flattens_and_blocks(world):
    d = busy_session(world, 3)
    world.ctx.db.set_meta("paper_progress", {"day": world.ctx.market.days[d].isoformat(), "bar": -1, "done": False})
    world.ctx.db.set_meta("paper_day_state", {"realized": -250.0, "entries": 0, "rejects": 0, "interventions": 0})   # already past the limit
    out = world.engine.run_session(d)
    assert out["entries"] == 0 and out["rejects"] >= 3
    assert world.ctx.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='risk.reject' AND detail LIKE '%daily loss%'")["n"] >= 3


def test_kill_switch_stops_paper_trading_for_the_session(world):
    d = busy_session(world, 3)
    world.engine.guardian.kill(True, "operator", "test")
    out = world.engine.run_session(d)
    assert out["entries"] == 0 and out["pnl_cad"] == 0.0
    assert world.ctx.db.one("SELECT COUNT(*) n FROM paper_trades WHERE d=?", (d,))["n"] == 0


def test_no_champion_means_no_orders(world):
    registry.rollback(world.ctx.db, world.cfg, "test")
    before = world.ctx.db.one("SELECT COUNT(*) n FROM orders")["n"]
    d = next_session(world)
    out = world.engine.run_session(d)
    assert out["strategy"] is None and out["pnl_cad"] == 0.0
    assert world.ctx.db.one("SELECT COUNT(*) n FROM orders")["n"] == before
