"""v3: fee models and cost decomposition, cost-aware selectivity, the two paper-trading modes, and the
Alpaca paper-account integration (against a simulated paper API)."""
import json, shutil
from datetime import date
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from alpha_genesis import arena, backtest as bt, fees, liedetector, registry
from alpha_genesis.api import create_app
from alpha_genesis.broker import AlpacaPaperBroker
from alpha_genesis.config import Frozen
from alpha_genesis.dsl import Cond, Exit, StrategySpec, Trigger
from alpha_genesis.features import FeatureStore, set_costs
from alpha_genesis.registry import PromotionError
from alpha_genesis.runtime import Runtime
from alpha_genesis.synthetic import generate
from conftest import make_cfg
from test_paper import busy_session

SYMS = ["SPY", "QQQ", "NVDA", "TSLA"]
RND = StrategySpec(family="baseline", trigger=Trigger(kind="random", rate=0.02, seed=9), exit=Exit(max_hold=10, stop_atr=1.5, target_r=1.5))


def test_alpaca_fee_model_is_commission_free_with_dated_regulatory_fees(tmp_path):
    cfg = make_cfg(tmp_path, execution={"fee_model": "alpaca"})
    buy = fees.fill_fee(cfg, +1, 100, 500.0, date(2024, 8, 1))
    sell = fees.fill_fee(cfg, -1, 100, 500.0, date(2024, 8, 1))
    assert buy["commission"] == sell["commission"] == 0.0
    assert buy["regulatory"] == pytest.approx(100 * 0.00004)                                    # CAT only on a buy
    assert sell["regulatory"] == pytest.approx(100 * 0.00004 + 50000 * 27.80 / 1e6 + 100 * 0.000166)
    assert fees.fill_fee(cfg, -1, 100, 500.0, date(2025, 6, 2))["regulatory"] == pytest.approx(100 * 0.00004 + 100 * 0.000166)   # SEC rate 0 from 2025-05-14
    assert fees.fill_fee(cfg, -1, 10 ** 6, 5.0, date(2025, 6, 2))["regulatory"] == pytest.approx(10 ** 6 * 0.00004 + 8.30)     # TAF cap
    assert fees.fill_fee(cfg, -1, 100, 500.0, date(2024, 8, 1), "frictionless")["total"] == 0.0
    assert fees.describe(cfg)["verified"] is False and "not checked" in fees.describe(cfg)["note"]
    legacy = make_cfg(tmp_path)
    assert fees.fill_fee(legacy, +1, 10, 500.0, date(2024, 8, 1)) == {"commission": 1.0, "regulatory": 0.0, "total": 1.0}
    assert fees.fill_fee(legacy, +1, 1000, 50.0, date(2024, 8, 1))["commission"] == 5.0


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    m = generate(SYMS, 90, seed=2)
    fs = FeatureStore(m, "SPY")
    liedetector.detect(m, fs)
    return m, fs, tmp_path_factory.mktemp("v3")


def test_costs_decompose_exactly_and_legacy_is_dearer(env):
    m, fs, d = env
    a = bt.run(RND, m, fs, make_cfg(d, execution={"fee_model": "alpaca"}), 30, 90)
    l = bt.run(RND, m, fs, make_cfg(d), 30, 90)
    for r in (a, l):
        for t in r.trades:
            assert t["commission_cad"] + t["regulatory_cad"] + t["spread_cad"] + t["slippage_cad"] == pytest.approx(t["cost_cad"], abs=1e-6)
        cb = r.metrics["cost_breakdown_cad"]
        assert sum(cb.values()) == pytest.approx(r.metrics["cost_cad"], abs=1e-4)
    assert a.metrics["cost_breakdown_cad"]["commission"] == 0.0 and a.metrics["cost_breakdown_cad"]["regulatory"] > 0
    assert l.metrics["cost_breakdown_cad"]["commission"] > 0 and l.metrics["cost_breakdown_cad"]["regulatory"] == 0.0
    assert a.metrics["net_cad"] > l.metrics["net_cad"]                      # same signals, cheaper schedule
    tgt = [t for t in a.trades if t["reason"] == "target"][0]              # a limit target pays spread and slippage on the entry only
    stp = [t for t in a.trades if t["reason"] == "stop" and t["qty"] == tgt["qty"] and t["s"] == tgt["s"]]
    assert all(tgt["spread_cad"] < 0.75 * s_["spread_cad"] * 1.5 for s_ in stp[:1])
    assert abs(a.metrics["fx_translation_cad"]) < abs(a.metrics["net_cad"]) + 50


