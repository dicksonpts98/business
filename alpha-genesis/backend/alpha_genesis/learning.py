"""Autonomous self-learning service: the post-session pipeline, drift and health monitoring, epoch
rolling with retraining, the checkpointed research cycle, and controlled engine-contribution ablations.

Everything here runs as ordinary jobs (see jobs.py) against persisted state. No language model is
involved at run time."""
from __future__ import annotations
import json, time
from datetime import date, timedelta
import numpy as np
from scipy import stats as ss
from . import arena, darwin, liedetector, models, registry, skeptic, stats
from .config import BARS_PER_DAY as B
from .core import Ctx
from .db import jd
from .dsl import StrategySpec, Trigger
from .features import STATE_FEATURES, forward_labels
from .market import Market
from .paper import InjectedCrash, PaperEngine
from .providers import AlphaVantageMcpProvider, ChainProvider, FileProvider, Provider, SimulatedFeed, ingest_session
from .synthetic import generate

STAGES = ["observe", "evolve", "tune", "validate", "skeptic", "finalize"]


# ------------------------------------------------------------------ bootstrap
def alpaca_history(ctx: Ctx, transport=None):
    from .alpaca import AlpacaClient, AlpacaHistory, BankOfCanadaFx
    d = ctx.cfg.alpha["data"]
    fx = BankOfCanadaFx(ctx.cfg.data_dir / "raw" / "fx_usdcad_bankofcanada.parquet") if d.get("fx_source", "bankofcanada") == "bankofcanada" else None
    client = AlpacaClient(ctx.cfg.secret("APCA_API_KEY_ID"), ctx.cfg.secret("APCA_API_SECRET_KEY"), transport=transport)
    return AlpacaHistory(ctx.cfg.data_dir / "raw" / "alpaca", client, tuple(d.get("feeds", ["sip", "iex"])), fx)


def make_provider(ctx: Ctx) -> Provider:
    d = ctx.cfg.alpha["data"]
    kind = d["provider"]
    live: Provider | None
    if kind == "synthetic":
        return SimulatedFeed(ctx.reserve_dir)
    if kind in ("csv", "parquet"):
        live = FileProvider(d["path"], d.get("timezone"))
    elif kind == "alpaca":
        live = alpaca_history(ctx)
    elif kind == "alphavantage_mcp":
        live = AlphaVantageMcpProvider(ctx.cfg.secret("ALPHAVANTAGE_API_KEY"))
    else:
        raise ValueError(f"unknown data provider {kind!r}")
    if (ctx.reserve_dir / "_manifest.json").exists():      # held-back real sessions are replayed before going live
        return ChainProvider(SimulatedFeed(ctx.reserve_dir), live)
    return live


