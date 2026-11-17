"""Re-price stored strategies under the pre-v3 ("legacy") and Alpaca fee models and decompose their costs.
Usage: economics_audit.py <data_dir> — reads an existing real-data run; writes nothing to it."""
import json, sys
from alpha_genesis.config import Config
from alpha_genesis.core import Ctx
from alpha_genesis.dsl import StrategySpec

data = sys.argv[1]
out = {}
for fm in ("legacy", "alpaca"):
    ctx = Ctx(Config(data_dir=data, overrides={"execution": {"fee_model": fm}})).load()
    ep, m = ctx.epoch, ctx.market
    d0, d1 = ep.dev_start, ep.val_end
    rows = [(r["id"], StrategySpec.model_validate(json.loads(r["spec"]))) for r in ctx.db.q("SELECT id, spec FROM strategies WHERE status='BASELINE'")]
    seen = set()
    for r in ctx.db.q("SELECT spec_hash, spec FROM trials WHERE val IS NOT NULL ORDER BY json_extract(dev,'$.fitness') DESC"):
        if r["spec_hash"] in seen or len(seen) >= 25:
            continue
        d = {k: v for k, v in json.loads(r["spec"]).items() if not k.startswith("_")}
        if d["trigger"].get("model_id") and not ctx.db.one("SELECT 1 FROM models WHERE id=?", (d["trigger"]["model_id"],)):
            continue
        seen.add(r["spec_hash"])
        rows.append(("trial:" + r["spec_hash"], StrategySpec.model_validate(d)))
    res = {}
    for sid, spec in rows:
        mt = ctx.backtest(spec, d0, d1).metrics
        res[sid] = {"desc": spec.describe(), "trades": mt["trades"], "gross": mt["gross_cad"], "net": mt["net_cad"], "cost": mt["cost_cad"],
                    **mt["cost_breakdown_cad"], "fx_translation": mt["fx_translation_cad"], "exp_cad": mt["expectancy_cad"], "sharpe": mt["sharpe"], "max_dd": mt["max_dd_cad"]}
    out[fm] = res
    out["window"] = [m.days[d0].isoformat(), m.days[d1 - 1].isoformat()]
print(json.dumps(out, indent=1))
