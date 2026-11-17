"""LIVE experimental paper trading, end to end against simulated Alpaca data and paper APIs with a controlled
clock. These tests prove the software path (data -> signal -> risk approval -> paper order -> fill ->
reconciliation -> records); they say nothing about the real broker or about profitability."""
import json
from datetime import datetime, timedelta, timezone
import httpx
import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient
from alpha_genesis import darwin, mcal
from alpha_genesis.alpaca import AlpacaClient
from alpha_genesis.api import create_app
from alpha_genesis.broker import AlpacaPaperBroker
from alpha_genesis.live import LiveExperimental

STRATS = [{"id": "T-ORB", "source": "test", "note": "", "spec": {"family": "baseline", "trigger": {"kind": "feature", "feat": "or_pos", "thr": 0.1}, "exit": {"max_hold": 6, "stop_kind": "atr", "stop_atr": 2.0}}},
          {"id": "T-FAIL", "source": "test", "note": "", "spec": {"family": "baseline", "trigger": {"kind": "event", "patterns": ["ORB_FAIL_UP", "ORB_FAIL_DOWN", "RANGE_REENTRY_UP", "RANGE_REENTRY_DOWN"]},
                                                                 "exit": {"max_hold": 6, "stop_kind": "invalidation"}}}]


class Sim:
    """One simulated trading day: Alpaca data API + Alpaca paper API sharing a clock."""
    def __init__(self, rt, sip_realtime=False):
        self.res = rt.provider.reserve
        self.day = rt.provider.next_session(rt.ctx.market.days[-1])
        self.d = self.res.didx(self.day)
        self.open, self.close = mcal.session(self.day)
        self.now = self.open
        self.sip_realtime, self.data_frozen_at, self.paper_down, self.foreign = sip_realtime, None, False, {}
        self.orders, self.pos, self.posts, self.hosts = {}, {}, [], set()

    def px(self, sym):
        b = int(np.clip((self.now - self.open).total_seconds() // 300 - 1, 0, 77))
        return float(self.res.c[self.res.sidx(sym), self.d, b])

    def data(self, req: httpx.Request):
        self.hosts.add(req.url.host)
        q, sym = dict(req.url.params), req.url.path.split("/")[3]
        if q["feed"] == "sip" and not self.sip_realtime:
            return httpx.Response(403, json={"message": "subscription does not permit querying recent SIP data"})
        end = min(datetime.fromisoformat(q["end"]), self.data_frozen_at or self.now)
        df = self.res.to_long(self.res.sidx(sym), self.d, self.d + 1)
        df = df[df["timestamp"] < pd.Timestamp(end)]
        return httpx.Response(200, json={"bars": [{"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": o, "h": h, "l": l, "c": c, "v": v}
                                                   for t, o, h, l, c, v in zip(df.timestamp, df.open, df.high, df.low, df.close, df.volume)], "next_page_token": None})

    def paper(self, req: httpx.Request):
        self.hosts.add(req.url.host)
        if self.paper_down:
            raise httpx.ConnectError("down")
        p = req.url.path
        if p.endswith("/account"):
            return httpx.Response(200, json={"status": "ACTIVE", "currency": "USD", "equity": "100000", "cash": "100000", "buying_power": "100000"})
        if p.endswith("/positions"):
            allp = {**{k: v for k, v in self.pos.items() if abs(v["qty"]) > 1e-9}, **self.foreign}
            return httpx.Response(200, json=[{"symbol": k, "qty": str(v["qty"]), "avg_entry_price": str(v["px"]), "current_price": str(self.px(k)),
                                              "unrealized_pl": str((self.px(k) - v["px"]) * v["qty"]), "market_value": str(self.px(k) * v["qty"])} for k, v in allp.items()])
        if p.endswith("/orders") and req.method == "POST":
            b = json.loads(req.content)
            self.posts.append(b)
            if b["client_order_id"] in self.orders:
                return httpx.Response(422, json={"message": "client_order_id must be unique"})
            o = {"id": f"o{len(self.orders)}", "client_order_id": b["client_order_id"], "symbol": b["symbol"], "side": b["side"], "qty": b["qty"], "type": b["type"]}
            if b["type"] == "market":
                q_ = float(b["qty"]) * (1 if b["side"] == "buy" else -1)
                cur = self.pos.get(b["symbol"], {"qty": 0.0, "px": 0.0})
                self.pos[b["symbol"]] = {"qty": cur["qty"] + q_, "px": self.px(b["symbol"]) if abs(cur["qty"]) < 1e-9 else cur["px"]}
                o.update(status="filled", filled_qty=b["qty"], filled_avg_price=str(self.px(b["symbol"])))
            else:
                o.update(status="accepted", filled_qty="0", limit_price=b.get("limit_price"))
            self.orders[b["client_order_id"]] = o
            return httpx.Response(200, json=o)
        if "by_client_order_id" in p:
            return httpx.Response(200, json=self.orders[req.url.params["client_order_id"]])
        if req.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(404)


def make(rt, sim, strategies=STRATS, feeds=("sip", "iex")):
    data = AlpacaClient("k", "s", transport=httpx.MockTransport(sim.data), sleep=lambda s: None)
    broker = AlpacaPaperBroker("k", "s", transport=httpx.MockTransport(sim.paper))
    rt.alpaca_paper = broker
    rt.live = LiveExperimental(rt.ctx, data, broker, rt.engine.guardian, now=lambda: sim.now, feeds=feeds, strategies=strategies)
    return rt.live


def enable(rt, live):
    rt.ctx.db.set_meta("broker_diagnostic", live.broker.diagnostic("SPY") | {"ts": 0})
    live.set_switch(True)


def run_day(sim, live, start_bar=0, end_bar=79, hook=None):
    for k in range(start_bar, end_bar):
        sim.now = sim.open + timedelta(minutes=5 * k, seconds=20)
        if hook:
            hook(k)
        live.tick()


def entries(db, day):
    return db.q("SELECT * FROM live_orders WHERE kind='entry' AND day=?", (day.isoformat(),))


def test_switch_is_off_by_default_and_needs_a_passed_diagnostic(world):
    sim = Sim(world)
    live = make(world, sim)
    run_day(sim, live, 0, 30)
    assert sim.posts == [] and live.state()["switch"] is False
    with pytest.raises(PermissionError, match="diagnostic"):
        live.set_switch(True)
    c = TestClient(create_app(world))
    assert c.post("/api/experimental/switch?on=true").status_code == 400                       # explicit confirmation text required
    assert c.post("/api/experimental/switch?on=true&confirm=ENABLE-EXPERIMENTAL-PAPER").status_code == 409   # and a passed diagnostic
    assert c.post("/api/broker/diagnostic?confirm=PAPER-DIAGNOSTIC").json()["ok"] is True
    assert c.post("/api/experimental/switch?on=true&confirm=ENABLE-EXPERIMENTAL-PAPER").json()["switch"] is True
    st = c.get("/api/experimental").json()
    assert st["switch"] and st["diagnostic_passed"] and st["limits"]["max_position_cad"] == 500 and "NOT passed validation" in st["label"]


def test_full_session_pipeline_respects_every_limit(world):
    sim = Sim(world)
    live = make(world, sim)
    enable(world, live)
    n_diag = len(sim.posts)
    run_day(sim, live)
    db, L = world.ctx.db, world.cfg.risk
    ent = entries(db, sim.day)
    assert 1 <= len(ent) <= L.live_experimental_max_entries_per_day == 2
    fx = float(world.ctx.market.fx[-1])
    for o in ent:
        assert o["status"] == "FILLED" and o["qty"] * o["avg_px"] * fx <= L.live_experimental_max_position_cad + 0.5
        assert o["signal_ts"] < o["submitted_ts"] and (pd.Timestamp(o["submitted_ts"]) - pd.Timestamp(o["signal_ts"])).total_seconds() <= 60     # acted within a minute of the bar close
        assert (o["side"] > 0) or float(o["qty"]).is_integer()                                   # shorts are whole shares
    trades = db.q("SELECT * FROM live_trades WHERE day=?", (sim.day.isoformat(),))
    assert len(trades) == len(ent) and db.q("SELECT * FROM live_positions") == []                 # every position was closed: nothing overnight
    assert all(abs(v["qty"]) < 1e-9 for v in sim.pos.values())                                    # and the broker agrees
    for t in trades:
        assert t["pnl_usd"] == pytest.approx(t["side"] * (t["exit_px"] - t["entry_px"]) * t["qty"]) and t["exit_reason"] in ("stop", "target", "time", "end_of_day", "daily_loss_limit")
        assert t["feed"] == "iex" and t["signal_ts"] and t["est_fees_usd"] >= 0
    assert sim.hosts == {"data.alpaca.markets", "paper-api.alpaca.markets"}                       # never any other endpoint
    dec = {r["decision"] for r in db.q("SELECT decision FROM live_decisions")}
    assert "order_submitted" in dec and "exit_submitted" in dec
    if len(ent) == 2:
        assert db.one("SELECT COUNT(*) n FROM live_decisions WHERE decision='rejected_by_risk' AND detail LIKE '%daily entry limit%'")["n"] >= 1
    assert db.get_meta("live_feed_restriction")["feed"] == "sip" and live.state()["feed"] == "iex"   # SIP refusal recorded, IEX used
    assert live.state()["suspended"] is None
    assert db.one("SELECT COUNT(*) n FROM paper_trades WHERE day=?", (sim.day.isoformat(),))["n"] == 0   # kept apart from validated paper results
    sim.now = sim.close + timedelta(minutes=5)
    live.tick()
    assert db.one("SELECT COUNT(*) n FROM metrics WHERE kind='experimental_review'")["n"] == 1 and db.one("SELECT COUNT(*) n FROM kb_lessons WHERE family='experimental'")["n"] >= 1
    assert len(sim.posts) - n_diag == 2 * len(ent)                                                # one entry and one exit per trade: nothing manufactured


def test_restart_mid_session_never_duplicates_orders(world):
    sim = Sim(world)
    live = make(world, sim)
    enable(world, live)
    k = 0
    while not entries(world.ctx.db, sim.day) and k < 70:
        run_day(sim, live, k, k + 1); k += 1
    assert entries(world.ctx.db, sim.day)
    posts, state = len(sim.posts), dict(live.state())
    reborn = make(world, sim)                                  # new process state, same database, same moment
    reborn.tick(); reborn.tick()
    assert len(sim.posts) == posts and reborn.state()["switch"] is True and reborn.state()["last_bar"] == state["last_bar"]
    world.ctx.db.set_meta("live_state", {**reborn.state(), "last_bar": None})   # even if the bar marker is lost, the order id stops a repeat
    reborn.tick()
    assert len([p for p in sim.posts if p["client_order_id"].endswith("-E")]) == len(entries(world.ctx.db, sim.day))
    run_day(sim, reborn, k, 79)
    assert world.ctx.db.q("SELECT * FROM live_positions") == []
    ids = [p["client_order_id"] for p in sim.posts]
    assert len(ids) == len(set(ids))


def test_stale_data_suspends_and_recovers(world):
    sim = Sim(world)
    live = make(world, sim)
    enable(world, live)
    sim.data_frozen_at = sim.open + timedelta(minutes=5 * 8)             # feed stops after the 8th bar
    run_day(sim, live, 0, 16)
    assert live.state()["suspended"] == "stale market data"
    n = len(entries(world.ctx.db, sim.day))
    assert all(o["bar"] <= 8 for o in entries(world.ctx.db, sim.day))
    assert world.ctx.db.one("SELECT COUNT(*) n FROM alerts WHERE source='live' AND message LIKE '%stale%'")["n"] == 1
    sim.data_frozen_at = None
    run_day(sim, live, 16, 18)
    assert live.state()["suspended"] is None and len(entries(world.ctx.db, sim.day)) >= n


def test_broker_outage_suspends_without_crashing(world):
    sim = Sim(world)
    live = make(world, sim)
    enable(world, live)
    sim.paper_down = True
    run_day(sim, live, 0, 20)
    assert live.state()["suspended"] == "broker or data failure" and entries(world.ctx.db, sim.day) == []
    assert world.ctx.db.one("SELECT COUNT(*) n FROM audit_log WHERE action='experimental.error'")["n"] >= 3
    sim.paper_down = False
    run_day(sim, live, 20, 24)
    assert live.state()["suspended"] is None


def test_position_mismatch_with_the_broker_suspends_entries(world):
    sim = Sim(world)
    live = make(world, sim)
    enable(world, live)
    sim.foreign = {"TSLA": {"qty": 3.0, "px": 200.0}}                    # a position the app did not open
    run_day(sim, live, 0, 12)
    assert (live.state()["suspended"] or "").startswith("position mismatch")
    before = len(entries(world.ctx.db, sim.day))
    run_day(sim, live, 12, 30)
    assert len(entries(world.ctx.db, sim.day)) == before
    assert world.ctx.db.one("SELECT COUNT(*) n FROM live_decisions WHERE decision='rejected_by_risk' AND detail LIKE '%suspended%'")["n"] >= 0
    sim.foreign = {}
    run_day(sim, live, 30, 32)
    assert live.state()["suspended"] is None


def test_kill_switch_blocks_entries_and_flattens(world):
    sim = Sim(world)
    live = make(world, sim)
    enable(world, live)
    k = 0
    while not world.ctx.db.q("SELECT * FROM live_positions") and k < 70:
        run_day(sim, live, k, k + 1); k += 1
    assert world.ctx.db.q("SELECT * FROM live_positions")
    world.engine.guardian.kill(True, "operator", "test")
    n = len(entries(world.ctx.db, sim.day))
    run_day(sim, live, k, k + 6)
    assert world.ctx.db.q("SELECT * FROM live_positions") == [] and len(entries(world.ctx.db, sim.day)) == n
    assert world.ctx.db.one("SELECT exit_reason r FROM live_trades ORDER BY id DESC LIMIT 1")["r"] == "risk_halt"


def test_live_risk_check_sizes_and_refuses(world):
    g = world.engine.guardian
    sim = Sim(world)
    base = {"switch": True, "suspended": None, "symbol": "SPY", "side": 1, "px": 700.0, "dist": 3.0, "fx": 1.40, "fx_asof": sim.day, "day": sim.day,
            "now": sim.open + timedelta(minutes=60), "bar": 11, "entries_today": 0, "day_pnl_cad": 0.0, "positions": [], "equity_usd": 100000.0, "broker_is_paper": True, "client_id": "x"}
    ok, _, qty = g.check_live(base)
    assert ok and qty == pytest.approx(0.5102, abs=1e-4) and qty * 700 * 1.40 <= 500            # fractional long capped at CAD 500 notional
    assert g.check_live({**base, "side": -1})[1].startswith("no size available")                 # cannot short a fraction of a USD 700 share
    ok, _, q2 = g.check_live({**base, "side": -1, "px": 150.0})
    assert ok and q2 == 2.0
    ok, _, q3 = g.check_live({**base, "dist": 100.0})
    assert ok and q3 * 100.0 * 1.40 <= 25.0 + 1e-6                                               # a trade may plan at most half the daily loss budget
    for patch, why in (({"switch": False}, "switch is off"), ({"entries_today": 2}, "daily entry limit"), ({"day_pnl_cad": -50.0}, "daily loss limit"),
                       ({"positions": [{"symbol": "SPY", "notional_cad": 400.0}]}, "already open"), ({"broker_is_paper": False}, "not a paper broker"),
                       ({"fx_asof": sim.day - timedelta(days=9)}, "USD/CAD"), ({"now": sim.close - timedelta(minutes=10)}, "final 30 minutes"),
                       ({"suspended": "stale market data"}, "suspended"), ({"equity_usd": 0.5}, "no size available")):
        ok, reason, q = g.check_live({**base, **patch})
        assert not ok and q == 0 and why in reason, (patch, reason)
    ok, _, q4 = g.check_live({**base, "equity_usd": 100.0})
    assert ok and q4 * 700 <= 100.0                                                              # no leverage: never more than the account's own equity


def test_ineligible_strategies_are_listed_not_traded(world):
    sim = Sim(world)
    mid = world.ctx.db.one("SELECT id FROM models LIMIT 1")["id"]
    extra = [{"id": "VOL", "source": "t", "note": "", "spec": {"family": "feature", "trigger": {"kind": "feature", "feat": "trend_z", "thr": 1.0}, "filters": [{"feat": "rel_vol", "op": ">", "thr": 1.2}]}},
             {"id": "SIM", "source": "t", "note": "", "spec": {"family": "similarity", "trigger": {"kind": "feature", "feat": "dop_mean_z", "thr": 0.3}}},
             {"id": "ML", "source": "t", "note": "", "spec": {"family": "ml", "trigger": {"kind": "model", "model_id": mid, "thr": 0.05}}},
             {"id": "BAD", "source": "t", "note": "", "spec": {"family": "feature", "trigger": {"kind": "feature", "feat": "no_such", "thr": 1.0}}}]
    live = make(world, sim, STRATS + extra)
    assert [s["id"] for s in live.strategies] == ["T-ORB", "T-FAIL"]
    why = {x["id"]: x["reason"] for x in live.ineligible}
    assert "consolidated volume" in why["VOL"] and "similarity" in why["SIM"] and "model" in why["ML"] and "invalid" in why["BAD"]
    sip = make(world, Sim(world, sip_realtime=True), STRATS + extra[:1], feeds=("sip",))          # with real-time SIP the volume strategy is allowed
    assert "VOL" in [s["id"] for s in sip.strategies]
    shipped = LiveExperimental(world.ctx, sip.data, sip.broker, world.engine.guardian, now=lambda: sim.now)
    assert len(shipped.strategies) == 3 and shipped.ineligible == []                             # the three shipped forward-test strategies are price-only


def test_losing_experimental_strategy_becomes_a_research_hypothesis(world):
    db = world.ctx.db
    for i in range(12):
        db.x("INSERT INTO live_trades(strategy,symbol,side,qty,day,pnl_usd,pnl_cad,r_multiple,exit_reason) VALUES(?,?,?,?,?,?,?,?,?)", ("EXP-MOMENTUM-ORB", "SPY", 1, 0.5, "x", -3, -4.2, -0.4, "stop"))
    cid = db.x("INSERT INTO cycles(epoch,status,stage) VALUES(?,?,?)", (world.ctx.epoch.id, "running", "observe"))
    hy = darwin.hypothesize(world.ctx, darwin.observe(world.ctx), darwin.Grammar(True, False, []), cid)
    gap = [h for h in hy if h["kind"] == "live_gap"]
    assert len(gap) == 1 and "12 live experimental paper trades" in gap[0]["statement"] and gap[0]["status"] == "open"