def bootstrap(ctx: Ctx, log=print) -> Ctx:
    """First-time initialisation; safe to call again (does nothing once initialised)."""
    if ctx.initialized:
        return ctx.load()
    d = ctx.cfg.alpha["data"]
    if d["provider"] == "synthetic":
        log("generating SYNTHETIC market (labelled; not historical data)…")
        full = generate(ctx.cfg.symbols, d["synthetic_days"], d["synthetic_seed"], plant_orb=d.get("synthetic_plant_orb", 0.3),
                        plant_vwap=d.get("synthetic_plant_vwap", 0.04), decay_start=d.get("synthetic_decay_start"))
        full.save(ctx.reserve_dir)
        m = full.truncated(d["synthetic_initial_days"])
    elif d["provider"] in ("csv", "parquet", "alpaca"):
        from datetime import date as _date
        if d["provider"] == "alpaca":
            src = alpaca_history(ctx)
            start = _date.fromisoformat(d.get("history_start", "2023-01-03"))
            log(f"downloading Alpaca 5-minute history from {start} (incremental; cached months are reused)…")
            rep = src.update(ctx.cfg.symbols, start, log=log)
            if src.fx is not None:
                src.fx.try_update(start - timedelta(days=10), log)
            days = src.all_days(ctx.cfg.symbols, start, src.today)
            ctx.db.set_meta("provider_report", rep)
            prov = {"label": "HISTORICAL", "source": "Alpaca Market Data v2", "feeds": sorted({v for v in src.manifest["feed_used"].values()}),
                    "adjustment": "split", "fx": "Bank of Canada FXUSDCAD (previous business day)", "restrictions": src.manifest["restrictions"][:5]}
        else:
            src = FileProvider(d["path"], d.get("timezone"))
            days = src.all_days(ctx.cfg.symbols)
            prov = {"label": "HISTORICAL", "source": str(d["path"]), "note": d.get("note", "user-supplied files")}
        if len(days) < 200:
            raise RuntimeError(f"need at least 200 sessions of history to initialise; found {len(days)}")
        full = Market(ctx.cfg.symbols, [], "historical", prov)
        for day in days:
            ingest_session(full, src, day, ctx.db)
        for i in getattr(src, "issues", []):
            ctx.db.x("INSERT INTO data_issues(ts,symbol,day,kind,severity,detail) VALUES(?,?,?,?,?,?)", (time.time(), i["symbol"], i["day"], i["kind"], i["severity"], i["detail"]))
        hold = int(d.get("replay_reserve_days", 0))
        if hold > 0:      # controlled sequential test on REAL data: the last sessions arrive one at a time
            full.provenance = {**prov, "replay_reserve_days": hold}
            full.save(ctx.reserve_dir)
            m = full.truncated(full.D - hold)
        else:
            m = full
    else:
        raise RuntimeError(f"cannot initialise from provider {d['provider']!r}: use 'synthetic', 'csv', 'parquet' or 'alpaca'")
    m.save(ctx.bars_dir, ctx.db)
    log("building features, detecting patterns, computing historical similarity…")
    ctx.load()
    ctx.store_events(liedetector.detect(ctx.market, ctx.fs))
    ep = ctx.new_epoch()
    ctx.gate_doppelganger()
    log("training first models…")
    retrain(ctx)
    ctx.ensure_baselines()
    ctx.set_engine("liedetector", True, {"patterns": len(liedetector.PATTERN_IDS)})
    ctx.db.set_meta("last_cycle_session", ctx.market.D)
    ctx.db.audit("system", "bootstrap", {"sessions": ctx.market.D, "kind": ctx.market.kind, "epoch": ep.id})
    return ctx


def retrain(ctx: Ctx) -> list[str]:
    """Train the next immutable version of each model on the current epoch's development sessions."""
    ep = ctx.epoch
    ids = []
    for kind in models.KINDS:
        mid = models.train(kind, ctx.market, ctx.fs, ep.dev_end, ctx.cfg.data_dir / "models", ctx.db, ep.id, seed=ep.id)
        models.write_scores(ctx.db, ctx.fs, mid, ctx.market.D)
        ids.append(mid)
    ctx.db.audit("learning", "models.trained", {"epoch": ep.id, "models": ids, "train_sessions": [0, ep.dev_end]})
    return ids


def epoch_models(ctx: Ctx) -> list[str]:
    return [r["id"] for r in ctx.db.q("SELECT id FROM models WHERE epoch=? ORDER BY id", (ctx.epoch.id,))]


# ------------------------------------------------------------------ monitoring
def drift(ctx: Ctx) -> dict:
    """Population-stability index of the market-state features: development reference vs the latest sessions."""
    ep, w = ctx.epoch, ctx.cfg.alpha["learning"]["drift_window_days"]
    D = ctx.market.D
    out = {}
    for f in STATE_FEATURES:
        if f == "tod":
            continue
        out[f] = stats.psi(ctx.fs[f][:, ep.dev_start:ep.dev_end].ravel(), ctx.fs[f][:, D - w:D].ravel())
    flagged = [k for k, v in out.items() if v == v and v > 0.25]
    res = {"psi": out, "flagged": flagged, "window_sessions": w, "threshold": 0.25, "session": D}
    ctx.db.metric("drift", res, ctx.market.days[-1].isoformat())
    return res


