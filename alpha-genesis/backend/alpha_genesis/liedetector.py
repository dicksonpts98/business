"""ENGINE 2 — MARKET LIE DETECTOR: failed-pattern detection with real-time-valid definitions.

Each detector is a per-session state machine stepped one bar at a time; at bar b it can read only
bars 0..b and causal features. An event's timestamp is the close of the confirming bar, and the
earliest executable price is the next bar's open. A "failed" pattern is an observable price fact
(break, then re-entry within a window) — it is not evidence of anyone's intent."""
from __future__ import annotations
import numpy as np
from .config import BARS_PER_DAY as B
from .features import OR_BARS, REGISTRY
from .market import Market

PATTERNS = {
    "ORB_FAIL_UP": "Close above the 30-min opening-range high, then a close back below it within 6 bars",
    "ORB_FAIL_DOWN": "Close below the opening-range low, then a close back above it within 6 bars",
    "PDH_FAIL": "Trade above the previous session high, then a close back below it within 4 bars",
    "PDL_FAIL": "Trade below the previous session low, then a close back above it within 4 bars",
    "VWAP_RECLAIM_FAIL": "After ≥6 closes below VWAP, a close above it that is lost again within 3 bars",
    "VWAP_LOSS_FAIL": "After ≥6 closes above VWAP, a close below it that is recovered within 3 bars",
    "MOMO_FAIL_UP": "Three up-closes totalling >1.5σ, then a close below the last momentum bar's low",
    "MOMO_FAIL_DOWN": "Three down-closes totalling >1.5σ, then a close above the last momentum bar's high",
    "RANGE_REENTRY_UP": "Close above the prior 12-bar range, then a close back inside within 4 bars",
    "RANGE_REENTRY_DOWN": "Close below the prior 12-bar range, then a close back inside within 4 bars",
    "SQUEEZE_FAIL": "Volatility compression, a >2σ expansion bar, then >50% of it retraced within 3 bars",
    "VOL_CLIMAX_REV": "Relative volume >2.5 on a new session extreme that closes in the opposite third of its bar",
    "FALSE_BREAKDOWN_RECOVERY": "New session low (after 10:30) that is reclaimed on a close within 3 bars",
    "SWEEP_HIGH_FAIL": "New session high on elevated volume that is lost on a close within 3 bars (liquidity proxy; no quote data)",
}
PATTERN_IDS = list(PATTERNS)


class _Fail:
    """Break of a level in direction `sign`, followed by a close back through it within `window` bars."""
    def __init__(self, sign: int, window: int, by_close: bool, rearm: int | None = None):
        self.sign, self.window, self.by_close, self.rearm = sign, window, by_close, rearm
        self.state, self.since, self.lvl, self.ext, self.cool = 0, 0, np.nan, np.nan, 0

    def step(self, h, l, c, level):
        sg = self.sign
        if self.state == 2:
            if self.rearm is None:
                return None
            self.cool += 1
            if self.cool < self.rearm:
                return None
            self.state = 0
        if self.state == 0:
            if not np.isfinite(level):
                return None
            probe = c if self.by_close else (h if sg > 0 else l)
            if sg * (probe - level) > 0:
                self.state, self.since, self.lvl, self.ext = 1, 0, level, (h if sg > 0 else l)
                if not self.by_close and sg * (c - level) < 0:  # pierced and rejected inside one bar
                    self.state, self.cool = 2, 0
                    return self.lvl, self.ext
            return None
        self.since += 1
        self.ext = max(self.ext, h) if sg > 0 else min(self.ext, l)
        if sg * (c - self.lvl) < 0:
            self.state, self.cool = 2, 0
            return self.lvl, self.ext
        if self.since >= self.window:
            self.state, self.cool = 2, 0
        return None


