"""Point-in-time feature construction.

Every feature at (symbol, session d, bar b) is a function of bars up to and including the close of
bar b. Lookbacks are bounded (<= LOOKBACK_DAYS sessions) so incremental and batch computation agree,
which the leakage tests assert by truncating the future and recomputing."""
from __future__ import annotations
import numpy as np
import pandas as pd
from .config import BARS_PER_DAY as B
from .market import Market

LOOKBACK_DAYS = 22
OR_BARS = 6  # 30-minute opening range

# name -> (low, high, signed): the legal threshold range for the strategy language
REGISTRY: dict[str, tuple[float, float, bool]] = {
    "ret_3_z": (-3, 3, True), "ret_12_z": (-3, 3, True), "ret_day_z": (-3, 3, True), "gap_z": (-2.5, 2.5, True),
    "vwap_z": (-3, 3, True), "trend_z": (-3, 3, True), "mkt_rs_z": (-3, 3, True), "or_pos": (-3, 3, True),
    "pd_pos": (-3, 3, True), "range_pos": (0, 1, False), "rel_vol": (0.3, 3, False), "vol_ratio": (0.4, 2.5, False),
    "illiq_ratio": (0.4, 2.5, False), "tod": (0.08, 0.92, False), "regime": (0, 2, False), "mkt_trend": (-1, 1, False),
    "dop_mean_z": (-2, 2, True), "dop_pup": (0.35, 0.65, False),
}
BASE_FEATURES = [k for k in REGISTRY if not k.startswith("dop_")]
STATE_FEATURES = ["ret_3_z", "ret_12_z", "ret_day_z", "gap_z", "vwap_z", "trend_z", "mkt_rs_z", "range_pos",
                  "rel_vol", "vol_ratio", "illiq_ratio", "tod"]  # the market-state fingerprint
REGIME_NAMES = {0: "calm", 1: "normal", 2: "volatile"}


