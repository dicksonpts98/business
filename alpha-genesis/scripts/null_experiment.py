"""Null control: the same pipeline on a synthetic market with NO planted effect. Usage: null_experiment.py <data_dir> [sessions]"""
import json, sys
from pathlib import Path
from alpha_genesis import learning, registry
from alpha_genesis.config import Config
from alpha_genesis.runtime import Runtime

out = Path(sys.argv[1])
n = int(sys.argv[2]) if len(sys.argv) > 2 else 60
rt = Runtime(Config(data_dir=out, overrides={"data": {"synthetic_plant_orb": 0.0, "synthetic_plant_vwap": 0.0, "synthetic_seed": 99}}), log=lambda *a: None)
s = learning.run_cycle(rt.ctx, learning.start_cycle(rt.ctx, "null control: initial cycle"))
rt.advance(n)
db = rt.ctx.db
res = {"first_cycle": {k: s[k] for k in ("trials", "shortlisted", "validated", "approved", "conclusion", "pbo")},
       "cycles": [json.loads(r["summary"]) | {"trigger": r["trigger"]} for r in db.q("SELECT summary, trigger FROM cycles WHERE status='done'")],
       "doppelganger": {k: v for k, v in rt.ctx.engine("doppelganger").items() if k in ("enabled", "reason")},
       "doppelganger_eval": {m: {k: e.get(k) for k in ("ic", "ic_ci90", "brier_skill", "pass")} for m, e in rt.ctx.engine("doppelganger")["evaluation"].items()},
       "strategies": {r["status"]: r["n"] for r in db.q("SELECT status, COUNT(*) n FROM strategies GROUP BY status")},
       "skeptic_failures": {}, "champion": (registry.champion(db) or {}).get("id"), "orders": db.one("SELECT COUNT(*) n FROM orders")["n"],
       "sessions": rt.ctx.market.D, "total_trials": db.one("SELECT COUNT(*) n FROM trials")["n"]}
for r in db.q("SELECT checks FROM skeptic_reports"):
    for f in json.loads(r["checks"])["failed"]:
        res["skeptic_failures"][f] = res["skeptic_failures"].get(f, 0) + 1
for c in res["cycles"]:
    for k in ("decisions", "best_by_gen"):
        c.pop(k, None)
print(json.dumps(res, indent=1))