def prediction_quality(ctx: Ctx) -> dict:
    """Score earlier predictions against outcomes that have now completed."""
    m, D, ep = ctx.market, ctx.market.D, ctx.epoch
    out = {"session": D, "models": {}}
    fwd, _ = forward_labels(m, 12)
    w0 = max(ep.val_end, D - 40)
    y = (fwd[:, w0:D] > 0)
    okl = np.isfinite(fwd[:, w0:D])
    for mid in epoch_models(ctx):
        sc = ctx.fs["ml:" + mid]
        p = sc[:, w0:D] + 0.5
        ok = okl & np.isfinite(p)
        vv = np.isfinite(sc[:, ep.dev_end:ep.val_end]) & np.isfinite(fwd[:, ep.dev_end:ep.val_end])
        if ok.sum() > 200 and vv.sum() > 200:
            brier = float(((p[ok] - y[ok]) ** 2).mean())
            pv, yv = sc[:, ep.dev_end:ep.val_end][vv] + 0.5, (fwd[:, ep.dev_end:ep.val_end][vv] > 0)
            out["models"][mid] = {"recent_brier": brier, "validation_brier": float(((pv - yv) ** 2).mean()),
                                  "recent_base_brier": float(((y[ok].mean() - y[ok]) ** 2).mean()), "n": int(ok.sum())}
    if D - ep.val_end >= 20:
        ev = ctx.dop.evaluate(max(ep.val_end, D - 120), D)
        st = ctx.engine("doppelganger") or {}
        meth = st.get("method", "knn_z")
        out["doppelganger"] = {k: ev[meth].get(k) for k in ("n", "ic", "ic_ci90", "brier_skill", "pass", "reason")}
        out["doppelganger"]["method"] = meth
    ctx.db.metric("prediction_quality", out, m.days[-1].isoformat())
    return out


def champion_health(ctx: Ctx) -> dict | None:
    """Quarantine the champion only on statistically supported deterioration of its paper results
    relative to its own validation record — never because of a handful of losses."""
    pol, db = ctx.cfg.policy, ctx.db
    ch = registry.champion(db)
    if not ch:
        return None
    since = db.one("SELECT MAX(ts) t FROM promotions WHERE strategy_id=? AND to_status='CHAMPION'", (ch["id"],))["t"]
    first_d = db.one("SELECT MIN(d) d FROM equity WHERE strategy_id=?", (ch["id"],))["d"]
    rs = np.array([r["r_multiple"] for r in db.q("SELECT r_multiple FROM paper_trades WHERE strategy_id=? AND d>=? ORDER BY id", (ch["id"], first_d or 0))])
    ep = ctx.epoch
    val = ctx.backtest(ch["spec_obj"], *ep.part("val")) if ch["epoch"] == ep.id else ctx.backtest(ch["spec_obj"], ep.dev_start, ep.val_end)
    vr = np.array([t["r"] for t in val.trades])
    res = {"strategy": ch["id"], "paper_trades": int(len(rs)), "paper_mean_r": float(rs.mean()) if len(rs) else None,
           "reference_mean_r": float(vr.mean()) if len(vr) else None, "status": "healthy"}
    if len(rs) >= pol.quarantine_min_trades and len(vr) >= 10:
        # Two looks, Bonferroni-corrected: the whole paper record, and only the most recent trades (so an edge
        # that has just died is not hidden behind an earlier good stretch).
        def one_sided(x):
            t, p2 = ss.ttest_ind(x, vr, equal_var=False)
            return float(p2 / 2 if t < 0 else 1 - p2 / 2)
        recent = rs[-2 * pol.quarantine_min_trades:]
        p_all, p_rec = one_sided(rs), one_sided(recent)
        res.update(p_deteriorated=min(p_all, p_rec), p_all=p_all, p_recent=p_rec, recent_mean_r=float(recent.mean()), recent_trades=int(len(recent)))
        hit = [(p_all, rs, "all")] if (p_all < pol.quarantine_p / 2 and rs.mean() < 0) else []
        if p_rec < pol.quarantine_p / 2 and recent.mean() < 0:
            hit.append((p_rec, recent, "most recent"))
        if hit:
            p, x, which = min(hit, key=lambda h: h[0])
            res["status"] = "quarantined"
            restored = registry.rollback(db, ctx.cfg, f"paper expectancy {x.mean():.2f}R over the {which} {len(x)} trades is below reference {vr.mean():.2f}R (p={p:.4f})",
                                         actor="health", to_status="QUARANTINED")
            res["restored"] = restored
            db.alert("critical", "health", f"Champion {ch['id']} quarantined for statistically supported deterioration; " + (f"rolled back to {restored}" if restored else "no healthy predecessor — NOT TRADING"))
    else:
        res["note"] = f"needs {pol.quarantine_min_trades} paper trades before a deterioration test is meaningful"
    db.metric("champion_health", res, ctx.market.days[-1].isoformat())
    return res


