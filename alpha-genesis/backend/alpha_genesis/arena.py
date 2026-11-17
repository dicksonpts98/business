"""ENGINE 4 — ALPHA ARENA: every strategy version competes under identical capital, costs, information
and risk limits. Ranking uses a lower confidence bound on post-selection out-of-sample daily P&L, not
raw return, and the champion must beat both the incumbent and the no-trade benchmark."""
from __future__ import annotations
import json, time
import numpy as np
from . import registry, stats
from .core import Ctx
from .db import jd
from .dsl import StrategySpec


def _eval(ctx: Ctx, spec: StrategySpec, d0: int, d1: int) -> dict | None:
    if d1 <= d0:
        return None
    base, stress = ctx.backtest(spec, d0, d1), ctx.backtest(spec, d0, d1, "stress")
    return {"metrics": base.metrics, "stress_net_cad": stress.metrics["net_cad"], "daily": base.daily,
            "equity": np.cumsum(base.daily).round(2).tolist()}


def run(ctx: Ctx, seed: int = 0) -> dict:
    db, ep, pol, m = ctx.db, ctx.epoch, ctx.cfg.policy, ctx.market
    rng = np.random.default_rng([seed, m.D])
    ctx.ensure_baselines()
    rows = registry.by_status(db, "BASELINE", "CHAMPION", "SHADOW", "APPROVED", "RETIRED", "QUARANTINED")
    rej = db.q("SELECT * FROM strategies WHERE status='REJECTED' AND epoch=? ORDER BY created DESC LIMIT 6", (ep.id,))
    v0, v1 = ep.part("val")
    h0, h1 = ep.part("holdout")
    f0, f1 = ep.holdout_end, m.D
    used = {r["subject"] for r in db.q("SELECT subject FROM holdout_ledger WHERE epoch=?", (ep.id,))}
    comps = []
    for r in rows + rej:
        spec = StrategySpec.model_validate(json.loads(r["spec"]))
        if r["status"] == "BASELINE" and spec.trigger.model_id and not db.one("SELECT 1 FROM models WHERE id=?", (spec.trigger.model_id,)):
            continue
        is_base = r["status"] == "BASELINE"
        own_epoch = r["epoch"] == ep.id
        # A strategy from an earlier epoch was not searched on this epoch's holdout either, so it may be scored there.
        hold_ok = is_base or r["id"] in used or (r["epoch"] is not None and r["epoch"] < ep.id)
        c = {"id": r["id"], "status": r["status"], "family": r["family"], "description": spec.describe(), "epoch": r["epoch"],
             "validation": _eval(ctx, spec, v0, v1), "forward": _eval(ctx, spec, f0, f1),
             "holdout": _eval(ctx, spec, h0, h1) if hold_ok else None,
             "validation_label": "validation (used for selection)" if own_epoch and not is_base else "validation window (not selected on)"}
        if hold_ok:
            oos = np.concatenate([c["holdout"]["daily"], c["forward"]["daily"] if c["forward"] else np.zeros(0)])
            bs = stats.block_bootstrap_means(oos, pol.bootstrap_block_days, pol.bootstrap_samples, rng)
            c["oos"] = {"days": int(len(oos)), "net_cad": float(oos.sum()), "mean_daily": float(oos.mean()), "sharpe": stats.sharpe(oos / ctx.cfg.risk.starting_capital_cad),
                        "score": float(np.quantile(bs, pol.bootstrap_lcb_quantile)), "prob_positive": float((bs > 0).mean()),
                        "max_dd_cad": stats.max_drawdown(np.cumsum(oos)), "daily": oos}
        else:
            c["oos"] = None
        comps.append(c)
    ranked = sorted([c for c in comps if c["oos"]], key=lambda c: -c["oos"]["score"])
    for i, c in enumerate(ranked):
        c["rank"] = i + 1
    ids = [c["id"] for c in ranked]
    h2h = [[None if a is b else stats.paired_prob_better(a["oos"]["daily"], b["oos"]["daily"], pol.bootstrap_block_days, 300, rng) for b in ranked] for a in ranked]
    # parameter stability, from each approved strategy's Skeptic report
    for c in comps:
        rep = db.one("SELECT checks FROM skeptic_reports WHERE strategy_id=? ORDER BY id DESC LIMIT 1", (c["id"],))
        if rep:
            ck = {x["check"]: x for x in json.loads(rep["checks"])["checks"]}
            c["parameter_stability"] = ck.get("parameter_sensitivity", {}).get("positive_fraction")
            c["dsr"] = ck.get("deflated_sharpe", {}).get("dsr")
    out = {"epoch": ep.id, "sessions": m.D, "ranking_basis": "5% lower bound of block-bootstrapped mean daily P&L on post-selection out-of-sample sessions (holdout + forward)",
           "windows": {"validation": [m.days[v0].isoformat(), m.days[v1 - 1].isoformat()], "holdout": [m.days[h0].isoformat(), m.days[h1 - 1].isoformat()],
                       "forward": [m.days[f0].isoformat(), m.days[f1 - 1].isoformat()] if f1 > f0 else None},
           "data_kind": m.kind, "competitors": comps, "h2h": {"ids": ids, "p": h2h}}
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k != "daily"}
        return [strip(v) for v in o] if isinstance(o, list) else o
    db.x("INSERT INTO arena_runs(ts,epoch,results) VALUES(?,?,?)", (time.time(), ep.id, jd(strip(out))))
    db.x("DELETE FROM arena_runs WHERE id NOT IN (SELECT id FROM arena_runs ORDER BY id DESC LIMIT 40)")
    return out