def detect_session(o, h, l, c, f) -> list[tuple[int, str, int, float, float]]:
    """One symbol-session. o/h/l/c: [78] arrays; f: dict of [78] causal feature arrays.
    Returns (bar, pattern, fade_direction, broken_level, invalidation_level)."""
    out = []
    orb_u, orb_d = _Fail(+1, 6, True), _Fail(-1, 6, True)
    pdh, pdl = _Fail(+1, 4, False), _Fail(-1, 4, False)
    rng_u, rng_d = _Fail(+1, 4, True, rearm=12), _Fail(-1, 4, True, rearm=12)
    swp_l, swp_h = _Fail(-1, 3, False, rearm=6), _Fail(+1, 3, False, rearm=6)
    below = above = 0
    vw_state, vw_since, vw_ext = 0, 0, np.nan
    momo = None   # (dir, trigger_level, extreme)
    sq = None     # (dir, midpoint, extreme, bars_left)
    for b in range(B):
        if not np.isfinite(c[b]):
            continue
        H, L, C, O = h[b], l[b], c[b], o[b]
        r, rv78, rv12 = f["_r"][b], f["_rv78"][b], f["_rv12"][b]
        vwap = f["_vwap"][b]
        if b >= OR_BARS:
            e = orb_u.step(H, L, C, f["_orh"][b])
            if e: out.append((b, "ORB_FAIL_UP", -1, *e))
            e = orb_d.step(H, L, C, f["_orl"][b])
            if e: out.append((b, "ORB_FAIL_DOWN", +1, *e))
        e = pdh.step(H, L, C, f["_pdh"][b])
        if e: out.append((b, "PDH_FAIL", -1, *e))
        e = pdl.step(H, L, C, f["_pdl"][b])
        if e: out.append((b, "PDL_FAIL", +1, *e))
        if b >= 12:
            hi12, lo12 = np.nanmax(h[b - 12:b]), np.nanmin(l[b - 12:b])
            e = rng_u.step(H, L, C, hi12)
            if e: out.append((b, "RANGE_REENTRY_UP", -1, *e))
            e = rng_d.step(H, L, C, lo12)
            if e: out.append((b, "RANGE_REENTRY_DOWN", +1, *e))
            e = swp_l.step(H, L, C, f["_dl"][b - 1])
            if e: out.append((b, "FALSE_BREAKDOWN_RECOVERY", +1, *e))
            rvol = f["rel_vol"][b]
            e = swp_h.step(H, L, C, f["_dh"][b - 1] if (np.isfinite(rvol) and rvol >= 1.5) or swp_h.state == 1 else np.nan)
            if e: out.append((b, "SWEEP_HIGH_FAIL", -1, *e))
        # VWAP reclaim / loss failure
        if vw_state != 0:
            vw_since += 1
            vw_ext = max(vw_ext, H) if vw_state > 0 else min(vw_ext, L)
            if vw_state * (C - vwap) < 0:
                out.append((b, "VWAP_RECLAIM_FAIL" if vw_state > 0 else "VWAP_LOSS_FAIL", -vw_state, float(vwap), float(vw_ext)))
                vw_state = 0
            elif vw_since >= 3:
                vw_state = 0
        elif below >= 6 and C > vwap:
            vw_state, vw_since, vw_ext = 1, 0, H
        elif above >= 6 and C < vwap:
            vw_state, vw_since, vw_ext = -1, 0, L
        below = below + 1 if C < vwap else 0
        above = above + 1 if C > vwap else 0
        # momentum continuation failure (checked on the bar after the 3-bar leg)
        if momo is not None:
            d_, trig, ext = momo
            if d_ * (C - trig) < 0:
                out.append((b, "MOMO_FAIL_UP" if d_ > 0 else "MOMO_FAIL_DOWN", -d_, float(trig), float(max(ext, H) if d_ > 0 else min(ext, L))))
            momo = None
        if b >= 2 and np.isfinite(rv78):
            leg = f["_r"][b - 2:b + 1]
            up, dn = bool(np.all(c[b - 2:b + 1] > o[b - 2:b + 1])), bool(np.all(c[b - 2:b + 1] < o[b - 2:b + 1]))
            if (up or dn) and abs(np.nansum(leg)) > 1.5 * rv78 * np.sqrt(3):
                momo = (1, L, np.nanmax(h[b - 2:b + 1])) if up else (-1, H, np.nanmin(l[b - 2:b + 1]))
        # volatility squeeze -> failed expansion
        if sq is not None:
            d_, mid, ext, left = sq
            ext = max(ext, H) if d_ > 0 else min(ext, L)
            if d_ * (C - mid) < 0:
                out.append((b, "SQUEEZE_FAIL", -d_, float(mid), float(ext)))
                sq = None
            else:
                sq = (d_, mid, ext, left - 1) if left > 1 else None
        elif b >= 1 and np.isfinite(f["vol_ratio"][b - 1]) and f["vol_ratio"][b - 1] < 0.65 and np.isfinite(r) \
                and abs(r) > 2 * f["_rv12"][b - 1]:
            d_ = 1 if r > 0 else -1
            sq = (d_, (O + C) / 2, H if d_ > 0 else L, 3)
        # volume climax reversal
        if b >= OR_BARS and np.isfinite(f["rel_vol"][b]) and f["rel_vol"][b] > 2.5 and H > L:
            pos = (C - L) / (H - L)
            if H >= f["_dh"][b] and pos < 0.35:
                out.append((b, "VOL_CLIMAX_REV", -1, float(H), float(H)))
            elif L <= f["_dl"][b] and pos > 0.65:
                out.append((b, "VOL_CLIMAX_REV", +1, float(L), float(L)))
    return out