def test_cost_ratio_feature_is_causal_and_filters_trades(env):
    m, _, d = env
    set_costs({})                                                         # isolate from any cost table left by another test's runtime
    fs = FeatureStore(m, "SPY")
    liedetector.detect(m, fs)
    cr = fs["cost_ratio"]
    assert np.nanmedian(cr[0]) < np.nanmedian(cr[2]) * 5 and (cr[np.isfinite(cr)] > 0).all()
    spy_cost, nvda_cost = np.nanmedian(cr[0] * fs["_rv78"][0]), np.nanmedian(cr[2] * fs["_rv78"][2])
    assert spy_cost == pytest.approx(nvda_cost)                             # default cost table: 3 bps for every symbol
    set_costs({"SPY": 3.0, "QQQ": 3.0, "NVDA": 9.0, "TSLA": 3.0})
    try:
        f2 = FeatureStore(m, "SPY")
        assert np.nanmedian(f2["cost_ratio"][2]) == pytest.approx(3 * np.nanmedian(cr[2]))
    finally:
        set_costs({})
    cfg = make_cfg(d)
    loose = bt.run(RND, m, fs, cfg, 30, 90)
    thr = round(float(np.nanmedian(cr[:, 30:90])), 3)                      # keep only the half of the bars where a move can best pay its costs
    tight = bt.run(RND.model_copy(update={"filters": [Cond(feat="cost_ratio", op="<", thr=thr)]}), m, fs, cfg, 30, 90)
    assert 0 < len(tight.trades) < len(loose.trades)
    for t in tight.trades:
        assert fs["cost_ratio"][t["s"], t["d"], t["signal_bar"]] < thr


def test_paper_equals_backtest_under_the_alpaca_fee_model(world_base, tmp_path):
    from test_paper import next_session
    dst = tmp_path / "w"
    shutil.copytree(world_base, dst)
    rt = Runtime(make_cfg(dst, execution={"fee_model": "alpaca"}), log=lambda *a: None)
    spec = registry.champion(rt.ctx.db)["spec_obj"]
    n = 0
    for _ in range(6):
        d = next_session(rt)
        eq0 = rt.engine.equity()
        out = rt.engine.run_session(d)
        assert out["pnl_cad"] == pytest.approx(float(rt.ctx.backtest(spec, d, d + 1, equity0=eq0).daily.sum()), abs=0.01)
        n += out["entries"]
    assert n >= 3 and rt.ctx.db.one("SELECT MAX(commission_usd) m FROM fills")["m"] < 0.5      # regulatory pennies, no commission


# ---------------------------------------------------------------- paper modes
def _experimental(rt):
    rt.cfg.risk = Frozen({**rt.cfg.risk.as_dict(), "paper_mode": "experimental"})
    rt.engine.guardian.limits = rt.cfg.risk
    return rt


def test_validated_mode_never_trades_a_shadow_strategy(world):
    registry.rollback(world.ctx.db, world.cfg, "test: remove champion")
    assert registry.by_status(world.ctx.db, "SHADOW") and registry.champion(world.ctx.db) is None
    arena.decide(world.ctx, arena.run(world.ctx))
    assert registry.experimental_deployment(world.ctx.db) is None
    with pytest.raises(PromotionError, match="not enabled"):
        registry.deploy_experimental(world.ctx.db, world.cfg, registry.by_status(world.ctx.db, "SHADOW")[0]["id"])
    out = world.advance(1)[0]
    assert out["paper"]["strategy"] is None and world.ctx.db.one("SELECT COUNT(*) n FROM orders WHERE client_id LIKE ?", (f"%{out['day']}%",))["n"] == 0


def test_experimental_mode_trades_an_approved_shadow_with_reduced_limits(world):
    db = world.ctx.db
    registry.rollback(db, world.cfg, "test: remove champion")
    _experimental(world)
    dec = arena.decide(world.ctx, arena.run(world.ctx))
    exp = registry.experimental_deployment(db)
    assert exp and {"strategy": exp["strategy_id"], "action": "EXPERIMENTAL"} in dec
    assert registry.get(db, exp["strategy_id"])["status"] == "SHADOW" and json.loads(exp["artifact"])["mode"] == "PAPER_EXPERIMENTAL"
    assert db.one("SELECT 1 FROM skeptic_reports WHERE strategy_id=? AND verdict='APPROVED'", (exp["strategy_id"],))
    L = world.cfg.risk
    n0 = db.one("SELECT COUNT(*) n FROM paper_trades")["n"]
    days = 0
    while db.one("SELECT COUNT(*) n FROM paper_trades")["n"] < n0 + 4 and days < 25:
        out = world.advance(1)[0]["paper"]
        assert out["mode"] in ("experimental", "no-trade") and out["entries"] <= L.experimental_max_entries_per_day
        days += 1
    new = db.q("SELECT explanation FROM paper_trades WHERE id > (SELECT MAX(id) - ? FROM paper_trades)", (db.one("SELECT COUNT(*) n FROM paper_trades")["n"] - n0,))
    assert len(new) >= 4
    for t in new:
        assert json.loads(t["explanation"])["sizing"]["planned_risk_cad"] <= L.risk_per_trade_cad * L.experimental_risk_fraction + 1e-6
    with pytest.raises(PromotionError, match="shadow period"):
        registry.deploy_experimental(db, world.cfg, db.one("SELECT id FROM strategies WHERE status='REJECTED' OR status='ROLLED_BACK' LIMIT 1")["id"])


