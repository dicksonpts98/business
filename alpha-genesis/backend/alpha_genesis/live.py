"""LIVE experimental paper trading: real-time signals during the market session, orders to the Alpaca PAPER
account, with hard limits enforced by the Risk Guardian.

Clearly separate from validated research: it has its own tables (live_*), its own limits, and is OFF until
the operator turns the switch on in the dashboard after a successful broker diagnostic. The strategies it
forward-tests have NOT passed validation; they are listed in config/experimental_strategies.json.

Timing: a signal is computed from the 5-minute bar that has just completed and a market order is sent
immediately. Bars come from the fastest feed the account is entitled to (SIP if real-time SIP is permitted,
otherwise IEX). Strategies that depend on consolidated volume are not eligible on IEX."""
from __future__ import annotations
import json, math, threading, time, traceback
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import numpy as np
import pandas as pd
from pydantic import ValidationError
from . import fees, liedetector, mcal
from .alpaca import AlpacaEntitlementError, AlpacaError
from .broker import BrokerError
from .config import BARS_PER_DAY as B
from .db import jd
from .dsl import StrategySpec, signals
from .features import FeatureStore
from .market import FIELDS, Market

VOLUME_FEATURES = {"rel_vol", "illiq_ratio", "vwap_z"}
VOLUME_PATTERNS = {"VOL_CLIMAX_REV", "SWEEP_HIGH_FAIL", "VWAP_RECLAIM_FAIL", "VWAP_LOSS_FAIL"}
OPEN = ("SUBMITTED", "PARTIALLY_FILLED")
UTC = timezone.utc