# ------------------------------------------------------------------ the post-session pipeline
def session_close(ctx: Ctx, provider: Provider, engine: PaperEngine, enqueue=None) -> dict:
    """Ingest the next completed session and run the whole learning loop on it."""
    db, m = ctx.db, ctx.market
    nxt = provider.next_session(m.days[-1])
    if nxt is None or (date.today() <= nxt and not isinstance(provider, SimulatedFeed)):
        return {"status": "no_new_session"}
    summary = ingest_session(m, provider, nxt, db)
    if summary["bars"] == 0:
        m.days.pop(); m.fx_asof.pop()
        for f in "ohlcv":
            setattr(m, f, getattr(m, f)[:, :-1])
        m.fx = m.fx[:-1]
        db.alert("warning", "data", f"{nxt}: feed delivered no usable bars; session not ingested, will retry")
        return {"status": "feed_failure", "day": str(nxt)}
    errs = [i for i in summary["issues"] if i["severity"] == "error"]
    if errs:
        db.alert("warning", "data", f"{nxt}: {len(errs)} data error(s): " + "; ".join(f"{i['symbol']} {i['kind']}" for i in errs[:4]))
    m.save(ctx.bars_dir, db)
    d = m.D - 1
    ctx.fs.extend(m)
    ctx.store_events(liedetector.detect(m, ctx.fs, d))
    ctx.dop.update(m, ctx.fs)
    st = ctx.engine("doppelganger") or {}
    ctx.dop.write_columns(ctx.fs, st.get("method") or "knn_z", st.get("calib"))
    ctx.save_dop()
    for r in db.q("SELECT id FROM models"):
        models.write_scores(db, ctx.fs, r["id"], m.D)
    ctx._sig_cache.clear()
    out = {"status": "ok", "day": str(nxt), "bars": summary["bars"], "issues": len(summary["issues"])}
    out["paper"] = engine.run_session(d)
    out["drift"] = drift(ctx)
    out["predictions"] = prediction_quality(ctx)
    out["health"] = champion_health(ctx)
    a = arena.run(ctx)
    out["decisions"] = arena.decide(ctx, a)
    # should research run?
    L = ctx.cfg.alpha["learning"]
    since = m.D - db.get_meta("last_cycle_session", m.D)
    reasons = []
    if since >= L["evolve_every_sessions"]:
        reasons.append(f"scheduled: {since} sessions since the last research cycle")
    if len(out["drift"]["flagged"]) >= 3 and since >= 10:
        reasons.append("distribution shift in " + ", ".join(out["drift"]["flagged"]))
    if out["health"] and out["health"]["status"] == "quarantined":
        reasons.append("champion quarantined")
    spent = db.one("SELECT COUNT(*) n FROM holdout_ledger WHERE epoch=? AND purpose='final_gate'", (ctx.epoch.id,))["n"] >= ctx.cfg.policy.max_holdout_uses_per_epoch
    if reasons and spent and m.D - ctx.epoch.holdout_end < L["min_holdout_days"]:
        out["research_deferred"] = "holdout budget spent; waiting for enough forward sessions to lock a new epoch"
        db.set_meta("last_cycle_session", m.D - L["evolve_every_sessions"] + 5)     # look again in 5 sessions
    elif reasons and enqueue:
        cid = start_cycle(ctx, "; ".join(reasons))
        enqueue("research_cycle", {"cycle_id": cid}, f"cycle:{cid}")
        out["research_cycle"] = cid
    db.metric("session_close", {k: v for k, v in out.items() if k in ("status", "day", "bars", "issues", "decisions", "research_cycle")}, str(nxt))
    return out


# ------------------------------------------------------------------ the research cycle
def start_cycle(ctx: Ctx, trigger: str) -> int:
    """Open a research cycle. If enough never-searched forward sessions have accumulated, first lock a new
    epoch (they become the new holdout) and retrain the models on the enlarged development window."""
    db, m, ep = ctx.db, ctx.market, ctx.epoch
    fwd = m.D - ep.holdout_end
    if fwd >= ctx.cfg.alpha["learning"]["min_holdout_days"]:
        ep = ctx.new_epoch(holdout_start=ep.holdout_end)
        ctx.gate_doppelganger()
        ids = retrain(ctx)
        ctx.ensure_baselines()
        trigger += f" | new epoch {ep.id}: {fwd} forward sessions became the holdout; retrained {', '.join(ids)}"
    cid = db.x("INSERT INTO cycles(epoch,status,stage,state,trigger,started) VALUES(?,?,?,?,?,?)", (ep.id, "queued", STAGES[0], "{}", trigger, time.time()))
    db.set_meta("last_cycle_session", m.D)
    db.audit("learning", "cycle.opened", {"cycle": cid, "epoch": ep.id, "trigger": trigger})
    return cid


