"""ENGINE 3 — DARWIN TRADER: autonomous strategy discovery and evolution.

OBSERVE -> HYPOTHESIZE -> GENERATE -> TEST (-> CHALLENGE -> COMPETE -> DECIDE, in learning.py)

Darwin sees development and validation sessions only (through ResearchView). It forms hypotheses
from measured regularities, breeds typed strategies under a bounded budget, tunes numeric parameters
with Bayesian optimisation, and hands a short list to the independent Skeptic. Every strategy it ever
evaluates is recorded as a trial, so later multiple-testing corrections know the true search size.
What fails is written to a knowledge base that shapes the next cycle's budget."""
from __future__ import annotations
import json, time
import numpy as np
from pydantic import ValidationError
from . import registry, stats
from .core import Ctx, ResearchView
from .db import jd
from .dsl import Cond, Exit, StrategySpec, Trigger
from .features import REGISTRY, BASE_FEATURES, forward_labels, REGIME_NAMES
from .liedetector import PATTERN_IDS

SIGNED = [k for k, v in REGISTRY.items() if v[2] and not k.startswith("dop_")]


class Grammar:
    """Which ingredients a search may use. Engines that have not earned their place are switched off here."""
    def __init__(self, events=True, similarity=False, ml: list[str] | None = None):
        self.events, self.similarity, self.ml = events, similarity, ml or []

    def families(self) -> list[str]:
        f = ["feature"]
        if self.events: f.append("event")
        if self.similarity: f.append("similarity")
        if self.events and self.similarity: f.append("combo")
        if self.ml: f.append("ml")
        return f

    def cond_features(self) -> list[str]:
        return BASE_FEATURES + (["dop_mean_z", "dop_pup"] if self.similarity else [])

    def allows(self, spec: StrategySpec) -> bool:
        t = spec.trigger
        if t.kind == "event" and not self.events: return False
        if t.kind == "model" and t.model_id not in self.ml: return False
        if spec.uses("dop_") and not self.similarity: return False
        return True


# ---------------------------------------------------------------------------- generation
def _rand_cond(rng, g: Grammar, feat: str | None = None) -> dict:
    feat = feat or g.cond_features()[rng.integers(len(g.cond_features()))]
    lo, hi, _ = REGISTRY[feat]
    if feat == "regime":
        return {"feat": feat, "op": [">", "<"][rng.integers(2)], "thr": [0.5, 1.5][rng.integers(2)]}
    if feat == "mkt_trend":
        return {"feat": feat, "op": [">", "<"][rng.integers(2)], "thr": 0.0}
    return {"feat": feat, "op": [">", "<"][rng.integers(2)], "thr": round(float(rng.uniform(lo + 0.15 * (hi - lo), hi - 0.15 * (hi - lo))), 2)}


def _rand_exit(rng, event: bool) -> dict:
    return {"max_hold": int(rng.choice([4, 6, 9, 12, 18, 24])), "stop_kind": "invalidation" if (event and rng.random() < 0.4) else "atr",
            "stop_atr": round(float(rng.uniform(1.0, 4.0)), 1), "target_r": None if rng.random() < 0.6 else round(float(rng.uniform(0.8, 3.0)), 1)}