class LiveExperimental:
    def __init__(self, ctx, data_client, broker, guardian, now=None, feeds=("sip", "iex"), strategies: list[dict] | None = None):
        self.ctx, self.db, self.cfg = ctx, ctx.db, ctx.cfg
        self.data, self.broker, self.guardian = data_client, broker, guardian
        self.now = now or (lambda: datetime.now(UTC))
        self.feeds = tuple(feeds)
        raw = strategies if strategies is not None else json.loads((self.cfg.config_dir / "experimental_strategies.json").read_text())
        self.strategies, self.ineligible = [], []
        for r in raw:
            try:
                spec = StrategySpec.model_validate(r["spec"])
            except ValidationError as e:
                self.ineligible.append({"id": r.get("id"), "reason": f"invalid definition: {str(e)[:80]}"})
                continue
            why = self._ineligible(spec)
            (self.ineligible.append({"id": r["id"], "reason": why}) if why else self.strategies.append({**r, "spec_obj": spec}))
        self._cache = None

    # -- eligibility ------------------------------------------------------------------
    def _ineligible(self, spec: StrategySpec) -> str | None:
        t = spec.trigger
        used = {c.feat for c in spec.filters + spec.avoid} | ({t.feat} if t.feat else set())
        if t.kind in ("model", "random", "passive", "none") or any(f.startswith("dop_") for f in used):
            return "needs model scores, similarity columns or a non-signal trigger that the live loop does not compute"
        if "iex" in self.feeds and (used & VOLUME_FEATURES or set(t.patterns) & VOLUME_PATTERNS):
            return "depends on consolidated volume, which the real-time IEX feed does not provide"
        return None

    # -- persisted state ------------------------------------------------------------------
    def state(self) -> dict:
        return {"switch": False, "suspended": None, "last_bar": None, "feed": None, "errors": 0, "reviewed": None, **(self.db.get_meta("live_state") or {})}

    def _set(self, **kw):
        self.db.set_meta("live_state", {**self.state(), **kw})

    def set_switch(self, on: bool, actor: str = "operator") -> dict:
        if on:
            diag = self.db.get_meta("broker_diagnostic") or {}
            if not diag.get("ok"):
                raise PermissionError("run and pass the broker diagnostic before enabling experimental paper trading")
            if not self.strategies:
                raise PermissionError("no eligible experimental strategy is configured")
        self._set(switch=bool(on), suspended=None if on else self.state()["suspended"], errors=0)
        self.db.audit(actor, "experimental.switch_on" if on else "experimental.switch_off", {"strategies": [s["id"] for s in self.strategies]})
        return self.state()

    def _decide(self, now, day, bar, sid, sym, decision, detail=""):
        self.db.x("INSERT INTO live_decisions(ts,day,bar,strategy,symbol,decision,detail) VALUES(?,?,?,?,?,?,?)",
                  (now.isoformat(timespec="seconds"), day.isoformat(), bar, sid, sym, decision, str(detail)[:300]))

    def _suspend(self, reason: str):
        if self.state()["suspended"] != reason:
            self._set(suspended=reason)
            self.db.audit("live", "experimental.suspended", {"reason": reason})
            self.db.alert("critical", "live", f"Experimental paper trading suspended: {reason}")

    # -- market data --------------------------------------------------------------------
    def _bars(self, day: date, sess, now) -> tuple[pd.DataFrame, str]:
        """Completed 5-minute bars of today's session from the fastest permitted feed."""
        last_err = None
        for feed in self.feeds:
            try:
                parts = []
                for sym in self.ctx.market.symbols:
                    df = self.data.bars(sym, sess[0], now, feed)
                    df = df[df["timestamp"] + pd.Timedelta(minutes=5) <= pd.Timestamp(now)]
                    parts.append(df.assign(symbol=sym))
                return pd.concat(parts, ignore_index=True), feed
            except AlpacaEntitlementError as e:
                last_err = e
                self.db.set_meta("live_feed_restriction", {"feed": feed, "error": str(e), "ts": now.isoformat()})
        raise AlpacaError(f"no real-time feed permitted among {self.feeds}: {last_err}")

    def _features(self, day: date, bars: pd.DataFrame):
        h = self.ctx.market
        Dh = h.days.index(day) if day in h.days else h.D
        lo = max(0, Dh - 320)
        t = Market(h.symbols, h.days[lo:Dh] + [day], h.kind)
        for f in FIELDS:
            getattr(t, f)[:, :-1] = getattr(h, f)[:, lo:Dh]
        t.fx[:-1] = h.fx[lo:Dh]
        ok = np.where(np.isfinite(h.fx[:Dh]))[0]
        fx_asof = h.fx_asof[ok[-1]] if len(ok) else None
        t.fx[-1] = h.fx[ok[-1]] if len(ok) else np.nan
        t.put_long(bars)
        fs = FeatureStore(t, self.cfg.proxy)
        liedetector.detect(t, fs, t.D - 1)
        return t, fs, fx_asof

    # -- positions and P&L -----------------------------------------------------------------
    def _positions(self):
        return self.db.q("SELECT * FROM live_positions")

    def _day_pnl_cad(self, day: date, fx: float) -> float:
        realised = self.db.one("SELECT COALESCE(SUM(pnl_cad),0) s FROM live_trades WHERE day=?", (day.isoformat(),))["s"]
        unreal = 0.0
        if self._positions():
            mine = {p["symbol"] for p in self._positions()}
            unreal = sum(p["unrealized_pl"] for p in self.broker.position_details() if p["symbol"] in mine) * fx
        return float(realised + unreal)

    def _sync_orders(self, now):
        for o in self.db.q("SELECT * FROM live_orders WHERE status IN ('SUBMITTED','PARTIALLY_FILLED')"):
            r = self.broker.order(o["client_id"])
            if r["status"] == o["status"] and r.get("filled_qty") == o["filled_qty"]:
                continue
            with self.db.tx():
                self.db.x("UPDATE live_orders SET status=?, filled_qty=?, avg_px=?, broker_id=?, updated_ts=? WHERE client_id=?",
                          (r["status"], r.get("filled_qty") or 0, r.get("avg_px"), r.get("broker_id"), now.isoformat(timespec="seconds"), o["client_id"]))
                meta = json.loads(o["meta"] or "{}")
                if r["status"] == "FILLED" and o["kind"] == "entry":
                    px, side = float(r["avg_px"]), o["side"]
                    self.db.x("""INSERT OR REPLACE INTO live_positions(symbol,strategy,side,qty,entry_px,entry_ts,stop_px,target_px,exit_by_bar,entry_bar,day,fx,entry_client_id,meta)
                                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                              (o["symbol"], o["strategy"], side, float(r["filled_qty"]), px, now.isoformat(timespec="seconds"), px - side * meta["dist"],
                               (px + side * meta["dist"] * meta["target_r"]) if meta.get("target_r") else None, o["bar"] + meta["max_hold"], o["bar"] + 1, o["day"], meta["fx"],
                               o["client_id"], jd({"dist": meta["dist"], "signal_ts": o["signal_ts"], "why": meta.get("why")})))
                    self.db.audit("live", "experimental.fill", {"client_id": o["client_id"], "qty": r["filled_qty"], "px": px})
                elif r["status"] == "FILLED" and o["kind"] == "exit":
                    p = meta["position"]
                    px, side, qty = float(r["avg_px"]), p["side"], float(r["filled_qty"])
                    pnl = side * (px - p["entry_px"]) * qty
                    fee = fees.fill_fee(self.cfg, +1, qty, p["entry_px"], o["day"])["total"] + fees.fill_fee(self.cfg, -1, qty, px, o["day"])["total"]
                    self.db.x("""INSERT INTO live_trades(strategy,symbol,side,qty,day,entry_ts,exit_ts,signal_ts,entry_px,exit_px,pnl_usd,pnl_cad,est_fees_usd,r_multiple,exit_reason,feed,meta)
                                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                              (p["strategy"], p["symbol"], side, qty, o["day"], p["entry_ts"], now.isoformat(timespec="seconds"), json.loads(p["meta"])["signal_ts"], p["entry_px"], px,
                               pnl, pnl * p["fx"], fee, pnl / (qty * json.loads(p["meta"])["dist"]), meta["reason"], self.state()["feed"], jd({"why": json.loads(p["meta"]).get("why")})))
                    self.db.x("DELETE FROM live_positions WHERE symbol=?", (p["symbol"],))
                    self.db.audit("live", "experimental.closed", {"symbol": p["symbol"], "pnl_usd": round(pnl, 2), "reason": meta["reason"]})
                elif r["status"] in ("REJECTED", "CANCELLED", "EXPIRED"):
                    self.db.alert("warning", "live", f"Paper order {o['client_id']} ended {r['status']}: {str(r.get('reason') or '')[:100]}")

    def _exit(self, p: dict, reason: str, now, day: date):
        if self.db.one("SELECT 1 FROM live_orders WHERE symbol=? AND kind='exit' AND status IN ('SUBMITTED','PARTIALLY_FILLED')", (p["symbol"],)):
            return
        n = self.db.one("SELECT COUNT(*) n FROM live_orders WHERE symbol=? AND kind='exit' AND day=? AND meta LIKE ?", (p["symbol"], day.isoformat(), f'%{p["entry_client_id"]}%'))["n"]
        cid = p["entry_client_id"][:-1] + f"X{n}"
        r = self.broker.submit(cid, p["strategy"], p["symbol"], -p["side"], p["qty"], "exit", now.isoformat())
        self.db.x("""INSERT OR IGNORE INTO live_orders(client_id,broker_id,strategy,symbol,side,qty,kind,status,day,bar,signal_ts,submitted_ts,reason,meta)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (cid, r.get("broker_id"), p["strategy"], p["symbol"], -p["side"], p["qty"], "exit", r["status"] if r["status"] != "FILLED" else "SUBMITTED", day.isoformat(), p["entry_bar"],
                   None, now.isoformat(timespec="seconds"), reason, jd({"reason": reason, "position": p, "entry": p["entry_client_id"]})))
        self._decide(now, day, -1, p["strategy"], p["symbol"], "exit_submitted", reason)

    def flatten(self, reason: str, now=None):
        now = now or self.now()
        day = now.astimezone(mcal.NY).date()
        for p in self._positions():
            self._exit(p, reason, now, day)

    # -- one iteration ------------------------------------------------------------------------
    def tick(self) -> dict:
        now = self.now()
        day = now.astimezone(mcal.NY).date()
        sess = mcal.session(day)
        st = self.state()
        out = {"ts": now.isoformat(timespec="seconds"), "day": day.isoformat(), "phase": "closed", "switch": st["switch"]}
        try:
            self._sync_orders(now)
            if sess is None or now < sess[0]:
                return self._done(out)
            if now >= sess[1]:
                if self._positions():
                    self.flatten("session_closed", now)
                if st["reviewed"] != day.isoformat():
                    self.daily_review(day)
                return self._done(out)
            slot = int((now - sess[0]).total_seconds() // 300) - 1
            flat_time = now >= sess[1] - timedelta(minutes=self.cfg.risk.live_experimental_flatten_minutes_before_close)
            out.update(phase="flatten" if flat_time else "open", bar=slot)
            if flat_time:
                self.flatten("end_of_day", now)
            if self.guardian.halted() and self._positions():
                self.flatten("risk_halt", now)
            if slot < 0 or st["last_bar"] == [day.isoformat(), slot]:
                return self._done(out)
            if not (st["switch"] or self._positions()):
                self._set(last_bar=[day.isoformat(), slot])
                return self._done(out)
            bars, feed = self._bars(day, sess, now)
            self._set(feed=feed)
            px_bars = bars[bars["symbol"] == self.cfg.proxy]
            last = max((mcal.bar_index(t.to_pydatetime())[1] for t in px_bars["timestamp"]), default=-1)
            out.update(feed=feed, last_bar_received=last, data_age_s=round((now - (sess[0] + timedelta(minutes=5 * (last + 1)))).total_seconds()) if last >= 0 else None)
            if last < slot - 1:
                self._decide(now, day, slot, "-", self.cfg.proxy, "suspended_bar", f"stale data: last completed bar {last}, expected {slot}")
                self._suspend("stale market data")
                out["stale"] = True
                self._set(last_bar=[day.isoformat(), slot])
                return self._done(out)
            if st["suspended"] in ("stale market data", "broker or data failure"):
                self._set(suspended=None)
                self.db.audit("live", "experimental.resumed", {"after": st["suspended"]})
            t, fs, fx_asof = self._features(day, bars)
            fx = float(t.fx[-1])
            b = min(slot, last)
            pnl = self._day_pnl_cad(day, fx) if np.isfinite(fx) else 0.0
            self._manage(t, b, now, day, pnl)
            if st["switch"] and not flat_time:
                self._entries(t, fs, b, now, day, fx, fx_asof, pnl)
            self._set(last_bar=[day.isoformat(), slot])
            self._reconcile(now)
            self._set(errors=0)                       # only a fully successful pass (data, broker, reconciliation) clears the error count
        except (BrokerError, AlpacaError) as e:
            n = self.state()["errors"] + 1
            self._set(errors=n)
            out["error"] = str(e)[:160]
            self.db.audit("live", "experimental.error", {"error": str(e)[:160], "consecutive": n})
            if n >= 3:
                self._suspend("broker or data failure")
        return self._done(out)

    def _done(self, out):
        out["suspended"] = self.state()["suspended"]
        self.db.set_meta("live_last_tick", out)
        return out

    def _manage(self, t: Market, b: int, now, day: date, pnl_cad: float):
        L = self.cfg.risk
        for p in self._positions():
            s = t.sidx(p["symbol"])
            h, l, c = t.h[s, -1, b], t.l[s, -1, b], t.c[s, -1, b]
            if not np.isfinite(c):
                continue
            side, reason = p["side"], None
            if side * ((l if side > 0 else h) - p["stop_px"]) <= 0:
                reason = "stop"
            elif p["target_px"] is not None and side * ((h if side > 0 else l) - p["target_px"]) >= 0:
                reason = "target"
            elif b >= p["exit_by_bar"]:
                reason = "time"
            elif pnl_cad <= -L.live_experimental_max_daily_loss_cad:
                reason = "daily_loss_limit"
            if reason:
                self._exit(p, reason, now, day)

    def _entries(self, t: Market, fs, b: int, now, day: date, fx: float, fx_asof, pnl_cad: float):
        acct_eq = None
        for strat in self.strategies:
            spec: StrategySpec = strat["spec_obj"]
            sig = signals(spec, fs, t.sidx(self.cfg.proxy))[:, -1, b]
            pats = spec.trigger.patterns if spec.trigger.kind == "event" and not spec.trigger.invert else []
            for s in np.nonzero(sig)[0]:
                s = int(s)
                sym, side = t.symbols[s], int(sig[s])
                px, atr = float(t.c[s, -1, b]), fs["_atr"][s, -1, b]
                if not (np.isfinite(px) and np.isfinite(atr) and atr > 0):
                    self._decide(now, day, b, strat["id"], sym, "skipped", "no price or volatility estimate")
                    continue
                dist = spec.exit.stop_atr * float(atr)
                for pt in pats:
                    inv = fs["inv:" + pt][s, -1, b]
                    if spec.exit.stop_kind == "invalidation" and np.isfinite(inv):
                        dist = side * (px - float(inv))
                        break
                dist = float(max(dist, 0.5 * atr, 0.0005 * px))
                cid = f"AGX-{strat['id']}-{sym}-{day:%Y%m%d}-{b}-E"
                if self.db.one("SELECT 1 FROM live_orders WHERE client_id=?", (cid,)):
                    continue                                  # already handled (e.g. before a restart)
                if acct_eq is None:
                    acct_eq = float(self.broker.account().get("equity") or 0)
                pos = self._positions()
                pend = self.db.q("SELECT symbol, qty, meta FROM live_orders WHERE kind='entry' AND status IN ('SUBMITTED','PARTIALLY_FILLED')")
                held = [{"symbol": p["symbol"], "notional_cad": p["qty"] * p["entry_px"] * p["fx"]} for p in pos] + \
                       [{"symbol": o["symbol"], "notional_cad": o["qty"] * json.loads(o["meta"])["ref_px"] * fx} for o in pend]
                entries = self.db.one("SELECT COUNT(*) n FROM live_orders WHERE kind='entry' AND day=? AND status NOT IN ('REJECTED')", (day.isoformat(),))["n"]
                ok, why, qty = self.guardian.check_live({
                    "switch": self.state()["switch"], "suspended": self.state()["suspended"], "symbol": sym, "side": side, "px": px, "dist": dist, "fx": fx, "fx_asof": fx_asof,
                    "day": day, "now": now, "bar": b, "entries_today": entries, "day_pnl_cad": pnl_cad, "positions": held, "equity_usd": acct_eq,
                    "broker_is_paper": self.broker.is_paper, "client_id": cid})
                if not ok:
                    self._decide(now, day, b, strat["id"], sym, "rejected_by_risk", why)
                    continue
                why_txt = self._why(spec, fs, s, b)
                r = self.broker.submit(cid, strat["id"], sym, side, qty, "entry", now.isoformat())
                self.db.x("""INSERT OR IGNORE INTO live_orders(client_id,broker_id,strategy,symbol,side,qty,kind,status,day,bar,signal_ts,submitted_ts,reason,meta)
                             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                          (cid, r.get("broker_id"), strat["id"], sym, side, qty, "entry", "REJECTED" if r["status"] == "REJECTED" else "SUBMITTED", day.isoformat(), b,
                           t.ts(t.D - 1, b), now.isoformat(timespec="seconds"), r.get("reason"),
                           jd({"dist": dist, "target_r": spec.exit.target_r, "max_hold": spec.exit.max_hold, "ref_px": px, "fx": fx, "why": why_txt})))
                self._decide(now, day, b, strat["id"], sym, "order_rejected_by_broker" if r["status"] == "REJECTED" else "order_submitted",
                             f"{'buy' if side > 0 else 'sell short'} {qty} @ ~{px:.2f}; {why_txt}")
        self._sync_orders(now)

    @staticmethod
    def _why(spec, fs, s, b) -> str:
        t = spec.trigger
        if t.kind == "event":
            return "/".join(p for p in t.patterns if fs["ev:" + p][s, -1, b] != 0) + " at this bar's close"
        return f"{t.feat} = {fs[t.feat][s, -1, b]:.2f} crossed ±{t.thr:g}"

    def _reconcile(self, now):
        if self.db.one("SELECT 1 FROM live_orders WHERE status IN ('SUBMITTED','PARTIALLY_FILLED')"):
            return                                    # in flight: compare once orders settle
        mine = {p["symbol"]: p["side"] * p["qty"] for p in self._positions()}
        theirs = {k: float(v) for k, v in self.broker.positions().items() if k in self.ctx.market.symbols}
        diff = {k: (mine.get(k, 0), theirs.get(k, 0)) for k in set(mine) | set(theirs) if abs(mine.get(k, 0) - theirs.get(k, 0)) > 1e-6}
        if diff:
            self.db.audit("live", "experimental.reconciliation_mismatch", {"diff": {k: list(v) for k, v in diff.items()}})
            self._suspend(f"position mismatch with the broker: {diff}")
        elif (self.state()["suspended"] or "").startswith("position mismatch"):
            self._set(suspended=None)

    # -- learning from completed experimental trades ----------------------------------------------
    def daily_review(self, day: date) -> dict:
        rows = self.db.q("SELECT strategy, COUNT(*) n, SUM(pnl_cad) pnl, AVG(r_multiple) r, SUM(pnl_cad>0) wins, SUM(est_fees_usd) fees FROM live_trades GROUP BY strategy")
        rev = {"day": day.isoformat(), "strategies": rows, "today": self.db.q("SELECT strategy, COUNT(*) n, SUM(pnl_cad) pnl FROM live_trades WHERE day=? GROUP BY strategy", (day.isoformat(),)),
               "decisions_today": self.db.q("SELECT decision, COUNT(*) n FROM live_decisions WHERE day=? GROUP BY decision", (day.isoformat(),))}
        self.db.metric("experimental_review", rev, day.isoformat())
        for r in rows:
            self.db.x("INSERT INTO kb_lessons(ts,cycle_id,subject,family,elements,lesson) VALUES(?,?,?,?,?,?)",
                      (time.time(), None, r["strategy"], "experimental", jd([r["strategy"]]), f"experimental_live: {r['n']} paper trades, mean {r['r']:.2f}R, net {r['pnl']:.2f} CAD"))
        self._set(reviewed=day.isoformat())
        return rev

    def status(self) -> dict:
        st, L = self.state(), self.cfg.risk
        today = self.now().astimezone(mcal.NY).date().isoformat()
        agg = self.db.one("SELECT COUNT(*) n, COALESCE(SUM(pnl_cad),0) pnl_cad, COALESCE(SUM(pnl_usd),0) pnl_usd, COALESCE(SUM(est_fees_usd),0) fees, AVG(r_multiple) r, SUM(pnl_cad>0) wins FROM live_trades")
        return {"switch": st["switch"], "suspended": st["suspended"], "feed": st["feed"], "feed_restriction": self.db.get_meta("live_feed_restriction"),
                "last_tick": self.db.get_meta("live_last_tick"), "diagnostic_passed": bool((self.db.get_meta("broker_diagnostic") or {}).get("ok")),
                "limits": {"max_position_cad": L.live_experimental_max_position_cad, "max_entries_per_day": L.live_experimental_max_entries_per_day,
                           "max_daily_loss_cad": L.live_experimental_max_daily_loss_cad, "leverage_x": L.live_experimental_leverage_x, "overnight_positions": "never",
                           "flatten_minutes_before_close": L.live_experimental_flatten_minutes_before_close},
                "strategies": [{k: s[k] for k in ("id", "source", "note")} | {"rule": s["spec_obj"].describe()} for s in self.strategies], "ineligible": self.ineligible,
                "summary": agg, "entries_today": self.db.one("SELECT COUNT(*) n FROM live_orders WHERE kind='entry' AND day=? AND status!='REJECTED'", (today,))["n"],
                "positions": self._positions(), "orders": self.db.q("SELECT client_id,strategy,symbol,side,qty,kind,status,filled_qty,avg_px,day,bar,signal_ts,submitted_ts,reason FROM live_orders ORDER BY submitted_ts DESC LIMIT 60"),
                "trades": self.db.q("SELECT * FROM live_trades ORDER BY id DESC LIMIT 100"), "decisions": self.db.q("SELECT * FROM live_decisions ORDER BY id DESC LIMIT 80"),
                "by_strategy": self.db.q("SELECT strategy, COUNT(*) n, SUM(pnl_cad) pnl_cad, AVG(r_multiple) r FROM live_trades GROUP BY strategy"),
                "label": "EXPERIMENTAL — strategies here have NOT passed validation; results are kept separate from validated research"}


class LiveLoop(threading.Thread):
    def __init__(self, live: LiveExperimental, period_s: float = 15.0):
        super().__init__(daemon=True, name="alpha-genesis-live")
        self.live, self.period, self.stop_flag = live, period_s, threading.Event()

    def run(self):
        while not self.stop_flag.is_set():
            try:
                self.live.tick()
            except Exception:
                self.live.db.alert("critical", "live", "live loop error: " + traceback.format_exc()[-300:])
            self.stop_flag.wait(self.period)