def detect(m: Market, fs, d0: int = 0) -> list[dict]:
    """Detect events for sessions [d0, D) and write per-bar columns ev:<PATTERN> (direction) and
    inv:<PATTERN> (invalidation level) into the feature store. Returns event records."""
    S, D = m.S, m.D
    for p in PATTERN_IDS:
        for pre, fill, dt in (("ev:", 0, np.int8), ("inv:", np.nan, float)):
            k = pre + p
            if k not in fs:
                fs.set(k, np.full((S, D, B), fill, dtype=dt))
            elif fs[k].shape[1] < D:
                fs.set(k, np.concatenate([fs[k], np.full((S, D - fs[k].shape[1], B), fill, dtype=dt)], axis=1))
            fs[k][:, d0:] = fill
    keys = ["_r", "_rv78", "_rv12", "_vwap", "_orh", "_orl", "_pdh", "_pdl", "_dh", "_dl", "rel_vol", "vol_ratio"]
    ctx_keys = [k for k in REGISTRY if k in fs]
    events = []
    for s in range(S):
        for d in range(d0, D):
            f = {k: fs[k][s, d] for k in keys}
            for (b, pat, direction, level, inv) in detect_session(m.o[s, d], m.h[s, d], m.l[s, d], m.c[s, d], f):
                fs["ev:" + pat][s, d, b] = direction
                fs["inv:" + pat][s, d, b] = inv
                ctx = {k: (None if not np.isfinite(fs[k][s, d, b]) else round(float(fs[k][s, d, b]), 4)) for k in ctx_keys}
                ctx.update(close=float(m.c[s, d, b]), vwap=float(fs["_vwap"][s, d, b]), atr=float(fs["_atr"][s, d, b]) if np.isfinite(fs["_atr"][s, d, b]) else None,
                           entry_eligible=bool(b < B - 1 and np.isfinite(m.o[s, d, min(b + 1, B - 1)])))
                events.append({"symbol": m.symbols[s], "day": m.days[d].isoformat(), "d": d, "bar": b, "ts": m.ts(d, b),
                               "pattern": pat, "direction": direction, "level": float(level), "invalidation": float(inv), "context": ctx})
    return events