def _roll(a2: np.ndarray, n: int, fn: str, minp: int | None = None) -> np.ndarray:
    """Rolling statistic along the flattened time axis of an [S, T] array."""
    r = pd.DataFrame(a2.T).rolling(n, min_periods=minp or max(2, n // 2))
    return getattr(r, fn)().to_numpy().T


def daily_regime(m: Market, proxy: str) -> tuple[np.ndarray, np.ndarray]:
    """Causal market regime per session, known before the open: tercile of trailing 20-session realised
    vol versus its own trailing 250-session history; trend sign of the trailing 20-session return."""
    s = m.sidx(proxy)
    c, o = m.c[s], m.o[s]
    prev = np.concatenate([o[:, :1], c[:, :-1]], axis=1)
    r = np.log(c / prev)
    with np.errstate(all="ignore"):
        rv = np.nanstd(r, axis=1) * np.sqrt(B)
    last = np.array([row[np.isfinite(row)][-1] if np.isfinite(row).any() else np.nan for row in c])
    D = m.D
    reg, trend = np.ones(D, dtype=np.int8), np.ones(D, dtype=np.int8)
    vol20 = np.full(D, np.nan)
    for d in range(D):
        if d >= 5:
            vol20[d] = np.nanmean(rv[max(0, d - 20):d])
        hist = vol20[max(0, d - 250):d]
        hist = hist[np.isfinite(hist)]
        if len(hist) >= 40 and np.isfinite(vol20[d]):
            pct = (hist < vol20[d]).mean()
            reg[d] = 0 if pct < 1 / 3 else (2 if pct > 2 / 3 else 1)
        if d >= 21 and np.isfinite(last[d - 1]) and np.isfinite(last[d - 21]):
            trend[d] = 1 if last[d - 1] >= last[d - 21] else -1
    return reg, trend


def compute(m: Market, proxy: str, d0: int = 0) -> dict[str, np.ndarray]:
    """Features and reference levels for sessions [d0, D). Arrays are [S, D-d0, 78]."""
    lo = max(0, d0 - LOOKBACK_DAYS)
    o, h, l, c, v = (getattr(m, f)[:, lo:] for f in "ohlcv")
    S, D, _ = c.shape
    ok = np.isfinite(c)
    with np.errstate(all="ignore"):
        prev_c = np.concatenate([o[:, :, :1], c[:, :, :-1]], axis=2)          # gap excluded from bar returns
        r = np.log(c / prev_c)
        R = r.reshape(S, -1)
        rv12, rv78 = _roll(R, 12, "std").reshape(S, D, B), _roll(R, 78, "std", 40).reshape(S, D, B)
        s3, s12 = _roll(R, 3, "sum", 3).reshape(S, D, B), _roll(R, 12, "sum", 12).reshape(S, D, B)
        day_open = o[:, :, :1]
        last_c = np.full((S, D), np.nan)
        for s in range(S):
            for d in range(D):
                row = c[s, d][ok[s, d]]
                if len(row):
                    last_c[s, d] = row[-1]
        pdc = np.concatenate([np.full((S, 1), np.nan), last_c[:, :-1]], axis=1)[:, :, None]
        dh, dl = np.fmax.accumulate(h, axis=2), np.fmin.accumulate(l, axis=2)
        pdh = np.concatenate([np.full((S, 1), np.nan), np.nanmax(h, axis=2)[:, :-1]], axis=1)[:, :, None]
        pdl = np.concatenate([np.full((S, 1), np.nan), np.nanmin(l, axis=2)[:, :-1]], axis=1)[:, :, None]
        tp = (h + l + c) / 3
        vwap = np.nancumsum(np.where(ok, tp * v, 0), axis=2) / np.maximum(np.nancumsum(np.where(ok, v, 0), axis=2), 1e-9)
        tr = np.maximum(h, prev_c) - np.minimum(l, prev_c)
        atr = _roll(tr.reshape(S, -1), 14, "mean", 7).reshape(S, D, B)
        sma = _roll(c.reshape(S, -1), 78, "mean", 40).reshape(S, D, B)
        bidx = np.arange(B)[None, None, :]
        ret_day = np.log(c / day_open)
        scale_day = rv78 * np.sqrt(bidx + 1)
        rvd = np.nanstd(r, axis=2) * np.sqrt(B)
        rvd_prior = pd.DataFrame(rvd.T).rolling(20, min_periods=5).mean().shift(1).to_numpy().T[:, :, None]
        vmean = np.stack([pd.DataFrame(v[s]).rolling(20, min_periods=10).mean().shift(1).to_numpy() for s in range(S)])
        ill = np.abs(r) / np.maximum(c * v, 1.0)
        ill12, ill78 = _roll(ill.reshape(S, -1), 12, "mean").reshape(S, D, B), _roll(ill.reshape(S, -1), 78, "mean", 40).reshape(S, D, B)
        orh = np.where(bidx >= OR_BARS - 1, dh[:, :, OR_BARS - 1:OR_BARS], np.nan)
        orl = np.where(bidx >= OR_BARS - 1, dl[:, :, OR_BARS - 1:OR_BARS], np.nan)
        px = m.sidx(proxy)
        f = {
            "ret_3_z": s3 / (rv78 * np.sqrt(3)), "ret_12_z": s12 / (rv78 * np.sqrt(12)),
            "ret_day_z": ret_day / scale_day, "gap_z": np.broadcast_to(np.log(day_open / pdc) / rvd_prior, c.shape).copy(),
            "vwap_z": np.log(c / vwap) / (rv78 * np.sqrt(12)), "trend_z": np.log(c / sma) / (rv78 * np.sqrt(B)),
            "mkt_rs_z": (ret_day - ret_day[px:px + 1]) / scale_day,
            "or_pos": np.where(c > orh, (c - orh) / atr, np.where(c < orl, (c - orl) / atr, 0.0)),
            "pd_pos": np.where(c > pdh, (c - pdh) / atr, np.where(c < pdl, (c - pdl) / atr, 0.0)),
            "range_pos": (c - dl) / np.maximum(dh - dl, 1e-9), "rel_vol": v / vmean, "vol_ratio": rv12 / rv78,
            "illiq_ratio": ill12 / ill78, "tod": np.broadcast_to((bidx + 1) / B, c.shape).astype(float).copy(),
            # levels / raw series used by detectors, sizing and labels (not thresholdable features)
            "_r": r, "_rv12": rv12, "_rv78": rv78, "_atr": atr, "_vwap": vwap, "_dh": dh, "_dl": dl,
            "_orh": np.broadcast_to(orh, c.shape).copy(), "_orl": np.broadcast_to(orl, c.shape).copy(),
            "_pdh": np.broadcast_to(pdh, c.shape).copy(), "_pdl": np.broadcast_to(pdl, c.shape).copy(),
        }
    reg, trend = daily_regime(m, proxy)
    f["regime"] = np.broadcast_to(reg[lo:][None, :, None], c.shape).astype(float).copy()
    f["mkt_trend"] = np.broadcast_to(trend[lo:][None, :, None], c.shape).astype(float).copy()
    for k in f:
        a = f[k][:, d0 - lo:]
        a = np.where(np.isfinite(a), a, np.nan)
        if not k.startswith("_"):
            a = np.where(ok[:, d0 - lo:], a, np.nan)
        f[k] = a
    return f


def forward_labels(m: Market, horizon: int = 12) -> tuple[np.ndarray, np.ndarray]:
    """Label for a decision at the close of bar b: return from the open of b+1 to the close of b+horizon,
    never crossing the session end (NaN when the window does not fit), and the worst adverse excursion
    for a long over that window. Labels use the future by definition and are only joined to rows whose
    whole window lies before the query time."""
    S, D, _ = m.c.shape
    fwd, mae = np.full((S, D, B), np.nan), np.full((S, D, B), np.nan)
    for b in range(B - horizon):
        e = m.o[:, :, b + 1]
        x = m.c[:, :, b + horizon]
        with np.errstate(all="ignore"):
            fwd[:, :, b] = np.log(x / e)
            seg = m.l[:, :, b + 1:b + horizon + 1]
            mae[:, :, b] = np.log(np.where(np.isfinite(seg).any(axis=2), np.nanmin(np.where(np.isfinite(seg), seg, np.inf), axis=2), np.nan) / e)
    return fwd, mae


class FeatureStore:
    """All per-bar columns the strategy language can read, extended one session at a time."""
    def __init__(self, m: Market, proxy: str):
        self.proxy = proxy
        self.f = compute(m, proxy, 0)
        self.D = m.D

    def extend(self, m: Market):
        if m.D == self.D:
            return
        new = compute(m, self.proxy, self.D)
        for k, a in new.items():
            self.f[k] = np.concatenate([self.f[k], a], axis=1)
        for k in self.f:
            if self.f[k].shape[1] < m.D:  # columns owned by other engines (events, similarity, models)
                pad = np.full((self.f[k].shape[0], m.D - self.f[k].shape[1], B), np.nan if self.f[k].dtype.kind == "f" else 0, dtype=self.f[k].dtype)
                self.f[k] = np.concatenate([self.f[k], pad], axis=1)
        self.D = m.D

    def __getitem__(self, k): return self.f[k]
    def __contains__(self, k): return k in self.f
    def set(self, k, a): self.f[k] = a