def random_spec(rng, g: Grammar, family: str | None = None, hint: dict | None = None, plain: bool = False) -> StrategySpec | None:
    """plain=True gives the most direct statement of a hypothesis: no extra conditions, default exits."""
    fams = g.families()
    family = family if family in fams else fams[rng.integers(len(fams))]
    hint = hint or {}
    for _ in range(20):
        try:
            if family in ("event", "combo"):
                pats = hint.get("patterns") or [PATTERN_IDS[i] for i in rng.choice(len(PATTERN_IDS), size=int(rng.integers(1, 3)), replace=False)]
                trig = {"kind": "event", "patterns": list(pats), "invert": bool(hint.get("invert", rng.random() < 0.25))}
            elif family == "feature":
                feat = hint.get("feat") or SIGNED[rng.integers(len(SIGNED))]
                trig = {"kind": "feature", "feat": feat, "thr": round(float(rng.uniform(0.5, 0.85 * REGISTRY[feat][1])), 2),
                        "invert": bool(hint.get("invert", rng.random() < 0.5))}
            elif family == "similarity":
                trig = {"kind": "feature", "feat": "dop_mean_z", "thr": round(float(rng.uniform(0.1, 0.8)), 2), "invert": False}
            else:
                trig = {"kind": "model", "model_id": hint.get("model_id") or g.ml[rng.integers(len(g.ml))], "thr": round(float(rng.uniform(0.01, 0.12)), 3), "invert": False}
            filters = [] if plain else [_rand_cond(rng, g) for _ in range(int(rng.integers(0, 3)))]
            if hint.get("regime_filter") is not None:
                filters = [hint["regime_filter"]] + filters[:1]
            if family == "combo":
                filters = [{"feat": "dop_pup", "op": ">", "thr": round(float(rng.uniform(0.45, 0.6)), 2)}] + filters[:1]
            avoid = [_rand_cond(rng, g)] if (rng.random() < 0.2 and not plain) else []
            is_fade_event = trig["kind"] == "event" and not trig["invert"]
            ex = {"max_hold": 12, "stop_kind": "invalidation" if is_fade_event else "atr", "stop_atr": 2.5, "target_r": None} if plain else _rand_exit(rng, is_fade_event)
            spec = StrategySpec(family=family, trigger=trig, filters=filters, avoid=avoid,
                                side="both" if plain else str(rng.choice(["both", "both", "long", "short"])), exit=ex, sizing="fixed_risk")
            return spec
        except ValidationError:
            continue
    return None


def mutate(rng, spec: StrategySpec, g: Grammar) -> StrategySpec | None:
    for _ in range(20):
        d = json.loads(spec.model_dump_json())
        op = rng.integers(8)
        t, e = d["trigger"], d["exit"]
        if op == 0 and t.get("thr") is not None:
            t["thr"] = round(float(t["thr"] * rng.uniform(0.75, 1.3)), 3)
        elif op == 1:
            e["max_hold"] = int(np.clip(e["max_hold"] + rng.choice([-6, -3, -2, 2, 3, 6]), 2, 60))
        elif op == 2:
            e["stop_atr"] = round(float(np.clip(e["stop_atr"] * rng.uniform(0.7, 1.4), 0.5, 5)), 1)
            if t["kind"] == "event" and not t["invert"] and rng.random() < 0.3:
                e["stop_kind"] = "invalidation" if e["stop_kind"] == "atr" else "atr"
        elif op == 3:
            e["target_r"] = None if (e["target_r"] and rng.random() < 0.4) else round(float(rng.uniform(0.8, 3.0)), 1)
        elif op == 4 and len(d["filters"]) < 3:
            d["filters"].append(_rand_cond(rng, g))
        elif op == 5 and d["filters"]:
            i = int(rng.integers(len(d["filters"])))
            if rng.random() < 0.5:
                d["filters"].pop(i)
            else:
                lo, hi, _ = REGISTRY[d["filters"][i]["feat"]]
                d["filters"][i]["thr"] = round(float(np.clip(d["filters"][i]["thr"] + rng.normal(0, 0.1 * (hi - lo)), lo, hi)), 2)
        elif op == 6 and t["kind"] == "event":
            if rng.random() < 0.5 and len(t["patterns"]) > 1:
                t["patterns"].pop(int(rng.integers(len(t["patterns"]))))
            else:
                p = PATTERN_IDS[rng.integers(len(PATTERN_IDS))]
                if p not in t["patterns"] and len(t["patterns"]) < 4:
                    t["patterns"].append(p)
        elif op == 7:
            if d["avoid"]:
                d["avoid"] = []
            else:
                d["avoid"] = [_rand_cond(rng, g, "regime" if rng.random() < 0.5 else None)]
        else:
            continue
        try:
            new = StrategySpec.model_validate(d)
        except ValidationError:
            continue
        if new.hash() != spec.hash() and g.allows(new):
            return new
    return None


