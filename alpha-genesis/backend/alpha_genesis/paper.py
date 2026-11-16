"""Paper-trading engine: applies the frozen champion deployment one bar at a time, routes every order
through the Risk Guardian and a paper broker, and persists progress after each bar so an interrupted
session resumes without duplicating or losing orders."""
from __future__ import annotations
import json
from datetime import datetime
import numpy as np
from . import mcal, registry
from .backtest import cost_frac
from .broker import Broker, BrokerDisconnected, PaperBroker
from .config import BARS_PER_DAY as B
from .core import Ctx
from .db import jd
from .dsl import StrategySpec
from .features import REGIME_NAMES
from .guardian import RiskGuardian


class InjectedCrash(RuntimeError):
    pass


class PaperEngine:
    def __init__(self, ctx: Ctx, broker: Broker | None = None):
        self.ctx, self.db, self.cfg = ctx, ctx.db, ctx.cfg
        ex = self.cfg.alpha["execution"]
        self.broker = broker or PaperBroker(self.db, ex["commission_per_share_usd"], ex["commission_min_usd"], ex["participation_cap"])
        self.guardian = RiskGuardian(self.cfg, self.db)
        self.crash_at: int | None = None     # failure injection: raise after committing this bar

    # -- account state -----------------------------------------------------------
    def equity(self) -> float:
        r = self.db.one("SELECT equity_cad FROM equity ORDER BY d DESC LIMIT 1")
        return r["equity_cad"] if r else self.cfg.risk.starting_capital_cad

    def _positions(self) -> list[dict]:
        return self.db.q("SELECT * FROM positions")

    def recover(self) -> list[str]:
        """Crash recovery at start-up: expire orders stranded by a dead process and report open positions.
        (Positions of an unfinished session are resumed by run_session; nothing is silently dropped.)"""
        notes = []
        prog = self.db.get_meta("paper_progress")
        stale = self.db.q("SELECT * FROM orders WHERE status='SUBMITTED'")
        for o in stale:
            day = o["created_ts"][:10]
            if not prog or prog.get("done") or prog["day"] != (json.loads(o["meta"] or "{}").get("day") or day):
                self.db.x("UPDATE orders SET status='EXPIRED', reason='expired during crash recovery' WHERE id=?", (o["id"],))
                notes.append(f"expired stranded order {o['client_id']}")
        if prog and not prog.get("done"):
            notes.append(f"session {prog['day']} was interrupted after bar {prog['bar']}; it will resume from bar {prog['bar'] + 1}")
        diffs = self.guardian.reconcile({p["symbol"]: p["side"] * p["qty"] for p in self._positions()}, self.broker.positions())
        if diffs:
            notes.append(f"reconciliation mismatch on restart: {diffs}")
        import time
        for n in notes:
            self.db.x("INSERT INTO recovery_log(ts,message) VALUES(?,?)", (time.time(), "paper: " + n))
        return notes

    # -- one session ---------------------------------------------------------------
    def run_session(self, d: int) -> dict:
        ctx, m, fs, db, L = self.ctx, self.ctx.market, self.ctx.fs, self.db, self.cfg.risk
        day = m.days[d]
        day_s = day.isoformat()
        if db.one("SELECT 1 FROM equity WHERE day=?", (day_s,)):
            return {"day": day_s, "skipped": "already processed"}
        prog = db.get_meta("paper_progress")
        resume = bool(prog and prog["day"] == day_s and not prog.get("done"))
        start_bar = prog["bar"] + 1 if resume else 0
        dep = registry.active_deployment(db)
        champ = registry.champion(db)
        spec: StrategySpec | None = None
        if dep and champ and dep["strategy_id"] == champ["id"]:
            art = json.loads(dep["artifact"])
            spec = StrategySpec.model_validate(art["spec"])      # trade the frozen artifact, not the registry row
            if spec.hash() != art["spec_hash"]:
                raise RuntimeError("deployment artifact does not match its spec hash")
        sid = champ["id"] if spec else None
        sig = ctx.signals(spec)[:, d] if spec else None
        pats = spec.trigger.patterns if spec and spec.trigger.kind == "event" and not spec.trigger.invert else []
        fx, fx_asof = m.fx[d], m.fx_asof[d]
        eq0 = self.equity()
        state = db.get_meta("paper_day_state") if resume else None
        st = state or {"realized": 0.0, "entries": 0, "rejects": 0, "interventions": 0}
        last_valid = {s: -1 for s in range(m.S)}
        for b in range(start_bar, B):
            now = mcal.bar_open_utc(day, b + 1)                  # the close of bar b
            with db.tx():
                # 1) entries submitted at the previous close fill at this bar's open
                for o in db.q("SELECT * FROM orders WHERE status='SUBMITTED' AND kind='entry'"):
                    s = m.sidx(o["symbol"])
                    meta = json.loads(o["meta"])
                    if not np.isfinite(m.o[s, d, b]):
                        db.x("UPDATE orders SET status='EXPIRED', reason='no bar at intended fill time', updated_ts=? WHERE id=?", (now.isoformat(), o["id"]))
                        continue
                    px = float(m.o[s, d, b] * (1 + o["side"] * cost_frac(self.cfg, o["symbol"], "base")))
                    f = self.broker.fill_market(o["client_id"], px, float(m.v[s, d, b]), mcal.bar_open_utc(day, b).isoformat())
                    if f["status"] in ("FILLED", "PARTIAL_CANCELLED"):
                        raw = float(m.o[s, d, b])
                        dist = meta["stop_dist"]
                        db.x("""INSERT INTO positions(symbol,strategy_id,side,qty,entry_px,entry_ts,stop_px,target_px,exit_by_bar,d,entry_bar,fx,cost_usd,meta)
                                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                             (o["symbol"], o["strategy_id"], o["side"], f["filled_qty"], px, mcal.bar_open_utc(day, b).isoformat(),
                              raw - o["side"] * dist, (raw + o["side"] * dist * spec.exit.target_r) if spec.exit.target_r else None,
                              b + spec.exit.max_hold - 1, d, b, fx, f.get("commission_usd", 0.0),
                              jd({**meta, "raw_entry": raw, "partial": f["status"] == "PARTIAL_CANCELLED"})))
                # 2) manage open positions against this bar
                unreal = 0.0
                for p in self._positions():
                    s = m.sidx(p["symbol"])
                    o_, h_, l_, c_ = m.o[s, d, b], m.h[s, d, b], m.l[s, d, b], m.c[s, d, b]
                    if not np.isfinite(c_):
                        continue                                  # no data: cannot exit, risk stays open
                    last_valid[s] = b
                    side, reason, raw_x = p["side"], None, None
                    hs = self.cfg.instrument(p["symbol"])["half_spread_bps"] / 1e4
                    if b > p["entry_bar"] and side * (o_ - p["stop_px"]) <= 0:
                        reason, raw_x = "stop_gap", o_
                    elif side * ((l_ if side > 0 else h_) - p["stop_px"]) <= 0:
                        reason, raw_x = "stop", p["stop_px"]
                    elif p["target_px"] is not None and side * ((h_ if side > 0 else l_) - p["target_px"]) > hs * p["target_px"]:
                        reason, raw_x = "target", p["target_px"]
                    elif b >= p["exit_by_bar"]:
                        reason, raw_x = "time", c_
                    elif b == B - 1 or not np.isfinite(m.c[s, d, b + 1:]).any():
                        reason, raw_x = "eod", c_
                    elif st["realized"] + unreal <= -L.max_daily_loss_cad or self.guardian.halted():
                        reason, raw_x = "risk_flatten", c_
                        st["interventions"] += 1
                    if reason:
                        st["realized"] += self._close(p, d, b, float(raw_x), reason, now)
                    else:
                        unreal += side * (c_ - p["entry_px"]) * p["qty"] * p["fx"]
                # 3) new signals at this close -> Guardian -> order for the next open
                if spec is not None and b < B - 1:
                    for s in np.nonzero(sig[:, b])[0]:
                        s = int(s)
                        sym, side = m.symbols[s], int(sig[s, b])
                        a = fs["_atr"][s, d, b]
                        c_ = m.c[s, d, b]
                        if not (np.isfinite(a) and a > 0 and np.isfinite(c_)):
                            continue
                        dist = spec.exit.stop_atr * a
                        for pt in pats:
                            inv = fs["inv:" + pt][s, d, b]
                            if spec.exit.stop_kind == "invalidation" and np.isfinite(inv):
                                dist = side * (c_ * (1 + side * cost_frac(self.cfg, sym, "base")) - inv)
                                break
                        dist = float(max(dist, 0.5 * a, 0.0005 * c_))
                        risk = L.risk_per_trade_cad * (0.5 if spec.sizing == "half_risk" else 1.0)
                        want = int(risk / (dist * fx)) if np.isfinite(fx) else 0
                        cid = f"{sid}:{sym}:{day_s}:{b}:entry"
                        last_ts = max((mcal.bar_open_utc(day, bb + 1) for bb in range(b, -1, -1) if np.isfinite(m.c[s, d, bb])), default=mcal.bar_open_utc(day, 0))
                        req = {"strategy_id": sid, "artifact_sha": dep["sha"], "symbol": sym, "side": side, "qty": want, "entry_px": float(c_),
                               "stop_px": float(c_ - side * dist), "fx": float(fx) if np.isfinite(fx) else None, "fx_asof": fx_asof, "day": day,
                               "now": now, "data_ts": last_ts, "client_id": cid, "broker_is_paper": self.broker.is_paper}
                        pos = [{"symbol": p["symbol"], "notional_cad": p["qty"] * p["entry_px"] * p["fx"]} for p in self._positions()]
                        pend = db.q("SELECT symbol, qty, meta FROM orders WHERE status='SUBMITTED' AND kind='entry'")
                        pos += [{"symbol": o["symbol"], "notional_cad": o["qty"] * json.loads(o["meta"])["ref_px"] * fx} for o in pend]
                        ok, why, qty = self.guardian.check_entry(req, {"equity": eq0 + st["realized"], "day_pnl": st["realized"] + unreal,
                                                                       "entries_today": st["entries"], "positions": pos})
                        if not ok:
                            st["rejects"] += 1
                            if why not in ("position already open in instrument",):
                                st["interventions"] += 1
                            continue
                        expl = self._explain(spec, sid, s, d, b, side, dist, fx, want, qty)
                        try:
                            o = self.broker.submit(cid, sid, sym, side, qty, "entry", now.isoformat(),
                                                   {"stop_dist": dist, "ref_px": float(c_), "signal_bar": b, "day": day_s, "explanation": expl})
                        except BrokerDisconnected as e:
                            db.audit("paper", "broker.disconnected", {"client_id": cid, "error": str(e)})
                            db.alert("warning", "broker", f"Broker connection lost submitting {cid}; order not placed, will not be retried blindly")
                            st["interventions"] += 1
                            continue
                        if o["status"] == "REJECTED":
                            db.audit("paper", "broker.rejected", {"client_id": cid, "reason": o.get("reason")})
                            st["interventions"] += 1
                        else:
                            st["entries"] += 1
                db.set_meta("paper_progress", {"day": day_s, "bar": b, "done": False})
                db.set_meta("paper_day_state", st)
            if self.crash_at is not None and b == self.crash_at:
                self.crash_at = None
                raise InjectedCrash(f"injected crash after bar {b}")
        with db.tx():
            for o in db.q("SELECT id FROM orders WHERE status='SUBMITTED'"):
                db.x("UPDATE orders SET status='EXPIRED', reason='session ended before fill' WHERE id=?", (o["id"],))
            for p in self._positions():      # safety net: nothing is carried overnight
                s = m.sidx(p["symbol"])
                ok = np.where(np.isfinite(m.c[s, d]))[0]
                st["realized"] += self._close(p, d, int(ok[-1]) if len(ok) else B - 1, float(m.c[s, d, ok[-1]]) if len(ok) else p["entry_px"], "eod_forced", mcal.bar_open_utc(day, B))
            diffs = self.guardian.reconcile({p["symbol"]: p["side"] * p["qty"] for p in self._positions()}, self.broker.positions())
            db.x("INSERT INTO equity(day,d,equity_cad,pnl_cad,strategy_id) VALUES(?,?,?,?,?)", (day_s, d, eq0 + st["realized"], st["realized"], sid))
            db.set_meta("paper_progress", {"day": day_s, "bar": B - 1, "done": True})
        # paper-vs-backtest discrepancy monitor
        out = {"day": day_s, "strategy": sid, "pnl_cad": st["realized"], "entries": st["entries"], "rejects": st["rejects"],
               "interventions": st["interventions"], "reconciliation": diffs}
        if spec is not None:
            bt = ctx.backtest(spec, d, d + 1, equity0=eq0)      # same starting equity: differences are real discrepancies
            diff = st["realized"] - float(bt.daily.sum())
            out["backtest_pnl_cad"], out["discrepancy_cad"] = float(bt.daily.sum()), diff
            if abs(diff) > 5.0 and st["interventions"] == 0:
                db.alert("warning", "paper", f"{day_s}: paper P&L differs from the research backtest by {diff:.2f} CAD with no risk intervention to explain it")
        db.metric("paper_session", out, day_s)
        return out

    def _close(self, p: dict, d: int, b: int, raw_x: float, reason: str, now: datetime) -> float:
        m, db = self.ctx.market, self.db
        s = m.sidx(p["symbol"])
        side = p["side"]
        px = raw_x if reason == "target" else raw_x * (1 - side * cost_frac(self.cfg, p["symbol"], "base"))
        day_s = m.days[d].isoformat()
        cid = f"{p['strategy_id']}:{p['symbol']}:{day_s}:{p['entry_bar']}:exit"
        self.broker.submit(cid, p["strategy_id"], p["symbol"], -side, p["qty"], "exit", now.isoformat(), {"reason": reason, "day": day_s})
        f = self.broker.fill_market(cid, float(px), 1e15, now.isoformat())   # exits are never size-capped: risk must come off
        meta = json.loads(p["meta"])
        fee = p["cost_usd"] + f.get("commission_usd", 0.0)
        gross = side * (raw_x - meta["raw_entry"]) * p["qty"]
        net = side * (px - p["entry_px"]) * p["qty"] - fee
        r = net / (p["qty"] * meta["stop_dist"])
        regime = int(self.ctx.fs["regime"][s, d, p["entry_bar"]])
        attr = attribute(self.ctx, p, meta, d, b, reason, gross * p["fx"], net * p["fx"], r) if net < 0 else None
        db.x("""INSERT INTO paper_trades(strategy_id,symbol,side,qty,day,d,entry_ts,exit_ts,entry_px,exit_px,gross_cad,cost_cad,net_cad,r_multiple,exit_reason,regime,explanation,attribution)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
             (p["strategy_id"], p["symbol"], side, p["qty"], day_s, d, p["entry_ts"], now.isoformat(), p["entry_px"], float(px), gross * p["fx"],
              (gross - net) * p["fx"], net * p["fx"], r, reason, regime, jd(meta.get("explanation")), jd(attr) if attr else None))
        db.x("DELETE FROM positions WHERE symbol=?", (p["symbol"],))
        return net * p["fx"]

    def _explain(self, spec, sid, s, d, b, side, dist, fx, want, qty) -> dict:
        fs, m = self.ctx.fs, self.ctx.market
        t = spec.trigger
        why = []
        if t.kind == "event":
            fired = [p for p in t.patterns if fs["ev:" + p][s, d, b] != 0]
            why.append(f"{'/'.join(fired)} detected at the close of this bar")
        elif t.kind == "feature":
            why.append(f"{t.feat} = {fs[t.feat][s, d, b]:.2f} crossed ±{t.thr:g}")
        elif t.kind == "model":
            why.append(f"model {t.model_id} score {fs['ml:' + t.model_id][s, d, b]:+.3f} crossed ±{t.thr:g}")
        for c in spec.filters:
            why.append(f"filter {c.feat} {c.op} {c.thr:g} satisfied ({fs[c.feat][s, d, b]:.2f})")
        return {"strategy": sid, "rule": spec.describe(), "direction": "long" if side > 0 else "short", "signal_ts": m.ts(d, b), "why": why,
                "regime": REGIME_NAMES[int(fs["regime"][s, d, b])],
                "sizing": {"risk_budget_cad": self.cfg.risk.risk_per_trade_cad, "stop_distance_usd": round(dist, 4), "usdcad": round(float(fx), 5),
                           "risk_sized_qty": want, "approved_qty": qty, "planned_risk_cad": round(qty * dist * fx, 2),
                           "note": "size reduced by exposure limits" if qty < want else "full risk-sized quantity",
                           "caveat": "planned risk is not a guaranteed maximum loss: gaps and slippage can exceed it"}}