def outcome_stats(m: Market, fs, d0: int, d1: int, cost_bps: dict[str, float], seed: int = 0) -> list[dict]:
    """Historical outcome distributions for each pattern over sessions [d0, d1): fade-direction return from
    the next bar's open, by horizon, entry approach, regime and cost assumption. Day-clustered bootstrap CIs."""
    rng = np.random.default_rng(seed)
    out = []
    cost = np.array([cost_bps[s] for s in m.symbols])
    for pat in PATTERN_IDS:
        ev = fs["ev:" + pat][:, d0:d1]
        ss, dd, bb = np.nonzero(ev)
        if len(ss) == 0:
            out.append({"pattern": pat, "n": 0})
            continue
        dirn = ev[ss, dd, bb].astype(float)
        dd_abs = dd + d0
        reg = fs["regime"][ss, dd_abs, bb]
        row = {"pattern": pat, "definition": PATTERNS[pat], "n": int(len(ss)), "horizons": {}, "by_regime": {},
               "by_hour": {}, "window": [m.days[d0].isoformat(), m.days[d1 - 1].isoformat()]}
        for mode in ("next_open", "confirmed"):
            for hz in (6, 12, 24):
                eb = bb + (1 if mode == "next_open" else 2)
                xb = np.minimum(eb + hz - 1, B - 1)
                ok = eb < B
                e = np.where(ok, m.o[ss, dd_abs, np.minimum(eb, B - 1)], np.nan)
                # exit at the last valid close at or before the horizon
                x = np.array([_last_valid(m.c[s_, d_], b0, b1) for s_, d_, b0, b1 in zip(ss, dd_abs, np.minimum(eb, B - 1), xb)])
                ret = dirn * np.log(x / e) * 1e4
                if mode == "confirmed":  # needs the bar after detection to close in the fade direction
                    conf = dirn * (m.c[ss, dd_abs, np.minimum(bb + 1, B - 1)] - m.o[ss, dd_abs, np.minimum(bb + 1, B - 1)]) > 0
                    ret = np.where(conf, ret, np.nan)
                good = np.isfinite(ret)
                if good.sum() < 5:
                    continue
                rr, days_ = ret[good], dd_abs[good]
                ci = _cluster_ci(rr, days_, rng)
                c_rt = 2 * cost[ss[good]]
                key = f"{mode}:{hz}"
                row["horizons"][key] = {"n": int(good.sum()), "mean_bps": float(rr.mean()), "median_bps": float(np.median(rr)),
                                        "hit_rate": float((rr > 0).mean()), "ci95": ci, "p10": float(np.quantile(rr, .1)), "p90": float(np.quantile(rr, .9)),
                                        "net_base_bps": float((rr - c_rt).mean()), "net_stress_bps": float((rr - 3 * c_rt).mean())}
                if key == "next_open:12":
                    row["hist"] = np.histogram(np.clip(rr, -150, 150), bins=30, range=(-150, 150))[0].tolist()
                    for g in (0, 1, 2):
                        mk = reg[good] == g
                        if mk.sum() >= 5:
                            row["by_regime"][str(g)] = {"n": int(mk.sum()), "mean_bps": float(rr[mk].mean()), "hit_rate": float((rr[mk] > 0).mean()),
                                                        "ci95": _cluster_ci(rr[mk], days_[mk], rng)}
                    hr = (bb[good] // 12)
                    for g in range(7):
                        mk = hr == g
                        if mk.sum() >= 5:
                            row["by_hour"][str(g)] = {"n": int(mk.sum()), "mean_bps": float(rr[mk].mean())}
        out.append(row)
    return out


def _last_valid(c_row, b0, b1):
    seg = c_row[b0:b1 + 1]
    ok = np.isfinite(seg)
    return seg[ok][-1] if ok.any() else np.nan


def _cluster_ci(x, groups, rng, n=300):
    ug, inv = np.unique(groups, return_inverse=True)
    sums, cnts = np.bincount(inv, x), np.bincount(inv)
    idx = rng.integers(0, len(ug), (n, len(ug)))
    means = sums[idx].sum(1) / cnts[idx].sum(1)
    return [float(np.quantile(means, .025)), float(np.quantile(means, .975))]