def crossover(rng, a: StrategySpec, b: StrategySpec, g: Grammar) -> StrategySpec | None:
    d = json.loads(a.model_dump_json())
    db_ = json.loads(b.model_dump_json())
    d["exit"] = db_["exit"]
    if d["trigger"]["kind"] != "event" or d["trigger"]["invert"]:
        d["exit"]["stop_kind"] = "atr"
    d["filters"] = (d["filters"][:1] + db_["filters"][:1])[:3]
    try:
        new = StrategySpec.model_validate(d)
        return new if g.allows(new) else None
    except ValidationError:
        return None


# ---------------------------------------------------------------------------- fitness
def fitness(res, n_filters: int, min_trades: int = 30) -> float:
    """Robustness-first objective on development sessions: average of the whole-window and the weakest-third
    t-statistics of daily P&L, minus a complexity charge. Deliberately not 'maximise return'."""
    if len(res.trades) < min_trades:
        return -5.0 + len(res.trades) / min_trades
    def t(x):
        sd = x.std(ddof=1) if len(x) > 2 else 0
        return float(x.mean() / sd * np.sqrt(len(x))) if sd > 0 else 0.0
    folds = np.array_split(res.daily, 3)
    return 0.5 * t(res.daily) + 0.5 * min(t(f) for f in folds) - 0.1 * n_filters


# ---------------------------------------------------------------------------- observe / hypothesize
def observe(ctx: Ctx) -> dict:
    """Measure regularities on development sessions only."""
    ep, m, fs = ctx.epoch, ctx.market, ctx.fs
    a, b = ep.part("dev")
    fwd, _ = forward_labels(m, 12)
    with np.errstate(all="ignore"):
        y = (fwd / (fs["_rv78"] * np.sqrt(12)))[:, a:b]
    reg = fs["regime"][:, a:b]
    days = np.broadcast_to(np.arange(a, b)[None, :, None], y.shape)
    obs = {"events": [], "features": [], "window": [m.days[a].isoformat(), m.days[b - 1].isoformat()]}

    def day_t(vals, dd):
        if len(vals) < 30: return 0.0, 0.0
        ud, inv = np.unique(dd, return_inverse=True)
        dm = np.bincount(inv, vals)          # per-session sums: sessions are the independent unit
        sd = dm.std(ddof=1)
        return float(vals.mean()), float(dm.mean() / sd * np.sqrt(len(dm))) if sd > 0 else 0.0

    for p in PATTERN_IDS:
        ev = fs["ev:" + p][:, a:b].astype(float)
        for rname, mask in (("all", np.ones_like(reg, bool)), ("calm", reg == 0), ("normal+volatile", reg >= 1)):
            sel = (ev != 0) & mask & np.isfinite(y)
            mean, t = day_t((ev * y)[sel], days[sel])
            obs["events"].append({"pattern": p, "regime": rname, "n": int(sel.sum()), "mean_sigma": mean, "t": t})
    for f in SIGNED:
        x = fs[f][:, a:b]
        for rname, mask in (("all", np.ones_like(reg, bool)), ("calm", reg == 0), ("normal+volatile", reg >= 1)):
            with np.errstate(invalid="ignore"):
                ext = (np.abs(x) > 0.6 * REGISTRY[f][1]) & mask & np.isfinite(y)
            mean, t = day_t((np.sign(x) * y)[ext], days[ext])
            obs["features"].append({"feature": f, "regime": rname, "n": int(ext.sum()), "mean_sigma": mean, "t": t})
    # weaknesses of the live champion, from attributed paper trades
    ch = registry.champion(ctx.db)
    if ch:
        rows = ctx.db.q("SELECT regime, COUNT(*) n, SUM(net_cad) net, AVG(r_multiple) r FROM paper_trades WHERE strategy_id=? GROUP BY regime", (ch["id"],))
        obs["champion"] = {"id": ch["id"], "by_regime": rows}
    return obs


