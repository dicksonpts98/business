"""Event-driven backtester.

Timing contract: a signal exists at the close of bar t; the earliest fill is the open of bar t+1.
Stops are evaluated bar by bar against that bar's own range, gaps through a stop fill at the open
(worse than the stop), a bar that touches both stop and target is resolved as the stop, and limit
targets need a trade-through. Positions are sized in CAD from a timestamped USD/CAD rate and all
account limits (per-trade risk, exposure, daily loss, entry count) are applied chronologically
across the whole universe. The same function serves every strategy in every arena."""
from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from . import stats
from .config import BARS_PER_DAY as B, Config
from .dsl import StrategySpec, signals
from .market import Market

SCENARIOS = ("base", "stress", "frictionless")


@dataclass
class Result:
    d0: int
    d1: int
    daily: np.ndarray                       # net CAD P&L per session
    trades: list[dict] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    scenario: str = "base"


def cost_frac(cfg: Config, sym: str, scenario: str) -> float:
    mult = {"base": 1.0, "stress": cfg.alpha["execution"]["stress_multiplier"], "frictionless": 0.0}[scenario]
    return (cfg.instrument(sym)["half_spread_bps"] + cfg.alpha["execution"]["slippage_bps"]) * mult / 1e4


def simulate_exit(o, h, l, c, eb: int, side: int, stop: float, target: float | None, max_hold: int, half_spread: float):
    """Walk one position forward from its entry bar. Returns (exit_bar, raw_exit_price, reason)."""
    last = eb
    for j in range(eb, B):
        if not np.isfinite(c[j]):
            continue                          # halt / missing bar: no exit is possible here
        last = j
        if j > eb and side * (o[j] - stop) <= 0:
            return j, o[j], "stop_gap"        # opened beyond the stop: filled at the open, not the stop
        if side * ((l[j] if side > 0 else h[j]) - stop) <= 0:
            return j, stop, "stop"
        if target is not None and side * ((h[j] if side > 0 else l[j]) - target) > half_spread * target:
            return j, target, "target"
        if j - eb + 1 >= max_hold:
            return j, c[j], "time"
    return last, c[last], "eod"