def run_cycle(ctx: Ctx, cycle_id: int) -> dict:
    """Run (or resume) a research cycle. Progress is committed after every stage and every generation."""
    db, cfg = ctx.db, ctx.cfg
    row = db.one("SELECT * FROM cycles WHERE id=?", (cycle_id,))
    if row["status"] == "done":
        return json.loads(row["summary"])
    resumed = row["status"] == "running"
    if resumed:
        db.x("INSERT INTO recovery_log(ts,message) VALUES(?,?)", (time.time(), f"research cycle {cycle_id} resumed at stage '{row['stage']}'"))
    st = json.loads(row["state"] or "{}")
    stage = row["stage"]
    db.x("UPDATE cycles SET status='running' WHERE id=?", (cycle_id,))
    dw = cfg.alpha["darwin"]
    dop_on = bool((ctx.engine("doppelganger") or {}).get("enabled"))
    g = darwin.Grammar(True, dop_on, epoch_models(ctx))
    search = darwin.Search(ctx, g, cycle_id, dw["seed"], dw["population"], dw["generations"])
    search.restore()

    def save(next_stage):
        nonlocal stage
        stage = next_stage
        db.x("UPDATE cycles SET stage=?, state=? WHERE id=?", (stage, jd(st), cycle_id))

    while stage != "done":
        if ctx.fail_at == stage:
            ctx.fail_at = None
            raise InjectedCrash(f"injected failure at stage {stage}")
        if stage == "observe":
            obs = darwin.observe(ctx)
            hyps = darwin.hypothesize(ctx, obs, g, cycle_id)
            st["hyps"] = [{k: h[k] for k in ("id", "family", "kind", "key", "statement", "hint", "status")} for h in hyps]
            st["observations"] = {"events": sorted(obs["events"], key=lambda o: -abs(o["t"]))[:12], "features": sorted(obs["features"], key=lambda o: -abs(o["t"]))[:12]}
            st["pop"] = search.seed_population(hyps)
            st["gen"] = 0
            save("evolve")
        elif stage == "evolve":
            while st["gen"] < dw["generations"]:
                st["pop"] = search.step(st["pop"], st["gen"] + 1)
                st["gen"] += 1
                st.setdefault("best_by_gen", []).append(max(search.scores[h] for h in st["pop"]))
                save("evolve")
                if ctx.fail_at == f"evolve:{st['gen']}":
                    ctx.fail_at = None
                    raise InjectedCrash(f"injected failure after generation {st['gen']}")
            save("tune")
        elif stage == "tune":
            st["pop"] = search.tune(st["pop"], dw["optuna_trials"])
            save("validate")
        elif stage == "validate":
            short = search.shortlist(st["pop"], dw["validate_top_k"])
            rows = darwin.validate(ctx, search, short)
            st["shortlist"] = short
            st["validated"] = [r["hash"] for r in rows if r["passed"]]
            hyp_text = {h["id"]: h["statement"] for h in st["hyps"]}
            st["registered"] = []
            seen_struct = set()      # one candidate per structure, at most three per cycle: the holdout is a scarce resource
            for r in sorted(rows, key=lambda r: r["p"]):
                t_ = r["spec"].trigger
                key = (r["spec"].family, tuple(sorted(t_.patterns)), t_.feat, t_.model_id, t_.invert)
                if r["passed"] and key not in seen_struct and len(st["registered"]) < 3:
                    seen_struct.add(key)
                    meta = search.meta[r["hash"]]
                    sid = registry.register(db, r["spec"], cycle_id=cycle_id, epoch=ctx.epoch.id, parent_id=meta.get("parent"), hypothesis=hyp_text.get(meta.get("hyp")))
                    st["registered"].append(sid)
            darwin.learn_from_cycle(ctx, cycle_id, search, rows, [{**h, "evidence": {}} for h in st["hyps"]])
            save("skeptic")
        elif stage == "skeptic":
            ep = ctx.epoch
            n_trials = db.one("SELECT COUNT(*) n FROM trials WHERE cycle_id IN (SELECT id FROM cycles WHERE epoch=?)", (ep.id,))["n"]
            top = sorted(search.scores, key=lambda h: -search.scores[h])[:40]
            M = np.stack([ctx.backtest(search.specs[h], ep.dev_start, ep.val_end).daily for h in top], axis=1) if len(top) >= 4 else np.zeros((0, 0))
            pbo = stats.pbo_cscv(M) if M.size else {"pbo": None, "reason": "too few configurations"}
            st["pbo"], st["n_trials_epoch"] = pbo, n_trials
            for sid in st.get("registered", []):
                if registry.get(db, sid)["status"] == "CANDIDATE":      # idempotent on resume
                    skeptic.review(ctx, sid, {"n_trials": n_trials, "pbo": pbo}, seed=cycle_id)
            save("finalize")
        elif stage == "finalize":
            a = arena.run(ctx)
            decisions = arena.decide(ctx, a)
            verdicts = {sid: registry.get(db, sid)["status"] for sid in st.get("registered", [])}
            summary = {"cycle": cycle_id, "epoch": ctx.epoch.id, "hypotheses": len(st["hyps"]), "trials": len(search.scores), "n_trials_epoch": st.get("n_trials_epoch"),
                       "shortlisted": len(st.get("shortlist", [])), "validated": len(st.get("validated", [])), "verdicts": verdicts,
                       "approved": [s for s, v in verdicts.items() if v in ("APPROVED", "SHADOW", "CHAMPION")], "pbo": st.get("pbo"),
                       "best_by_gen": st.get("best_by_gen"), "decisions": decisions, "resumed": resumed,
                       "conclusion": "no candidate survived independent validation — no tradable advantage found this cycle" if not any(v in ("APPROVED", "SHADOW", "CHAMPION") for v in verdicts.values()) else "candidate(s) approved for paper shadow mode"}
            db.x("UPDATE cycles SET status='done', stage='done', state=?, summary=?, finished=? WHERE id=?", (jd(st), jd(summary), time.time(), cycle_id))
            db.audit("learning", "cycle.done", {k: summary[k] for k in ("cycle", "trials", "validated", "approved", "conclusion")})
            return summary
    return json.loads(db.one("SELECT summary FROM cycles WHERE id=?", (cycle_id,))["summary"])


