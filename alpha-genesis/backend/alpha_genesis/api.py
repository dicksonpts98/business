"""HTTP API + static dashboard. Every payload that carries results says what kind of data produced them."""
from __future__ import annotations
import csv, io, json, os, shutil, time
from datetime import date
from pathlib import Path
import numpy as np
from fastapi import FastAPI, HTTPException, Header, Query
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from . import jobs, liedetector, mcal, registry
from .config import BARS_PER_DAY as B, ROOT
from .db import jd
from .doppelganger import METHODS, GRID
from .features import REGIME_NAMES, STATE_FEATURES
from .runtime import Runtime

EXPORTABLE = {"strategies", "trials", "paper_trades", "orders", "fills", "promotions", "skeptic_reports", "events", "equity",
              "hypotheses", "cycles", "audit_log", "data_issues", "alerts", "holdout_ledger", "datasets", "kb_lessons"}


def create_app(rt: Runtime) -> FastAPI:
    app = FastAPI(title="ALPHA GENESIS", version="0.1.0")
    ctx, db = rt.ctx, rt.ctx.db

    def J(o):
        return JSONResponse(json.loads(jd(o)))

    def loads(rows, *cols):
        for r in rows:
            for c in cols:
                if r.get(c):
                    r[c] = json.loads(r[c])
        return rows

    def operator(token):
        need = os.environ.get("AG_OPERATOR_TOKEN")
        if need and token != need:
            raise HTTPException(403, "operator token required")

    def seg(d: int) -> str:
        ep = ctx.epoch
        if d < ep.dev_start: return "warm-up"
        if d < ep.dev_end: return "development"
        if d < ep.val_end: return "validation"
        if d < ep.holdout_end: return "holdout"
        return "forward / paper"

    def kind() -> dict:
        m = ctx.market
        return {"data_kind": m.kind, "data_label": (m.provenance or {}).get("label", m.kind.upper()),
                "data_warning": (m.provenance or {}).get("warning")}

    def candles(s: int, d0: int, d1: int) -> list[dict]:
        m, out = ctx.market, []
        for d in range(d0, d1):
            t0 = int(mcal.bar_open_utc(m.days[d], 0).timestamp())
            for b in np.where(m.valid[s, d])[0]:
                out.append({"time": t0 + int(b) * 300, "open": float(m.o[s, d, b]), "high": float(m.h[s, d, b]), "low": float(m.l[s, d, b]),
                            "close": float(m.c[s, d, b]), "volume": float(m.v[s, d, b]), "vwap": float(ctx.fs["_vwap"][s, d, b]), "d": d, "bar": int(b)})
        return out

    # ------------------------------------------------------------------ status
    def status() -> dict:
        m, ep = ctx.market, ctx.epoch
        ch = registry.champion(db)
        k = db.get_meta("kill_switch", {"on": False})
        cur = rt.worker.current
        ok, n = db.verify_audit()
        prov = rt.provider
        nxt = prov.next_session(m.days[-1])
        return {**kind(), "provenance": m.provenance, "sessions": m.D, "first_day": m.days[0].isoformat(), "last_day": m.days[-1].isoformat(),
                "next_session": nxt.isoformat() if nxt else None, "dataset_version": m.version,
                "epoch": {"id": ep.id, "development": [m.days[ep.dev_start].isoformat(), m.days[ep.dev_end - 1].isoformat()],
                          "validation": [m.days[ep.dev_end].isoformat(), m.days[ep.val_end - 1].isoformat()],
                          "holdout": [m.days[ep.val_end].isoformat(), m.days[ep.holdout_end - 1].isoformat()],
                          "forward_sessions": m.D - ep.holdout_end, "holdout_uses": ctx.holdout_uses(),
                          "holdout_budget": ctx.cfg.policy.max_holdout_uses_per_epoch},
                "engines": {r["engine"]: {"enabled": bool(r["enabled"]), **{kk: vv for kk, vv in json.loads(r["detail"]).items() if kk in ("reason", "method", "patterns")}}
                            for r in db.q("SELECT * FROM engine_status")},
                "champion": {"id": ch["id"], "description": ch["spec_obj"].describe(), "family": ch["family"]} if ch else None,
                "trading_mode": "PAPER ONLY", "paper_state": ("trading " + ch["id"]) if ch else "NOT TRADING — no strategy has qualified",
                "counts": {s["status"]: s["n"] for s in db.q("SELECT status, COUNT(*) n FROM strategies GROUP BY status")},
                "kill_switch": k, "halt": rt.engine.guardian.halted(),
                "worker": {"alive": rt.worker.is_alive(), "current": {"id": cur["id"], "kind": cur["kind"]} if cur else None,
                           "queued": db.one("SELECT COUNT(*) n FROM jobs WHERE status='queued'")["n"]},
                "provider": {"name": prov.name, "verified": prov.verified}, "broker": {"name": rt.engine.broker.name, "paper": rt.engine.broker.is_paper},
                "audit": {"chain_ok": ok, "entries": n},
                "alerts": db.q("SELECT * FROM alerts WHERE ack=0 ORDER BY id DESC LIMIT 12")}

    @app.get("/api/health")
    def health():
        return {"ok": True, "initialized": ctx.initialized, "worker": rt.worker.is_alive(), "sessions": ctx.market.D}

    @app.get("/api/status")
    def get_status():
        return J(status())

    @app.get("/api/command")
    def command():
        m, fs, D = ctx.market, ctx.fs, ctx.market.D
        with rt.lock:
            mk = []
            for s, sym in enumerate(m.symbols):
                c = m.c[s, D - 1][m.valid[s, D - 1]]
                rv = fs["_rv78"][s, D - 1][np.isfinite(fs["_rv78"][s, D - 1])]
                mk.append({"symbol": sym, "close": float(c[-1]) if len(c) else None, "day_return_pct": float((c[-1] / m.o[s, D - 1, 0] - 1) * 100) if len(c) else None,
                           "ann_vol_pct": float(rv[-1] * np.sqrt(B * 252) * 100) if len(rv) else None,
                           "events_today": db.one("SELECT COUNT(*) n FROM events WHERE symbol=? AND d=?", (sym, D - 1))["n"],
                           "spark": [float(x) for x in c[::3]]})
            reg = int(fs["regime"][0, D - 1, 0])
        eq = db.q("SELECT day, equity_cad, pnl_cad, strategy_id FROM equity ORDER BY d")
        last = eq[-1] if eq else None
        L = ctx.cfg.risk
        ps = loads(db.q("SELECT payload FROM metrics WHERE kind='paper_session' ORDER BY id DESC LIMIT 1"), "payload")
        cyc = db.one("SELECT id, stage, status, trigger FROM cycles WHERE status IN ('running','queued') ORDER BY id DESC LIMIT 1")
        disc = loads(db.q("SELECT id, family, statement, status, cycle_id FROM hypotheses WHERE status IN ('supported_on_validation','rejected') ORDER BY id DESC LIMIT 8"))
        return J({**status(), "market": {"regime": REGIME_NAMES[reg], "trend": int(fs["mkt_trend"][0, D - 1, 0]), "instruments": mk, "session": m.days[-1].isoformat()},
                  "portfolio": {"equity_cad": last["equity_cad"] if last else L.starting_capital_cad, "start_cad": L.starting_capital_cad, "last_pnl_cad": last["pnl_cad"] if last else 0.0,
                                "curve": [{"day": e["day"], "equity": e["equity_cad"]} for e in eq], "label": "paper trading" + (" on SYNTHETIC data" if m.kind == "synthetic" else "")},
                  "risk": {"limits": L.as_dict(), "last_session": ps[0]["payload"] if ps else None,
                           "daily_loss_used_pct": float(min(100, max(0, -(last["pnl_cad"] if last else 0)) / L.max_daily_loss_cad * 100)),
                           "entries_used_pct": float((ps[0]["payload"]["entries"] if ps else 0) / L.max_entries_per_day * 100)},
                  "research": {"active_cycle": cyc, "last_cycles": loads(db.q("SELECT id, epoch, status, stage, trigger, started, finished, summary FROM cycles ORDER BY id DESC LIMIT 4"), "summary")},
                  "discoveries": disc, "promotions": db.q("SELECT * FROM promotions ORDER BY id DESC LIMIT 8")})

    # ------------------------------------------------------------------ market radar
    @app.get("/api/days")
    def days():
        m = ctx.market
        reg = ctx.fs["regime"][0, :, 0]
        return J({"days": [{"d": d, "day": m.days[d].isoformat(), "regime": int(reg[d]), "segment": seg(d)} for d in range(m.D)], **kind()})

    @app.get("/api/market/bars")
    def bars(symbol: str, day: str | None = None, n: int = Query(1, ge=1, le=10)):
        m = ctx.market
        with rt.lock:
            d1 = (m.didx(date.fromisoformat(day)) if day else m.D - 1) + 1
            d0 = max(0, d1 - n)
            s = m.sidx(symbol)
            f = ctx.fs
            ev = loads(db.q("SELECT * FROM events WHERE symbol=? AND d>=? AND d<? ORDER BY d, bar", (symbol, d0, d1)), "context")
            for e in ev:
                e["time"] = int(mcal.bar_open_utc(m.days[e["d"]], e["bar"]).timestamp())
            lv = {k: (None if not np.isfinite(f[k2][s, d1 - 1, B - 1]) else float(f[k2][s, d1 - 1, B - 1])) for k, k2 in
                  (("or_high", "_orh"), ("or_low", "_orl"), ("prev_high", "_pdh"), ("prev_low", "_pdl"))}
            return J({**kind(), "symbol": symbol, "segment": seg(d1 - 1), "regime": REGIME_NAMES[int(f["regime"][s, d1 - 1, 0])], "day": m.days[d1 - 1].isoformat(),
                      "candles": candles(s, d0, d1), "events": ev, "levels": lv})

    @app.get("/api/market/radar")
    def radar():
        m, f, D = ctx.market, ctx.fs, ctx.market.D
        out = []
        with rt.lock:
            for s, sym in enumerate(m.symbols):
                def last(k):
                    a = f[k][s, D - 1]
                    a = a[np.isfinite(a)]
                    return float(a[-1]) if len(a) else None
                rvd = [float(np.nanstd(f["_r"][s, d]) * np.sqrt(B * 252) * 100) for d in range(max(0, D - 60), D)]
                out.append({"symbol": sym, "candles": candles(s, D - 2, D), "vol_history_pct": rvd,
                            "state": {k: last(k) for k in ("vwap_z", "ret_day_z", "rel_vol", "vol_ratio", "range_pos", "trend_z", "mkt_rs_z", "gap_z")},
                            "events": loads(db.q("SELECT id, bar, d, pattern, direction, ts FROM events WHERE symbol=? AND d>=? ORDER BY d, bar", (sym, D - 2)))})
            regs = f["regime"][0, max(0, D - 120):D, 0].astype(int).tolist()
        return J({**kind(), "segment": seg(D - 1), "day": m.days[-1].isoformat(), "regime": REGIME_NAMES[regs[-1]], "regime_history": regs,
                  "regime_definition": "tercile of trailing 20-session realised volatility of the market proxy vs its trailing 250-session history; known before the open",
                  "instruments": out})

    # ------------------------------------------------------------------ historical twins
    @app.get("/api/twins")
    def twins(symbol: str, day: str | None = None, bar: int = 40, method: str = "knn_z"):
        m = ctx.market
        if method not in METHODS:
            raise HTTPException(400, "unknown method")
        with rt.lock:
            d = m.didx(date.fromisoformat(day)) if day else m.D - 1
            s = m.sidx(symbol)
            q = ctx.dop.query(m, ctx.fs, s, d, bar, method)
            if q.get("available"):
                def path(ss, dd, bb):
                    c = m.c[ss, dd]
                    ref = c[bb]
                    return [None if not np.isfinite(x) else float((x / ref - 1) * 1e4) for x in c[max(0, bb - 24):min(B, bb + 13)]]
                q["current_path_bps"] = path(s, d, q["bar"])
                for mt in q["matches"][:8]:
                    mt["path_bps"] = path(m.sidx(mt["symbol"]), mt["d"], mt["bar"])
                    mt["segment"] = seg(mt["d"])
            st = ctx.engine("doppelganger")
            return J({**kind(), "segment": seg(d), "query": q, "engine": st, "methods": METHODS, "features": STATE_FEATURES,
                      "grid_bars": GRID.tolist()})

    # ------------------------------------------------------------------ trap detector
    @app.get("/api/events")
    def events(symbol: str | None = None, pattern: str | None = None, day: str | None = None, limit: int = Query(200, le=1000)):
        q, a = "SELECT * FROM events WHERE 1=1", []
        for col, v in (("symbol", symbol), ("pattern", pattern), ("day", day)):
            if v:
                q += f" AND {col}=?"
                a.append(v)
        rows = loads(db.q(q + " ORDER BY d DESC, bar DESC LIMIT ?", (*a, limit)), "context")
        for r in rows:
            r["segment"] = seg(r["d"])
        return J({**kind(), "events": rows, "patterns": liedetector.PATTERNS,
                  "counts": db.q("SELECT pattern, COUNT(*) n FROM events GROUP BY pattern ORDER BY n DESC")})

    @app.get("/api/events/stats")
    def event_stats():
        ep, m = ctx.epoch, ctx.market
        cost = {s: ctx.cfg.instrument(s)["half_spread_bps"] + ctx.cfg.alpha["execution"]["slippage_bps"] for s in m.symbols}
        with rt.lock:
            st = liedetector.outcome_stats(m, ctx.fs, ep.dev_start, ep.val_end, cost)
        return J({**kind(), "segment": "development + validation (the holdout is not shown)", "stats": st,
                  "note": "Fade-direction return in basis points from the next bar's open. 'net' subtracts modelled round-trip spread and slippage (no commissions)."})

    @app.get("/api/events/{eid}/replay")
    def replay(eid: int):
        e = db.one("SELECT * FROM events WHERE id=?", (eid,))
        if not e:
            raise HTTPException(404)
        e["context"] = json.loads(e["context"])
        m = ctx.market
        with rt.lock:
            s, d, b = m.sidx(e["symbol"]), e["d"], e["bar"]
            cs = candles(s, d, d + 1)
            f = ctx.fs
            lv = {k: (None if not np.isfinite(f[k2][s, d, b]) else float(f[k2][s, d, b])) for k, k2 in
                  (("or_high", "_orh"), ("or_low", "_orl"), ("prev_high", "_pdh"), ("prev_low", "_pdl"), ("vwap", "_vwap"), ("session_high", "_dh"), ("session_low", "_dl"))}
            eb = b + 1
            outcome = None
            if eb < B and np.isfinite(m.o[s, d, eb]):
                o = m.o[s, d, eb]
                outcome = {f"{h}_bars_bps": (None if not np.isfinite(m.c[s, d, min(eb + h - 1, B - 1)]) else float(e["direction"] * np.log(m.c[s, d, min(eb + h - 1, B - 1)] / o) * 1e4)) for h in (6, 12, 24)}
                outcome["entry_px"], outcome["entry_time"] = float(o), int(mcal.bar_open_utc(m.days[d], eb).timestamp())
        return J({**kind(), "segment": seg(d), "event": e, "definition": liedetector.PATTERNS[e["pattern"]],
                  "known_at_detection": [c for c in cs if c["bar"] <= b], "after_detection": [c for c in cs if c["bar"] > b], "levels_at_detection": lv,
                  "regime": REGIME_NAMES[int(f["regime"][s, d, b])], "outcome": outcome,
                  "entry_rule": "earliest executable price is the next bar's open; the invalidation level is the extreme printed during the failed move",
                  "detected_at": e["ts"]})

    # ------------------------------------------------------------------ darwin lab
    @app.get("/api/darwin")
    def darwin_lab():
        cyc = loads(db.q("SELECT id, epoch, status, stage, trigger, started, finished, summary FROM cycles ORDER BY id DESC LIMIT 30"), "summary")
        strat = db.q("SELECT id, name, version, family, parent_id, cycle_id, epoch, status, hypothesis, created, spec FROM strategies WHERE status!='BASELINE' ORDER BY created")
        for s in strat:
            from .dsl import StrategySpec
            s["description"] = StrategySpec.model_validate(json.loads(s.pop("spec"))).describe()
        fam = db.q("SELECT family, origin, COUNT(*) n, MAX(json_extract(dev,'$.fitness')) best FROM trials GROUP BY family, origin")
        return J({**kind(), "cycles": cyc, "queue": db.q("SELECT id, kind, status, attempts, created, started, error FROM jobs WHERE status IN ('queued','running') ORDER BY id"),
                  "hypotheses": loads(db.q("SELECT * FROM hypotheses ORDER BY id DESC LIMIT 60"), "evidence"), "genealogy": strat,
                  "trial_counts": fam, "total_trials": db.one("SELECT COUNT(*) n FROM trials")["n"],
                  "knowledge": {"families": db.q("SELECT * FROM kb_family"), "lessons": loads(db.q("SELECT * FROM kb_lessons ORDER BY id DESC LIMIT 40"), "elements")},
                  "models": loads(db.q("SELECT id, kind, version, epoch, train_end, sha, metrics, created FROM models ORDER BY created DESC"), "metrics"),
                  "budget": ctx.cfg.alpha["darwin"], "segment": "development (search) and validation (shortlist test)"})

    @app.get("/api/darwin/cycle/{cid}")
    def cycle(cid: int):
        c = db.one("SELECT * FROM cycles WHERE id=?", (cid,))
        if not c:
            raise HTTPException(404)
        loads([c], "summary", "state")
        tr = loads(db.q("SELECT id, spec_hash, family, origin, generation, spec, dev, val, stage FROM trials WHERE cycle_id=? ORDER BY json_extract(dev,'$.fitness') DESC LIMIT 80", (cid,)), "spec", "dev", "val")
        from .dsl import StrategySpec
        for t in tr:
            sp = {k: v for k, v in t["spec"].items() if not k.startswith("_")}
            t["description"] = StrategySpec.model_validate(sp).describe()
        gens = db.q("SELECT generation g, COUNT(*) n, MAX(json_extract(dev,'$.fitness')) best, AVG(json_extract(dev,'$.fitness')) mean FROM trials WHERE cycle_id=? GROUP BY generation ORDER BY g", (cid,))
        return J({**kind(), "cycle": c, "trials": tr, "generations": gens, "hypotheses": loads(db.q("SELECT * FROM hypotheses WHERE cycle_id=?", (cid,)), "evidence")})

    # ------------------------------------------------------------------ arena / skeptic
    @app.get("/api/arena")
    def get_arena():
        r = db.one("SELECT * FROM arena_runs ORDER BY id DESC LIMIT 1")
        return J({**kind(), "arena": json.loads(r["results"]) if r else None, "ts": r["ts"] if r else None,
                  "promotions": loads(db.q("SELECT * FROM promotions ORDER BY id DESC LIMIT 60"), "evidence"),
                  "policy": {k: v for k, v in ctx.cfg.policy.as_dict().items() if k in ("min_shadow_days", "promote_min_prob_beats_champion", "quarantine_min_trades", "quarantine_p")}})

    @app.get("/api/strategy/{sid}/trades")
    def strat_trades(sid: str, window: str = "validation"):
        row = registry.get(db, sid)
        if not row:
            raise HTTPException(404)
        ep, m = ctx.epoch, ctx.market
        used = db.one("SELECT 1 FROM holdout_ledger WHERE epoch=? AND subject=?", (ep.id, sid)) or row["status"] == "BASELINE"
        rng = {"validation": ep.part("val"), "forward": (ep.holdout_end, m.D), "holdout": ep.part("holdout")}[window]
        if window == "holdout" and not used:
            raise HTTPException(403, "this strategy has not been granted a holdout evaluation")
        with rt.lock:
            r = ctx.backtest(row["spec_obj"], *rng)
        tr = [{**t, "symbol": m.symbols[t["s"]], "day": m.days[t["d"]].isoformat()} for t in r.trades[-300:]]
        return J({**kind(), "segment": window, "strategy": sid, "metrics": r.metrics, "trades": tr, "lineage": registry.lineage(db, sid)})

    @app.get("/api/skeptic")
    def get_skeptic():
        reps = db.q("SELECT id, strategy_id, cycle_id, verdict, checks, policy_sha, created FROM skeptic_reports ORDER BY id DESC LIMIT 60")
        for r in reps:
            c = json.loads(r.pop("checks"))
            r["failed"], r["warnings"] = c["failed"], [x["check"] for x in c["checks"] if x["status"] == "warn"]
            r["summary"] = {x["check"]: x["status"] for x in c["checks"]}
        ab = db.one("SELECT * FROM ablations ORDER BY id DESC LIMIT 1")
        fails = {}
        for r in reps:
            for f in r["failed"]:
                fails[f] = fails.get(f, 0) + 1
        return J({**kind(), "reports": reps, "failure_counts": fails, "policy": ctx.cfg.policy.as_dict(), "policy_sha": ctx.cfg.policy.sha,
                  "ablation": json.loads(ab["results"]) if ab else None, "ablation_ts": ab["ts"] if ab else None,
                  "holdout_ledger": db.q("SELECT * FROM holdout_ledger ORDER BY id DESC LIMIT 50"),
                  "lessons": loads(db.q("SELECT * FROM kb_lessons WHERE lesson LIKE 'skeptic%' ORDER BY id DESC LIMIT 30"), "elements")})

    @app.get("/api/skeptic/report/{rid}")
    def report(rid: int):
        r = db.one("SELECT * FROM skeptic_reports WHERE id=?", (rid,))
        if not r:
            raise HTTPException(404)
        r["checks"] = json.loads(r["checks"])
        s = registry.get(db, r["strategy_id"])
        return J({**kind(), "report": r, "strategy": {"id": s["id"], "description": s["spec_obj"].describe(), "status": s["status"], "hypothesis": s["hypothesis"],
                                                      "spec": json.loads(s["spec"])}, "segment": "validation (+ one holdout look for survivors)"})

    # ------------------------------------------------------------------ paper trading
    @app.get("/api/paper")
    def paper():
        L = ctx.cfg.risk
        eq = db.q("SELECT * FROM equity ORDER BY d")
        tr = loads(db.q("SELECT * FROM paper_trades ORDER BY id DESC LIMIT 200"), "explanation", "attribution")
        attr = {}
        for r in db.q("SELECT attribution FROM paper_trades WHERE attribution IS NOT NULL"):
            k = json.loads(r["attribution"])["primary"]
            attr[k] = attr.get(k, 0) + 1
        agg = db.one("SELECT COUNT(*) n, SUM(net_cad) net, SUM(cost_cad) cost, SUM(gross_cad) gross, AVG(r_multiple) r, SUM(net_cad>0) wins FROM paper_trades")
        pos = db.q("SELECT * FROM positions")
        return J({**kind(), "segment": "paper trading (forward sessions)", "mode": "PAPER ONLY — no live order routing exists in this build",
                  "equity": eq, "positions": pos, "trades": tr, "orders": loads(db.q("SELECT * FROM orders ORDER BY id DESC LIMIT 150"), "meta"),
                  "summary": agg, "loss_attribution": attr, "limits": L.as_dict(), "limits_sha": L.sha, "halt": rt.engine.guardian.halted(),
                  "sessions": loads(db.q("SELECT day, payload FROM metrics WHERE kind='paper_session' ORDER BY id DESC LIMIT 60"), "payload"),
                  "log": loads(db.q("SELECT id, ts, actor, action, detail FROM audit_log WHERE actor IN ('guardian','paper','operator','health') ORDER BY id DESC LIMIT 120"), "detail"),
                  "exposure_cad": sum(p["qty"] * p["entry_px"] * p["fx"] for p in pos)})

    # ------------------------------------------------------------------ learning monitor
    @app.get("/api/learning")
    def learning_monitor():
        m = ctx.market
        last = db.one("SELECT * FROM cycles WHERE status='done' ORDER BY id DESC LIMIT 1")
        L = ctx.cfg.alpha["learning"]
        since = m.D - db.get_meta("last_cycle_session", m.D)
        sched = db.q("SELECT * FROM schedules")
        return J({**kind(), "last_cycle": loads([last], "summary")[0] if last else None,
                  "next_evaluation": {"sessions_until_scheduled_cycle": max(0, L["evolve_every_sessions"] - since), "rule": f"every {L['evolve_every_sessions']} sessions, or on drift in ≥3 features, or on champion quarantine",
                                      "forward_sessions": m.D - ctx.epoch.holdout_end, "new_epoch_at": L["min_holdout_days"]},
                  "schedules": sched,
                  "drift": loads(db.q("SELECT day, payload FROM metrics WHERE kind='drift' ORDER BY id DESC LIMIT 120"), "payload")[::-1],
                  "predictions": loads(db.q("SELECT day, payload FROM metrics WHERE kind='prediction_quality' ORDER BY id DESC LIMIT 120"), "payload")[::-1],
                  "health": loads(db.q("SELECT day, payload FROM metrics WHERE kind='champion_health' ORDER BY id DESC LIMIT 120"), "payload")[::-1],
                  "sessions": loads(db.q("SELECT day, payload FROM metrics WHERE kind='session_close' ORDER BY id DESC LIMIT 40"), "payload"),
                  "counts": {"sessions_ingested_since_start": db.one("SELECT COUNT(*) n FROM metrics WHERE kind='session_close'")["n"],
                             "cycles_completed": db.one("SELECT COUNT(*) n FROM cycles WHERE status='done'")["n"],
                             "hypotheses": db.one("SELECT COUNT(*) n FROM hypotheses")["n"], "trials": db.one("SELECT COUNT(*) n FROM trials")["n"],
                             "candidates_reviewed": db.one("SELECT COUNT(*) n FROM skeptic_reports")["n"],
                             "approved": db.one("SELECT COUNT(*) n FROM skeptic_reports WHERE verdict='APPROVED'")["n"],
                             "promotions": db.one("SELECT COUNT(*) n FROM promotions WHERE to_status='CHAMPION'")["n"],
                             "quarantines": db.one("SELECT COUNT(*) n FROM promotions WHERE to_status='QUARANTINED'")["n"],
                             "models": db.one("SELECT COUNT(*) n FROM models")["n"], "epochs": db.one("SELECT COUNT(*) n FROM epochs")["n"]},
                  "jobs": db.q("SELECT id, kind, status, attempts, created, started, finished, error FROM jobs ORDER BY id DESC LIMIT 40"),
                  "failed_jobs": db.q("SELECT id, kind, attempts, error, finished FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 20"),
                  "recovery_log": db.q("SELECT * FROM recovery_log ORDER BY id DESC LIMIT 40"),
                  "epochs": db.q("SELECT * FROM epochs ORDER BY id"), "data_issues": db.q("SELECT * FROM data_issues ORDER BY id DESC LIMIT 40")})

    # ------------------------------------------------------------------ settings
    @app.get("/api/settings")
    def settings():
        du = shutil.disk_usage(ctx.cfg.data_dir)
        mem = {}
        try:
            for line in Path("/proc/meminfo").read_text().splitlines()[:3]:
                k, v = line.split(":")
                mem[k] = int(v.strip().split()[0]) // 1024
        except Exception:
            pass
        size = sum(f.stat().st_size for f in ctx.cfg.data_dir.rglob("*") if f.is_file())
        return J({**kind(), "config": ctx.cfg.alpha, "risk": ctx.cfg.risk.as_dict(), "policy": ctx.cfg.policy.as_dict(),
                  "providers": [{"name": "synthetic-simulated-feed", "status": "verified (automated tests)", "active": rt.provider.name == "synthetic-simulated-feed"},
                                {"name": "local-files (CSV / Parquet import)", "status": "verified (automated tests)", "active": rt.provider.name == "local-files"},
                                {"name": "alpaca (market data)", "status": "UNVERIFIED — adapter written, never connected", "active": rt.provider.name == "alpaca",
                                 "credentials_present": bool(ctx.cfg.secret("ALPACA_API_KEY") and ctx.cfg.secret("ALPACA_API_SECRET"))}],
                  "mcp": [{"name": "alphavantage-mcp (https://mcp.alphavantage.co/mcp)", "active": rt.provider.name == "alphavantage-mcp",
                           "credentials_present": bool(ctx.cfg.secret("ALPHAVANTAGE_API_KEY")),
                           "status": "handshake, auth, daily bars and USD/CAD verified live; 5-minute bars need a paid Alpha Vantage plan (UNVERIFIED)"}],
                  "brokers": [{"name": "internal-paper", "status": "verified (automated tests)", "active": True},
                              {"name": "alpaca-paper", "status": "UNVERIFIED — adapter written, never connected", "active": False},
                              {"name": "live trading", "status": "NOT IMPLEMENTED — requires separate authorisation and review", "active": False}],
                  "datasets": db.q("SELECT * FROM datasets ORDER BY id DESC LIMIT 15"), "schedules": db.q("SELECT * FROM schedules"),
                  "hardware": {"cpus": os.cpu_count(), "memory_mb": mem, "disk_free_gb": round(du.free / 1e9, 1), "data_dir_mb": round(size / 1e6, 1), "load": os.getloadavg()},
                  "exportable": sorted(EXPORTABLE), "operator_token_required": bool(os.environ.get("AG_OPERATOR_TOKEN")),
                  "backups": sorted(p.name for p in (ctx.cfg.data_dir / "backups").glob("*")) if (ctx.cfg.data_dir / "backups").exists() else []})

    @app.get("/api/export/{table}.csv")
    def export(table: str):
        if table not in EXPORTABLE:
            raise HTTPException(404)
        rows = db.q(f"SELECT * FROM {table}")
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
        return PlainTextResponse(buf.getvalue(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="{table}.csv"'})

    # ------------------------------------------------------------------ controls (operator)
    @app.post("/api/control/advance")
    def advance(n: int = Query(1, ge=1, le=250), x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        ids = [jobs.enqueue(db, "session_close", {"i": i, "t": time.time()}) for i in range(n)]
        return {"queued": len([i for i in ids if i])}

    @app.post("/api/control/cycle")
    def run_cycle(x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        return {"job": jobs.enqueue(db, "research_cycle", {"trigger": "operator request"}, "cycle:manual")}

    @app.post("/api/control/ablation")
    def run_ablation(x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        return {"job": jobs.enqueue(db, "ablation", {}, "ablation")}

    @app.post("/api/control/kill")
    def kill(on: bool, reason: str = "operator", x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        rt.engine.guardian.kill(on, "operator", reason)
        return {"kill_switch": db.get_meta("kill_switch")}

    @app.post("/api/control/clear-halt")
    def clear_halt(x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        rt.engine.guardian.clear_reconciliation_halt("operator")
        return {"halt": rt.engine.guardian.halted()}

    @app.post("/api/control/schedule")
    def schedule(interval_seconds: float = Query(..., ge=0), x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        jobs.set_schedule(db, "session_feed", "session_close", interval_seconds if interval_seconds > 0 else 3600, enabled=interval_seconds > 0)
        db.audit("operator", "schedule.changed", {"session_feed_interval_s": interval_seconds})
        return {"schedules": db.q("SELECT * FROM schedules")}

    @app.post("/api/control/rollback")
    def rollback(reason: str = "operator rollback", x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        return {"restored": registry.rollback(db, ctx.cfg, reason, actor="operator")}

    @app.post("/api/control/backup")
    def backup(x_operator_token: str | None = Header(None)):
        operator(x_operator_token)
        return {"backup": make_backup(ctx)}

    @app.post("/api/alerts/ack")
    def ack():
        db.x("UPDATE alerts SET ack=1 WHERE ack=0")
        return {"ok": True}

    dist = ROOT / "frontend" / "dist"
    if dist.exists():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}")
        def spa(path: str):
            f = dist / path
            return FileResponse(f if path and f.is_file() else dist / "index.html")
    return app


def make_backup(ctx) -> str:
    """Consistent snapshot of the database (SQLite online backup) and the bar store."""
    import sqlite3
    dest = ctx.cfg.data_dir / "backups" / time.strftime("%Y%m%d-%H%M%S")
    dest.mkdir(parents=True, exist_ok=True)
    out = sqlite3.connect(dest / "alpha_genesis.sqlite")
    ctx.db.conn.backup(out)
    out.close()
    shutil.copytree(ctx.bars_dir, dest / "bars")
    if (ctx.cfg.data_dir / "models").exists():
        shutil.copytree(ctx.cfg.data_dir / "models", dest / "models")
    ctx.db.audit("operator", "backup.created", {"path": str(dest)})
    return str(dest)