def run(spec: StrategySpec, m: Market, fs, cfg: Config, d0: int, d1: int, scenario: str = "base",
        sig: np.ndarray | None = None, min_day: int = 0, equity0: float | None = None) -> Result:
    ex, rk = cfg.alpha["execution"], cfg.risk
    if sig is None:
        sig = signals(spec, fs, m.sidx(cfg.proxy), min_day)
    sub = sig[:, d0:d1]
    ss, dd, bb = np.nonzero(sub)
    order = np.lexsort((ss, bb, dd))
    ss, dd, bb = ss[order], dd[order] + d0, bb[order]
    atr = fs["_atr"]
    cfr = [cost_frac(cfg, s, scenario) for s in m.symbols]
    hsp = [cfg.instrument(s)["half_spread_bps"] / 1e4 for s in m.symbols]
    shortable = [cfg.instrument(s).get("shortable", True) for s in m.symbols]
    comm = 0.0 if scenario == "frictionless" else 1.0
    risk_cad = rk.risk_per_trade_cad * (0.5 if spec.sizing == "half_risk" else 1.0)
    start = rk.starting_capital_cad
    equity = start if equity0 is None else equity0
    daily = np.zeros(d1 - d0)
    busy = np.full(m.S, -1)                 # global bar index until which each symbol holds a position
    open_pos: list[tuple[int, float]] = []  # (exit global bar, notional CAD)
    trades: list[dict] = []
    cur_day, day_entries, day_closed = -1, 0, []   # day_closed: (exit global bar, pnl CAD)
    pats = spec.trigger.patterns if spec.trigger.kind == "event" and not spec.trigger.invert else []
    last_entry = ex["last_entry_bar"]
    for s, d, b in zip(ss, dd, bb):
        s, d, b = int(s), int(d), int(b)
        side = int(sig[s, d, b])
        g = d * B + b
        if d != cur_day:
            cur_day, day_entries, day_closed = d, 0, []
        eb = b + 1
        if eb > last_entry or g < busy[s] or day_entries >= rk.max_entries_per_day:
            continue
        o, h, l, c, v = m.o[s, d], m.h[s, d], m.l[s, d], m.c[s, d], m.v[s, d]
        fx = m.fx[d]
        a = atr[s, d, b]
        if not (np.isfinite(o[eb]) and np.isfinite(a) and a > 0 and np.isfinite(fx)):
            continue                          # no executable price, no risk estimate, or no FX rate: no trade
        if side < 0 and not shortable[s]:
            continue
        ge = d * B + eb
        if sum(p for x, p in day_closed if x < ge) <= -rk.max_daily_loss_cad:
            continue
        open_pos = [(x, n) for x, n in open_pos if x >= ge]
        if len(open_pos) >= rk.max_positions:
            continue
        raw_e = o[eb]
        entry = raw_e * (1 + side * cfr[s])
        dist = spec.exit.stop_atr * a
        if spec.exit.stop_kind == "invalidation" and pats:
            for p in pats:
                inv = fs["inv:" + p][s, d, b]
                if np.isfinite(inv):
                    dist = side * (entry - inv)
                    break
        dist = max(dist, 0.5 * a, 0.0005 * raw_e)
        stop = raw_e - side * dist
        target = raw_e + side * dist * spec.exit.target_r if spec.exit.target_r else None
        qty = int(risk_cad / (dist * fx))
        qty = min(qty, int(rk.max_instrument_exposure_x * equity / (raw_e * fx)),
                  int((min(rk.max_total_exposure_x, rk.leverage_ceiling_x) * equity - sum(n for _, n in open_pos)) / (raw_e * fx)),
                  int(ex["participation_cap"] * v[eb]))     # partial fill: the unfilled remainder is cancelled
        if qty < 1:
            continue
        xb, raw_x, reason = simulate_exit(o, h, l, c, eb, side, stop, target, spec.exit.max_hold, hsp[s])
        exit_px = raw_x if reason == "target" else raw_x * (1 - side * cfr[s])
        fee = comm * 2 * max(ex["commission_min_usd"], ex["commission_per_share_usd"] * qty)
        gross = side * (raw_x - raw_e) * qty
        net = side * (exit_px - entry) * qty - fee
        net_cad, gx = net * fx, d * B + xb
        equity += net_cad
        daily[d - d0] += net_cad
        busy[s] = gx + 1
        open_pos.append((gx, qty * raw_e * fx))
        day_closed.append((gx, net_cad))
        day_entries += 1
        trades.append({"s": s, "d": d, "signal_bar": b, "entry_bar": eb, "exit_bar": xb, "side": side, "qty": qty,
                       "entry": float(entry), "exit": float(exit_px), "stop": float(stop), "reason": reason,
                       "gross_cad": float(gross * fx), "net_cad": float(net_cad), "cost_cad": float((gross - net) * fx),
                       "r": float(net / (qty * dist)), "notional_cad": float(qty * raw_e * fx), "regime": int(fs["regime"][s, d, b])})
    return Result(d0, d1, daily, trades, summarize(daily, trades, start), scenario)


def summarize(daily: np.ndarray, trades: list[dict], start: float) -> dict:
    n = len(trades)
    net = np.array([t["net_cad"] for t in trades]) if n else np.zeros(0)
    gross = float(sum(t["gross_cad"] for t in trades))
    cost = float(sum(t["cost_cad"] for t in trades))
    wins, losses = net[net > 0].sum(), -net[net < 0].sum()
    eq = start + np.cumsum(daily)
    tail = np.sort(daily)[:max(1, int(np.ceil(len(daily) * 0.05)))] if len(daily) else np.zeros(1)
    by_reg = {}
    for t in trades:
        r = by_reg.setdefault(str(t["regime"]), {"n": 0, "net_cad": 0.0})
        r["n"] += 1
        r["net_cad"] += t["net_cad"]
    days = max(len(daily), 1)
    return {"days": len(daily), "trades": n, "net_cad": float(daily.sum()), "gross_cad": gross, "cost_cad": cost,
            "sharpe": stats.sharpe(daily / start), "max_dd_cad": stats.max_drawdown(eq) if len(eq) else 0.0,
            "win_rate": float((net > 0).mean()) if n else 0.0, "profit_factor": float(wins / losses) if losses > 0 else (None if wins == 0 else float("inf")),
            "expectancy_cad": float(net.mean()) if n else 0.0, "expectancy_r": float(np.mean([t["r"] for t in trades])) if n else 0.0,
            "trades_per_day": n / days, "exposure": float(sum(t["exit_bar"] - t["entry_bar"] + 1 for t in trades) / (days * B)),
            "turnover_x": float(sum(2 * t["notional_cad"] for t in trades) / (start * days)),
            "cvar5_cad": float(tail.mean()), "worst_day_cad": float(daily.min()) if len(daily) else 0.0,
            "best_day_cad": float(daily.max()) if len(daily) else 0.0, "cost_to_gross": float(cost / gross) if gross > 0 else None,
            "by_regime": by_reg, "return_pct": float(daily.sum() / start * 100)}