def hypothesize(ctx: Ctx, obs: dict, g: Grammar, cycle_id: int) -> list[dict]:
    """Turn observations into explicit, falsifiable hypotheses. An idea already rejected on the same data
    (same epoch) is not re-opened; a new epoch means new evidence and is a defensible reason to retest."""
    ep = ctx.epoch
    hyps = []
    REG = {"calm": {"feat": "regime", "op": "<", "thr": 0.5}, "normal+volatile": {"feat": "regime", "op": ">", "thr": 0.5}, "all": None}
    if g.events:
        for o in sorted(obs["events"], key=lambda o: -abs(o["t"])):
            if abs(o["t"]) >= 2.0 and o["n"] >= 60:
                act = "reverse (fade)" if o["t"] > 0 else "continue (follow-through)"
                hyps.append({"family": "event", "kind": "event_outcome", "key": f"event:{o['pattern']}:{o['regime']}:{'fade' if o['t'] > 0 else 'follow'}",
                             "statement": f"After {o['pattern']} in {o['regime']} regimes, prices tend to {act} over the next hour.",
                             "evidence": o, "hint": {"patterns": [o["pattern"]], "invert": o["t"] < 0, "regime_filter": REG[o["regime"]]}})
    for o in sorted(obs["features"], key=lambda o: -abs(o["t"])):
        if abs(o["t"]) >= 2.5 and o["n"] >= 200:
            hyps.append({"family": "feature", "kind": "feature_extreme", "key": f"feature:{o['feature']}:{o['regime']}:{'follow' if o['t'] > 0 else 'fade'}",
                         "statement": f"Extreme {o['feature']} in {o['regime']} regimes is followed by {'continuation' if o['t'] > 0 else 'reversal'}.",
                         "evidence": o, "hint": {"feat": o["feature"], "invert": o["t"] < 0, "regime_filter": REG[o["regime"]]}})
    if g.similarity:
        st = ctx.engine("doppelganger")
        hyps.append({"family": "similarity", "kind": "similarity_forecast", "key": "similarity:forecast",
                     "statement": "Outcomes of the most similar historical states carry information about the next hour.",
                     "evidence": {"method": st["method"], "ic": st["evaluation"][st["method"]].get("ic")}, "hint": {}})
        hyps.append({"family": "combo", "kind": "event_plus_similarity", "key": "combo:event+similarity",
                     "statement": "Failed-pattern reversals are more reliable when historical twins agree with the fade direction.", "evidence": {}, "hint": {}})
    for mid in g.ml:
        row = ctx.db.one("SELECT metrics FROM models WHERE id=?", (mid,))
        hyps.append({"family": "ml", "kind": "model_forecast", "key": f"ml:{mid}",
                     "statement": f"A {mid.split('-')[0]} combination of state features and recent failed-pattern events forecasts next-hour direction.",
                     "evidence": {k: v for k, v in json.loads(row["metrics"]).items() if k.startswith("internal")}, "hint": {"model_id": mid}})
    ch = obs.get("champion")
    if ch:
        for r in ch["by_regime"]:
            if r["n"] >= 10 and r["net"] < 0:
                hyps.append({"family": "variant", "kind": "champion_weakness", "key": f"variant:{ch['id']}:avoid_regime_{r['regime']}",
                             "statement": f"Champion {ch['id']} loses in the {REGIME_NAMES[r['regime']]} regime ({r['n']} paper trades, mean {r['r']:.2f}R); a variant that stands aside there may be more robust.",
                             "evidence": r, "hint": {"parent": ch["id"], "avoid_regime": r["regime"]}})
    done = {r["subject"] for r in ctx.db.q("SELECT subject FROM kb_lessons WHERE lesson LIKE 'hypothesis_rejected%' AND cycle_id IN (SELECT id FROM cycles WHERE epoch=?)", (ep.id,))}
    out = []
    for i, h in enumerate(hyps[:14]):
        if cycle_id is None:                      # dry run (ablation arms): same reasoning, nothing persisted
            h["status"], h["id"] = "open", -(i + 1)
            out.append(h)
            continue
        h["status"] = "skipped_already_rejected_this_epoch" if h["key"] in done else "open"
        h["id"] = ctx.db.x("INSERT INTO hypotheses(cycle_id,family,kind,statement,evidence,status,created) VALUES(?,?,?,?,?,?,?)",
                           (cycle_id, h["family"], h["kind"], h["statement"], jd({"key": h["key"], **h["evidence"]}), h["status"], time.time()))
        out.append(h)
    return out