def decide(ctx: Ctx, arena: dict, seed: int = 0) -> list[dict]:
    """Apply the fixed promotion policy. Returns the decisions taken (also written to the promotions log)."""
    db, pol, cfg, ep = ctx.db, ctx.cfg.policy, ctx.cfg, ctx.epoch
    rng = np.random.default_rng([seed, ctx.market.D, 1])
    by_id = {c["id"]: c for c in arena["competitors"]}
    decisions = []
    for r in registry.by_status(db, "APPROVED"):       # approved -> shadow (tracked on forward data, no orders)
        registry.transition(db, cfg, r["id"], "SHADOW", "entered paper shadow mode after Skeptic approval", {"session": ctx.market.D}, "arena")
        db.set_meta(f"shadow_start:{r['id']}", ctx.market.D)
        decisions.append({"strategy": r["id"], "action": "SHADOW"})
    champ = registry.champion(db)
    champ_c = by_id.get(champ["id"]) if champ else None
    best = None
    for r in registry.by_status(db, "SHADOW"):
        c = by_id.get(r["id"])
        start = db.get_meta(f"shadow_start:{r['id']}", ctx.market.D)
        days = ctx.market.D - start
        if c is None or c["oos"] is None or days < pol.min_shadow_days:
            continue
        spec = registry.spec_of(db, r["id"])
        fwd = ctx.backtest(spec, start, ctx.market.D)
        forward_ok = fwd.metrics["net_cad"] > 0
        beats_null = c["oos"]["prob_positive"] >= pol.promote_min_prob_beats_champion
        p_champ = stats.paired_prob_better(c["oos"]["daily"], champ_c["oos"]["daily"], pol.bootstrap_block_days, 500, rng) if champ_c and champ_c["oos"] else 1.0
        ev = {"shadow_days": days, "forward_ok": forward_ok, "shadow_net_cad": fwd.metrics["net_cad"], "shadow_trades": fwd.metrics["trades"],
              "oos_score": c["oos"]["score"], "prob_beats_no_trade": c["oos"]["prob_positive"], "prob_beats_champion": p_champ,
              "risk_sha": cfg.risk.sha, "policy_sha": pol.sha}
        if forward_ok and beats_null and p_champ >= pol.promote_min_prob_beats_champion:
            if best is None or c["oos"]["score"] > best[1]["oos"]["score"]:
                best = (r["id"], c, ev)
        elif days >= 3 * pol.min_shadow_days and not forward_ok:
            registry.transition(db, cfg, r["id"], "RETIRED", "shadow period ended without positive forward evidence", ev, "arena")
            decisions.append({"strategy": r["id"], "action": "RETIRED", "evidence": ev})
    if best:
        registry.transition(db, cfg, best[0], "CHAMPION", "promoted to PAPER champion: beat no-trade and the incumbent on out-of-sample sessions", best[2], "arena")
        decisions.append({"strategy": best[0], "action": "CHAMPION", "evidence": best[2], "replaced": champ["id"] if champ else None})
        db.alert("info", "arena", f"{best[0]} promoted to paper champion" + (f", replacing {champ['id']}" if champ else ""))
    # Experimental paper mode: with no champion, the best-scoring shadow strategy may trade under reduced limits.
    if cfg.risk.paper_mode == "experimental":
        shadows = [(by_id[r["id"]]["oos"]["score"], r["id"]) for r in registry.by_status(db, "SHADOW") if by_id.get(r["id"]) and by_id[r["id"]]["oos"]]
        pick = max(shadows)[1] if shadows and registry.champion(db) is None else None
        cur = registry.experimental_deployment(db)
        if (cur["strategy_id"] if cur else None) != pick:
            registry.deploy_experimental(db, cfg, pick, "best out-of-sample score among shadow strategies")
            decisions.append({"strategy": pick, "action": "EXPERIMENTAL" if pick else "EXPERIMENTAL_CLEARED"})
    elif registry.experimental_deployment(db):
        registry.deploy_experimental(db, cfg, None)
    return decisions