# ------------------------------------------------------------------ engine-contribution ablations
def ablation(ctx: Ctx, seed: int = 5, pop: int = 40, gens: int = 4) -> dict:
    """Controlled comparison of what each engine adds, with identical budgets and seeds per arm, selected on
    validation and scored on sessions no arm has searched (forward sessions when there are enough, otherwise
    the holdout, with the use recorded in the ledger)."""
    db, ep, pol, m = ctx.db, ctx.epoch, ctx.cfg.policy, ctx.market
    mids = epoch_models(ctx)
    if m.D - ep.holdout_end >= 40:
        e0, e1, label = ep.holdout_end, m.D, "forward"
    else:
        e0, e1 = ep.part("holdout")
        label = "holdout"
        ctx.consume_holdout("ablation-study", "ablation")
    v0, v1 = ep.part("val")
    rng = np.random.default_rng(seed)
    none = StrategySpec(family="baseline", trigger=Trigger(kind="none"))
    obs = darwin.observe(ctx)                     # every arm reasons from the same development-set observations

    def pick(g: darwin.Grammar | None, tune: int = 0) -> tuple[StrategySpec, dict]:
        if g is None:
            cands = [s for n, s in ctx.baseline_specs().items() if not any(k in n for k in ("SIMILARITY", "ML", "FAILED"))]
            n_tr = len(cands)
        else:
            s = darwin.Search(ctx, g, None, seed, pop, gens, record=False)
            p = s.seed_population(darwin.hypothesize(ctx, obs, g, None))
            for gen in range(1, gens + 1):
                p = s.step(p, gen)
            p = s.tune(p, tune)
            cands, n_tr = [s.specs[h] for h in s.shortlist(p, 6)], len(s.scores)
        best, best_t = none, 0.0
        for c in cands:
            r = ctx.backtest(c, v0, v1)
            sd = r.daily.std(ddof=1)
            t = float(r.daily.mean() / sd * np.sqrt(len(r.daily))) if sd > 0 else 0.0
            if t > best_t and len(r.trades) >= pol.min_trades_val and ctx.backtest(c, v0, v1, "stress").metrics["net_cad"] > 0:
                best, best_t = c, t
        return best, {"trials": n_tr, "validation_t": best_t}

    arms = {}
    plan = [("A", "Benchmarks only", None, 0), ("B", "Benchmarks + Market Doppelgänger", darwin.Grammar(False, True, []), 0),
            ("C", "Benchmarks + Market Lie Detector", darwin.Grammar(True, False, []), 0),
            ("D", "Benchmarks + both discovery engines", darwin.Grammar(True, True, []), 0),
            ("E", "Full Darwin evolution (both engines + ML + Bayesian tuning)", darwin.Grammar(True, True, mids), 20)]
    for key, name, g, tune in plan:
        spec, info = pick(g, tune)
        arms[key] = {"name": name, "spec": spec, **info}
    # F: E's selection passed through adaptive regime selection (stand aside in regimes that lost on validation)
    e_spec = arms["E"]["spec"]
    f_spec = e_spec
    if e_spec.trigger.kind != "none":
        br = ctx.backtest(e_spec, v0, v1).metrics["by_regime"]
        bad = [int(k) for k, v in br.items() if v["net_cad"] <= 0]
        avoid = list(e_spec.avoid)
        if bad == [0]: avoid = avoid[:1] + [{"feat": "regime", "op": "<", "thr": 0.5}]
        elif bad == [2]: avoid = avoid[:1] + [{"feat": "regime", "op": ">", "thr": 1.5}]
        try:
            f_spec = StrategySpec.model_validate({**json.loads(e_spec.model_dump_json()), "avoid": [a if isinstance(a, dict) else json.loads(a.model_dump_json()) for a in avoid]})
        except Exception:
            f_spec = e_spec
    arms["F"] = {"name": "Full architecture (E + competition gate + adaptive regime selection)", "spec": f_spec, "trials": arms["E"]["trials"], "validation_t": arms["E"]["validation_t"]}
    base = ctx.backtest(arms["A"]["spec"], e0, e1).daily
    out = {"epoch": ep.id, "evaluated_on": label, "window": [m.days[e0].isoformat(), m.days[e1 - 1].isoformat()], "sessions": e1 - e0,
           "data_kind": m.kind, "arms": {}, "doppelganger_enabled": bool((ctx.engine("doppelganger") or {}).get("enabled"))}
    for key, a in arms.items():
        r = ctx.backtest(a["spec"], e0, e1)
        diff = r.daily - base
        bs = stats.block_bootstrap_means(diff, pol.bootstrap_block_days, 1000, rng)
        out["arms"][key] = {"name": a["name"], "selected": a["spec"].describe(), "search_trials": a["trials"], "validation_t": a["validation_t"],
                            "net_cad": r.metrics["net_cad"], "sharpe": r.metrics["sharpe"], "trades": r.metrics["trades"], "max_dd_cad": r.metrics["max_dd_cad"],
                            "vs_A_mean_daily": float(diff.mean()), "vs_A_ci90": [float(np.quantile(bs, .05)), float(np.quantile(bs, .95))],
                            "prob_better_than_A": float((bs > 0).mean()) if key != "A" else None, "equity": np.cumsum(r.daily).round(2).tolist()}
    def inc(x, y):
        d = ctx.backtest(arms[x]["spec"], e0, e1).daily - ctx.backtest(arms[y]["spec"], e0, e1).daily
        b = stats.block_bootstrap_means(d, pol.bootstrap_block_days, 1000, rng)
        return {"mean_daily": float(d.mean()), "ci90": [float(np.quantile(b, .05)), float(np.quantile(b, .95))], "prob_positive": float((b > 0).mean()) if np.any(d != 0) else 0.5}
    out["increments"] = {"doppelganger_alone (B−A)": inc("B", "A"), "liedetector_alone (C−A)": inc("C", "A"),
                         "doppelganger_given_liedetector (D−C)": inc("D", "C"), "darwin_ml_and_tuning (E−D)": inc("E", "D"), "adaptive_selection (F−E)": inc("F", "E")}
    recs = []
    for k, v in out["increments"].items():
        if v["prob_positive"] < 0.9:
            recs.append(f"{k}: no measurable incremental value on independent data (P(improvement) = {v['prob_positive']:.2f}); candidate for disabling or simplification.")
        else:
            recs.append(f"{k}: improvement supported (P = {v['prob_positive']:.2f}, {v['mean_daily']:+.2f} CAD/session).")
    out["recommendations"] = recs
    db.x("INSERT INTO ablations(ts,epoch,results) VALUES(?,?,?)", (time.time(), ep.id, jd(out)))
    db.audit("skeptic", "ablation.done", {"epoch": ep.id, "evaluated_on": label})
    return out