# ---------------------------------------------------------------------------- the search
class Search:
    """One bounded evolutionary search. State is a plain dict so it can be checkpointed between generations."""
    def __init__(self, ctx: Ctx, g: Grammar, cycle_id: int | None, seed: int, pop: int, gens: int, record: bool = True):
        self.ctx, self.g, self.cycle_id, self.seed, self.pop, self.gens, self.record = ctx, g, cycle_id, seed, pop, gens, record
        self.view = ResearchView(ctx)
        self.scores: dict[str, float] = {}
        self.specs: dict[str, StrategySpec] = {}
        self.meta: dict[str, dict] = {}

    def evaluate(self, spec: StrategySpec, origin: str, gen: int, hyp: int | None = None, parent: str | None = None) -> float:
        h = spec.hash()
        if h in self.scores:
            return self.scores[h]
        res = self.view.run(spec, "dev")
        fit = fitness(res, len(spec.filters) + len(spec.avoid))
        self.scores[h], self.specs[h] = fit, spec
        self.meta[h] = {"origin": origin, "gen": gen, "hyp": hyp, "parent": parent, "dev_sharpe": res.metrics["sharpe"]}
        if self.record:
            dev = {"fitness": fit, **{k: res.metrics[k] for k in ("trades", "net_cad", "sharpe", "expectancy_r", "max_dd_cad", "cost_cad")}}
            self.ctx.db.x("INSERT OR IGNORE INTO trials(cycle_id,spec_hash,family,origin,generation,spec,dev,stage) VALUES(?,?,?,?,?,?,?,?)",
                          (self.cycle_id, h, spec.family, origin, gen, jd({**spec.model_dump(), "_hyp": hyp, "_parent": parent}), jd(dev), "dev"))
        return fit

    def restore(self):
        """Reload evaluated trials after an interruption so no work is repeated or double-counted."""
        for r in self.ctx.db.q("SELECT * FROM trials WHERE cycle_id=?", (self.cycle_id,)):
            d = json.loads(r["spec"])
            hyp, parent = d.pop("_hyp", None), d.pop("_parent", None)
            dev = json.loads(r["dev"])
            self.specs[r["spec_hash"]] = StrategySpec.model_validate(d)
            self.scores[r["spec_hash"]] = dev["fitness"]
            self.meta[r["spec_hash"]] = {"origin": r["origin"], "gen": r["generation"], "hyp": hyp, "parent": parent, "dev_sharpe": dev["sharpe"]}

    def seed_population(self, hyps: list[dict]) -> list[str]:
        rng = np.random.default_rng([self.seed, self.cycle_id or 0, 0])
        fams = self.g.families()
        kb = {r["family"]: (r["alpha"], r["beta"]) for r in self.ctx.db.q("SELECT * FROM kb_family")}
        draw = np.array([rng.beta(*kb.get(f, (1.0, 1.0))) for f in fams])     # Thompson sampling over families
        share = 0.5 * draw / draw.sum() + 0.5 / len(fams)                      # never starve a family completely
        out = []
        open_h = [h for h in hyps if h["status"] == "open"]
        for h in open_h:
            if h["family"] == "variant":
                par = registry.spec_of(self.ctx.db, h["hint"]["parent"])
                d = json.loads(par.model_dump_json())
                r = h["hint"]["avoid_regime"]
                d["avoid"] = [{"feat": "regime", "op": "<", "thr": 0.5}] if r == 0 else ([{"feat": "regime", "op": ">", "thr": 1.5}] if r == 2 else d["avoid"])
                try:
                    s = StrategySpec.model_validate(d)
                    if s.hash() != par.hash() and self.g.allows(s):
                        self.evaluate(s, "variant", 0, h["id"], h["hint"]["parent"]); out.append(s.hash())
                except ValidationError:
                    pass
                continue
            for i in range(max(3, self.pop // (2 * max(len(open_h), 1)))):
                s = random_spec(rng, self.g, h["family"], h["hint"], plain=(i == 0))
                if s:
                    self.evaluate(s, "hypothesis", 0, h["id"]); out.append(s.hash())
        tries = 0
        while len(set(out)) < self.pop and tries < self.pop * 6:
            tries += 1
            s = random_spec(rng, self.g, fams[rng.choice(len(fams), p=share)])
            if s:
                self.evaluate(s, "exploration", 0); out.append(s.hash())
        return list(dict.fromkeys(out))

    def step(self, population: list[str], gen: int) -> list[str]:
        rng = np.random.default_rng([self.seed, self.cycle_id or 0, gen])
        ranked = sorted(set(population), key=lambda h: -self.scores[h])
        elite = ranked[:max(4, self.pop // 4)]
        nxt = list(elite)
        tries = 0
        while len(nxt) < self.pop and tries < self.pop * 8:
            tries += 1
            a = self.specs[elite[rng.integers(len(elite))]]
            if rng.random() < 0.25:
                child = crossover(rng, a, self.specs[elite[rng.integers(len(elite))]], self.g)
                origin = "crossover"
            elif rng.random() < 0.12:
                child, origin = random_spec(rng, self.g), "exploration"
            else:
                child, origin = mutate(rng, a, self.g), "mutation"
            if child is None or child.hash() in nxt:
                continue
            par = self.meta[a.hash()]
            self.evaluate(child, origin, gen, par.get("hyp") if origin != "exploration" else None, par.get("parent"))
            nxt.append(child.hash())
        return nxt

    def tune(self, population: list[str], n_trials: int) -> list[str]:
        """Bayesian optimisation (Optuna TPE) of the numeric parameters of the best few structures."""
        if n_trials <= 0:
            return population
        import optuna
        optuna.logging.set_verbosity(optuna.logging.WARNING)
        top, seen_struct = [], set()
        for h in sorted(set(population), key=lambda h: -self.scores[h]):
            s = self.specs[h]
            key = (s.trigger.kind, tuple(s.trigger.patterns), s.trigger.feat, s.trigger.model_id, tuple(sorted(c.feat for c in s.filters)))
            if key not in seen_struct and self.scores[h] > -4:
                seen_struct.add(key); top.append(h)
            if len(top) == 3:
                break
        out = list(population)
        for i, h in enumerate(top):
            base = json.loads(self.specs[h].model_dump_json())
            def objective(trial):
                d = json.loads(json.dumps(base))
                d["exit"]["max_hold"] = trial.suggest_int("max_hold", 3, 30)
                d["exit"]["stop_atr"] = round(trial.suggest_float("stop_atr", 1.0, 4.5), 1)
                d["exit"]["target_r"] = round(trial.suggest_float("target_r", 0.8, 4.0), 1) if trial.suggest_categorical("use_target", [0, 1]) else None
                if d["trigger"].get("thr") is not None:
                    hi = 0.3 if d["trigger"]["kind"] == "model" else REGISTRY[d["trigger"]["feat"]][1]
                    d["trigger"]["thr"] = round(trial.suggest_float("thr", max(1e-3, 0.5 * d["trigger"]["thr"]), min(hi, 1.6 * d["trigger"]["thr"])), 3)
                for j, c in enumerate(d["filters"]):
                    if c["feat"] not in ("regime", "mkt_trend"):
                        lo, hi_, _ = REGISTRY[c["feat"]]
                        w = 0.12 * (hi_ - lo)
                        c["thr"] = round(trial.suggest_float(f"f{j}", max(lo, c["thr"] - w), min(hi_, c["thr"] + w)), 2)
                try:
                    s = StrategySpec.model_validate(d)
                except ValidationError:
                    return -9.0
                fit = self.evaluate(s, "optuna", self.gens + 1, self.meta[h].get("hyp"), self.meta[h].get("parent"))
                out.append(s.hash())
                return fit
            study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=self.seed + (self.cycle_id or 0) * 10 + i))
            study.optimize(objective, n_trials=max(1, n_trials // len(top)))
        return list(dict.fromkeys(out))

    def shortlist(self, population: list[str], k: int) -> list[str]:
        """Top-k by development fitness with at most 3 per structural family, to keep the validation set
        from being spent on near-duplicates."""
        out, per = [], {}
        for h in sorted(set(population) | set(self.scores), key=lambda h: -self.scores[h]):
            s = self.specs[h]
            key = (s.family, tuple(s.trigger.patterns), s.trigger.feat, s.trigger.model_id)
            if per.get(key, 0) >= 3 or self.scores[h] <= 0:
                continue
            per[key] = per.get(key, 0) + 1
            out.append(h)
            if len(out) == k:
                break
        return out


def validate(ctx: Ctx, search: Search, shortlist: list[str]) -> list[dict]:
    """Validation-set test of the shortlist under base and stress costs, with Benjamini–Hochberg control
    of the false-discovery rate across everything that reached validation."""
    pol = ctx.cfg.policy
    rows = []
    for h in shortlist:
        spec = search.specs[h]
        base, stress = search.view.run(spec, "val"), search.view.run(spec, "val", "stress")
        rows.append({"hash": h, "spec": spec, "base": base, "stress": stress, "p": stats.t_pvalue_pos(base.daily)})
    keep = stats.bh_fdr([r["p"] for r in rows], pol.fdr_alpha)
    for r, k in zip(rows, keep):
        mt = r["base"].metrics
        reasons = []
        if not k: reasons.append(f"not significant after FDR control (p={r['p']:.3f})")
        if mt["trades"] < pol.min_trades_val: reasons.append(f"only {mt['trades']} validation trades (< {pol.min_trades_val})")
        if mt["net_cad"] <= 0: reasons.append("negative net P&L on validation")
        r["passed"], r["reasons"] = not reasons, reasons
        if search.record:
            val = {"p": r["p"], "fdr_keep": bool(k), "passed": r["passed"], "reasons": reasons, "stress_net_cad": r["stress"].metrics["net_cad"],
                   **{kk: mt[kk] for kk in ("trades", "net_cad", "sharpe", "expectancy_r", "max_dd_cad", "cost_cad", "win_rate")}}
            ctx.db.x("UPDATE trials SET val=?, stage=? WHERE cycle_id=? AND spec_hash=?", (jd(val), "validated" if r["passed"] else "val_failed", search.cycle_id, r["hash"]))
    return rows


def learn_from_cycle(ctx: Ctx, cycle_id: int, search: Search, rows: list[dict], hyps: list[dict]):
    """Update the knowledge base: family success posteriors and explicit lessons from what failed."""
    fam_seen = {}
    for r in rows:
        fam = r["spec"].family
        n = fam_seen.get(fam, 0)
        if n < 3:                               # cap each family's vote per cycle
            a, b = (1.0, 0.0) if r["passed"] else (0.0, 1.0)
            ctx.db.x("INSERT INTO kb_family(family,alpha,beta) VALUES(?,?,?) ON CONFLICT(family) DO UPDATE SET alpha=alpha+?, beta=beta+?",
                     (fam, 1 + a, 1 + b, a, b))
            fam_seen[fam] = n + 1
        if not r["passed"]:
            ctx.db.x("INSERT INTO kb_lessons(ts,cycle_id,subject,family,elements,lesson) VALUES(?,?,?,?,?,?)",
                     (time.time(), cycle_id, r["hash"], fam, jd(r["spec"].elements()), "validation_failed: " + "; ".join(r["reasons"])))
    passed_h = {search.meta[r["hash"]].get("hyp") for r in rows if r["passed"]}
    tested_h = {m.get("hyp") for m in search.meta.values()}
    for h in hyps:
        if h["status"] != "open":
            continue
        if h["id"] in passed_h:
            st = "supported_on_validation"
        elif h["id"] in tested_h:
            st = "rejected"
            ctx.db.x("INSERT INTO kb_lessons(ts,cycle_id,subject,family,elements,lesson) VALUES(?,?,?,?,?,?)",
                     (time.time(), cycle_id, h["key"], h["family"], jd([h["key"]]), "hypothesis_rejected: no derived strategy survived validation"))
        else:
            st = "untested"
        ctx.db.x("UPDATE hypotheses SET status=? WHERE id=?", (st, h["id"]))