def test_experimental_mode_does_nothing_without_an_approved_strategy(tmp_path):
    rt = _experimental(Runtime(make_cfg(tmp_path, plant=0.0, days=350, initial=330, seed=21), log=lambda *a: None))
    out = rt.advance(2)
    assert all(o["paper"]["strategy"] is None and o["paper"]["mode"] == "no-trade" for o in out)
    assert registry.experimental_deployment(rt.ctx.db) is None and rt.ctx.db.one("SELECT COUNT(*) n FROM orders")["n"] == 0


# ---------------------------------------------------------------- Alpaca paper account (simulated API)
class FakePaperApi:
    def __init__(self, auth=True):
        self.auth, self.orders, self.log = auth, {}, []

    def __call__(self, req):
        assert req.url.host == "paper-api.alpaca.markets"
        self.log.append((req.method, req.url.path))
        if not self.auth:
            return httpx.Response(401, json={"message": "unauthorized."})
        p = req.url.path
        if p.endswith("/account"):
            return httpx.Response(200, json={"status": "ACTIVE", "currency": "USD", "equity": "100000", "cash": "100000", "buying_power": "200000",
                                             "account_number": "PA-SECRET-NUMBER", "pattern_day_trader": False, "trading_blocked": False})
        if p.endswith("/positions"):
            return httpx.Response(200, json=[])
        if p.endswith("/orders") and req.method == "POST":
            b = json.loads(req.content)
            o = {"id": f"oid{len(self.orders)}", "client_order_id": b["client_order_id"], "status": "accepted", "symbol": b["symbol"], "side": b["side"],
                 "qty": b["qty"], "type": b["type"], "limit_price": b.get("limit_price"), "filled_qty": "0"}
            self.orders[o["id"]] = o
            return httpx.Response(200, json=o)
        if "by_client_order_id" in p:
            return httpx.Response(200, json=next(o for o in self.orders.values() if o["client_order_id"] == req.url.params["client_order_id"]))
        if p.endswith("/orders"):
            return httpx.Response(200, json=list(self.orders.values()))
        if req.method == "DELETE":
            self.orders[p.rsplit("/", 1)[1]]["status"] = "canceled"
            return httpx.Response(204)
        return httpx.Response(404)


def test_account_sync_and_confirmed_diagnostic_order(world):
    srv = FakePaperApi()
    world.alpaca_paper = AlpacaPaperBroker("k", "s", transport=httpx.MockTransport(srv))
    c = TestClient(create_app(world))
    b = c.get("/api/broker").json()
    assert b["reachable"] and b["account"]["status"] == "ACTIVE" and b["in_sync"] is True and b["paper_mode"] == "validated"
    assert "PA-SECRET-NUMBER" not in json.dumps(b) and b["endpoint"].startswith("https://paper-api.") and b["live_trading"] == "not implemented"
    assert c.post("/api/broker/diagnostic").status_code == 400 and not [x for x in srv.log if x[0] == "POST"]      # nothing is sent without confirmation
    r = c.post("/api/broker/diagnostic?confirm=PAPER-DIAGNOSTIC").json()
    assert r["ok"] and [s["step"] for s in r["steps"]] == ["account", "submit", "read_back", "cancel", "positions_unchanged"]
    sent = [o for o in srv.orders.values()]
    assert len(sent) == 1 and sent[0]["type"] == "limit" and sent[0]["limit_price"] == "1.00" and sent[0]["qty"] == "1" and sent[0]["status"] == "canceled"
    assert c.get("/api/broker").json()["last_diagnostic"]["ok"] is True
    assert world.ctx.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='broker.diagnostic'")["n"] == 1


def test_unreachable_or_unauthorised_paper_account_is_reported_plainly(world):
    world.alpaca_paper = AlpacaPaperBroker("k", "s", transport=httpx.MockTransport(FakePaperApi(auth=False)))
    c = TestClient(create_app(world))
    b = c.get("/api/broker").json()
    assert b["reachable"] is False and "credentials" in b["error"]
    r = c.post("/api/broker/diagnostic?confirm=PAPER-DIAGNOSTIC").json()
    assert r["ok"] is False and "refused" in r["error"]
    def down(req):
        raise httpx.ConnectError("blocked")
    world.alpaca_paper = AlpacaPaperBroker("k", "s", transport=httpx.MockTransport(down))
    assert TestClient(create_app(world)).get("/api/broker").json()["reachable"] is False
