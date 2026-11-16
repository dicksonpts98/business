"""Risk Guardian: every limit, the kill switch, authorisation, reconciliation and the audit log."""
import dataclasses, json, sqlite3
from datetime import date, timedelta
import pytest
from alpha_genesis import mcal, registry
from alpha_genesis.broker import PaperBroker
from alpha_genesis.config import Config, Frozen
from alpha_genesis.guardian import LiveTradingForbidden, RiskGuardian


def req(rt, **kw):
    ctx = rt.ctx
    day = ctx.market.days[-1]
    dep = registry.active_deployment(ctx.db)
    now = mcal.bar_open_utc(day, 30)
    r = {"strategy_id": dep["strategy_id"], "artifact_sha": dep["sha"], "symbol": "SPY", "side": 1, "qty": 5, "entry_px": 450.0, "stop_px": 449.0,
         "fx": 1.36, "fx_asof": day, "day": day, "now": now, "data_ts": now, "client_id": "t-" + str(len(kw)) + "-" + str(sorted(kw)), "broker_is_paper": True}
    r.update(kw)
    return r


def state(**kw):
    s = {"equity": 10000.0, "day_pnl": 0.0, "entries_today": 0, "positions": []}
    s.update(kw)
    return s


def test_clean_order_is_approved_and_audited(world):
    g = world.engine.guardian
    ok, why, qty = g.check_entry(req(world), state())
    assert ok and qty == 5
    last = world.ctx.db.one("SELECT * FROM audit_log ORDER BY id DESC LIMIT 1")
    assert last["action"] == "risk.approve" and json.loads(last["detail"])["planned_risk_cad"] == pytest.approx(5 * 1.0 * 1.36)


def test_oversized_order_is_cut_to_the_cad_risk_budget(world):
    g = world.engine.guardian
    ok, _, qty = g.check_entry(req(world, qty=100000, stop_px=440.0), state())
    L = world.cfg.risk
    assert ok and qty * 10.0 * 1.36 <= L.risk_per_trade_cad and qty == int(L.risk_per_trade_cad / (10.0 * 1.36)) == 3
    assert world.ctx.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='risk.resize'")["n"] == 1
    assert qty * 450 * 1.36 <= L.max_instrument_exposure_x * 10000


def test_exposure_and_leverage_ceilings(world):
    g = world.engine.guardian
    ok, _, qty = g.check_entry(req(world, qty=1000, stop_px=449.99), state())       # tiny stop => risk sizing would be huge
    assert ok and qty * 450 * 1.36 <= world.cfg.risk.max_instrument_exposure_x * 10000
    held = [{"symbol": "QQQ", "notional_cad": 19900.0}]
    ok, why, _ = g.check_entry(req(world, qty=1000, stop_px=449.99), state(positions=held))
    assert not ok and "no size available" in why


@pytest.mark.parametrize("patch,st,expect", [
    ({}, {"day_pnl": -200.0}, "daily loss"),
    ({}, {"entries_today": 20}, "daily entry limit"),
    ({}, {"positions": [{"symbol": s, "notional_cad": 100.0} for s in "ABCD"]}, "maximum simultaneous"),
    ({}, {"positions": [{"symbol": "SPY", "notional_cad": 100.0}]}, "already open"),
    ({"broker_is_paper": False}, {}, "not a paper broker"),
    ({"artifact_sha": "deadbeef"}, {}, "unauthorised"),
    ({"strategy_id": "DRW-9999-v1"}, {}, "unauthorised"),
    ({"fx": None}, {}, "USD/CAD"),
    ({"stop_px": 450.0}, {}, "stop distance"),
])
def test_rejections(world, patch, st, expect):
    ok, why, qty = world.engine.guardian.check_entry(req(world, **patch), state(**st))
    assert not ok and qty == 0 and expect in why
    assert world.ctx.db.one("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1")["action"] == "risk.reject"


def test_stale_feed_stale_fx_and_session_checks(world):
    g, day = world.engine.guardian, world.ctx.market.days[-1]
    now = mcal.bar_open_utc(day, 30)
    assert "stale market data" in g.check_entry(req(world, data_ts=now - timedelta(minutes=11)), state())[1]
    assert g.check_entry(req(world, data_ts=now - timedelta(minutes=9)), state())[0]
    assert "USD/CAD" in g.check_entry(req(world, fx_asof=day - timedelta(days=5)), state())[1]
    assert "session closed" in g.check_entry(req(world, now=mcal.bar_open_utc(day, 0) - timedelta(minutes=5)), state())[1]
    assert "session closed" in g.check_entry(req(world, now=mcal.bar_open_utc(day, 78)), state())[1]
    assert "final 30 minutes" in g.check_entry(req(world, now=mcal.bar_open_utc(day, 73), data_ts=mcal.bar_open_utc(day, 73)), state())[1]
    hol = date(2025, 12, 25)
    assert "session closed" in g.check_entry(req(world, day=hol, now=mcal.bar_open_utc(hol, 10), fx_asof=hol), state())[1]


