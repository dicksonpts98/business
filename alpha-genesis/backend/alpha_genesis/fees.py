"""Broker fee models, kept separate from spread and slippage.

"alpaca": commission-free US equities with pass-through regulatory fees (SEC Section 31 on sale proceeds,
FINRA TAF per share sold, CAT per share on both sides). The RATES BELOW COME FROM THE AUTHOR'S KNOWLEDGE AND
WERE NOT CHECKED AGAINST A PUBLISHED SCHEDULE (the sources were unreachable from the build environment):
confirm them against Alpaca's current fee disclosure and override under [fees.alpaca] in alpha.toml.
"legacy": the per-share commission with a per-order minimum used by ALPHA GENESIS before v3, kept for comparison."""
from __future__ import annotations
from datetime import date

DEFAULT_ALPACA = {
    "commission_per_share_usd": 0.0,
    # USD per USD 1,000,000 of sale proceeds, effective from the given date (inclusive)
    "sec_fee_schedule": [["2000-01-01", 8.00], ["2024-05-22", 27.80], ["2025-05-14", 0.00]],
    "finra_taf_per_share_usd": 0.000166, "finra_taf_cap_usd": 8.30,
    "cat_fee_per_share_usd": 0.00004,
    "verified": False,
}


def _alpaca(cfg) -> dict:
    return {**DEFAULT_ALPACA, **cfg.alpha.get("fees", {}).get("alpaca", {})}


def model(cfg) -> str:
    return cfg.alpha["execution"].get("fee_model", "alpaca")


def fill_fee(cfg, action: int, qty: int, px: float, day: date | str, scenario: str = "base") -> dict:
    """Fees in USD for one fill. action: +1 buy, -1 sell (a short sale is a sell). Returns commission and
    regulatory parts separately."""
    if scenario == "frictionless" or qty <= 0:
        return {"commission": 0.0, "regulatory": 0.0, "total": 0.0}
    ex = cfg.alpha["execution"]
    if model(cfg) == "legacy":
        c = max(ex["commission_min_usd"], ex["commission_per_share_usd"] * qty)
        return {"commission": c, "regulatory": 0.0, "total": c}
    a = _alpaca(cfg)
    day = day if isinstance(day, str) else day.isoformat()
    reg = a["cat_fee_per_share_usd"] * qty
    if action < 0:
        rate = [r for d, r in a["sec_fee_schedule"] if d <= day[:10]][-1]
        reg += qty * px * rate / 1e6 + min(a["finra_taf_cap_usd"], a["finra_taf_per_share_usd"] * qty)
    c = a["commission_per_share_usd"] * qty
    return {"commission": c, "regulatory": reg, "total": c + reg}


def describe(cfg) -> dict:
    ex = cfg.alpha["execution"]
    if model(cfg) == "legacy":
        return {"model": "legacy", "commission": f"USD {ex['commission_per_share_usd']}/share, minimum USD {ex['commission_min_usd']} per order", "regulatory": "none modelled", "verified": True,
                "note": "pre-v3 assumption (an IBKR-fixed-style schedule); not Alpaca's pricing"}
    a = _alpaca(cfg)
    return {"model": "alpaca", "commission": "USD 0 (commission-free US equities)", "sec_fee_schedule_per_million": a["sec_fee_schedule"],
            "finra_taf": f"USD {a['finra_taf_per_share_usd']}/share sold, cap USD {a['finra_taf_cap_usd']}", "cat": f"USD {a['cat_fee_per_share_usd']}/share",
            "verified": bool(a["verified"]), "note": "rates not checked against a published schedule; confirm and override under [fees.alpaca]"}