def attribute(ctx: Ctx, p: dict, meta: dict, d: int, b: int, reason: str, gross_cad: float, net_cad: float, r: float) -> dict:
    """Post-mortem of one losing paper trade. Most losses are ordinary variance; a cause is named only when
    the trade's own record supports it. Attribution feeds accumulated evidence — it never triggers retraining."""
    fs, m = ctx.fs, ctx.market
    s = m.sidx(p["symbol"])
    eb = p["entry_bar"]
    causes = []
    if gross_cad > 0:
        causes.append({"cause": "execution_costs", "detail": f"gross +{gross_cad:.2f} CAD turned negative after {gross_cad - net_cad:.2f} CAD of costs"})
    if r < -1.25:
        causes.append({"cause": "gap_or_slippage", "detail": f"loss of {r:.2f}R exceeded the planned 1R (exit: {reason})"})
    rv_in = float(np.nanstd(fs["_r"][s, d, eb:b + 1])) if b > eb + 1 else float("nan")
    rv_pre = float(fs["_rv78"][s, d, max(eb - 1, 0)])
    if np.isfinite(rv_in) and np.isfinite(rv_pre) and rv_in > 1.8 * rv_pre:
        causes.append({"cause": "volatility_expansion", "detail": f"realised bar volatility during the trade was {rv_in / rv_pre:.1f}× its pre-trade level"})
    reg = int(fs["regime"][s, d, eb])
    px = m.sidx(ctx.cfg.proxy)
    day_rv = float(np.nanstd(fs["_r"][px, d]) * np.sqrt(B))
    hist = np.array([np.nanstd(fs["_r"][px, k]) * np.sqrt(B) for k in range(max(0, d - 250), d)])
    if len(hist) > 40:
        realised = 0 if (hist < day_rv).mean() < 1 / 3 else (2 if (hist < day_rv).mean() > 2 / 3 else 1)
        if abs(realised - reg) == 2:
            causes.append({"cause": "regime_misclassified", "detail": f"session was classified {REGIME_NAMES[reg]} before the open but realised as {REGIME_NAMES[realised]}"})
    rep = ctx.db.one("SELECT checks FROM skeptic_reports WHERE strategy_id=? ORDER BY id DESC LIMIT 1", (p["strategy_id"],))
    if rep:
        br = json.loads(rep["checks"])["validation"].get("by_regime", {})
        if str(reg) in br and br[str(reg)]["net_cad"] < 0:
            causes.append({"cause": "unfavourable_regime", "detail": f"the strategy also lost money in the {REGIME_NAMES[reg]} regime on validation"})
    issues = ctx.db.one("SELECT COUNT(*) n FROM data_issues WHERE day=? AND (symbol=? OR symbol IS NULL) AND severity='error'", (m.days[d].isoformat(), p["symbol"]))["n"]
    if issues:
        causes.append({"cause": "data_error", "detail": f"{issues} error-level data issue(s) recorded for this instrument and session"})
    if not causes:
        causes.append({"cause": "ordinary_variance", "detail": f"a {r:.2f}R loss with no identifiable aggravating factor; losses of this size are expected for this strategy"})
    return {"primary": causes[0]["cause"], "causes": causes}