def test_duplicate_order_rejected(world):
    g = world.engine.guardian
    r = req(world, client_id="dup-1")
    assert g.check_entry(r, state())[0]
    world.engine.broker.submit("dup-1", r["strategy_id"], "SPY", 1, 5, "entry", "2025-01-01T00:00:00+00:00", {})
    ok, why, _ = g.check_entry(r, state())
    assert not ok and "duplicate" in why
    again = world.engine.broker.submit("dup-1", r["strategy_id"], "SPY", 1, 999, "entry", "2025-01-01T00:00:00+00:00", {})
    assert again["qty"] == 5 and world.ctx.db.one("SELECT COUNT(*) n FROM orders WHERE client_id='dup-1'")["n"] == 1


def test_kill_switch_blocks_everything_until_released(world):
    g = world.engine.guardian
    g.kill(True, "operator", "test")
    ok, why, _ = g.check_entry(req(world), state())
    assert not ok and "kill switch" in why
    assert world.ctx.db.one("SELECT COUNT(*) n FROM alerts WHERE level='critical' AND source='guardian'")["n"] == 1
    g.kill(False, "operator", "test over")
    assert g.check_entry(req(world, client_id="after-kill"), state())[0]
    acts = [r["action"] for r in world.ctx.db.q("SELECT action FROM audit_log WHERE action LIKE 'risk.kill%' ORDER BY id")]
    assert acts == ["risk.kill_switch_on", "risk.kill_switch_off"]


def test_no_order_without_a_deployment(world):
    registry.rollback(world.ctx.db, world.cfg, "test: remove champion")
    assert registry.champion(world.ctx.db) is None
    r = req.__wrapped__(world) if hasattr(req, "__wrapped__") else None
    day = world.ctx.market.days[-1]
    now = mcal.bar_open_utc(day, 30)
    ok, why, _ = world.engine.guardian.check_entry(
        {"strategy_id": "DRW-0001-v1", "artifact_sha": "x", "symbol": "SPY", "side": 1, "qty": 1, "entry_px": 450.0, "stop_px": 449.0, "fx": 1.36,
         "fx_asof": day, "day": day, "now": now, "data_ts": now, "client_id": "nodep", "broker_is_paper": True}, state())
    assert not ok and "unauthorised" in why


def test_position_discrepancy_halts_new_entries(world):
    g = world.engine.guardian
    assert g.reconcile({"SPY": 10}, {"SPY": 10}) == []
    diffs = g.reconcile({"SPY": 10}, {"SPY": 7, "TSLA": -3})
    assert {d["symbol"] for d in diffs} == {"SPY", "TSLA"}
    ok, why, _ = g.check_entry(req(world), state())
    assert not ok and "reconciliation halt" in why
    g.clear_reconciliation_halt("operator")
    assert g.check_entry(req(world, client_id="after-halt"), state())[0]


def test_limits_are_immutable_and_engines_have_no_setter(world):
    L = world.cfg.risk
    with pytest.raises(dataclasses.FrozenInstanceError):
        L.max_daily_loss_cad = 1e9
    with pytest.raises(dataclasses.FrozenInstanceError):
        L._d = {}
    import alpha_genesis.darwin as darwin, alpha_genesis.learning as learning, alpha_genesis.arena as arena
    for mod in (darwin, learning, arena):
        src = open(mod.__file__).read()
        assert "risk.toml" not in src and "kill(" not in src and "_d[" not in src
    assert not [n for n in dir(RiskGuardian) if n.startswith("set_") or "update_limit" in n]
    assert L.starting_capital_cad == 10000 and L.risk_per_trade_cad == 50 and L.max_daily_loss_cad == 200 and L.max_entries_per_day == 20


def test_live_trading_configuration_is_refused(world, tmp_path):
    cfg = Config(data_dir=tmp_path)
    cfg.risk = Frozen({**cfg.risk.as_dict(), "paper_only": False})
    with pytest.raises(LiveTradingForbidden):
        RiskGuardian(cfg, world.ctx.db)


def test_audit_log_is_append_only_and_tamper_evident(world):
    db = world.ctx.db
    ok, n = db.verify_audit()
    assert ok and n > 10
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        db.x("UPDATE audit_log SET actor='x' WHERE id=1")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        db.x("DELETE FROM audit_log WHERE id=1")
    with pytest.raises(sqlite3.DatabaseError, match="append-only"):
        db.x("DELETE FROM promotions")
    raw = sqlite3.connect(db.path)                # an attacker with file access who drops the trigger is still caught by the chain
    raw.execute("DROP TRIGGER audit_no_update")
    raw.execute("UPDATE audit_log SET detail='{\"forged\": true}' WHERE id=3")
    raw.commit(); raw.close()
    assert db.verify_audit() == (False, 2)
