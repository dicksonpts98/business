"""ENGINE 1 — MARKET DOPPELGÄNGER: historical market-state similarity.

For every decision point the engine looks only at states from *earlier sessions* (labels never cross
a session end, so a one-session embargo removes all label overlap), scales features with statistics of
that earlier library only, and keeps at most one match per historical session to avoid counting the
same episode many times. Each retrieval method is scored out-of-sample against unconditional and
regime-conditional baselines; if none adds measurable skill the engine reports itself disabled."""
from __future__ import annotations
import numpy as np
from . import stats
from .config import BARS_PER_DAY as B
from .features import STATE_FEATURES, REGIME_NAMES, forward_labels
from .market import Market

METHODS = {"knn_z": "Normalised feature distance (z-scored Euclidean nearest neighbours)",
           "knn_regime": "Regime-conditioned retrieval (same volatility regime only)",
           "knn_learned": "Learned metric (features weighted by causal ridge importance)",
           "knn_shape": "Time-series distance on the last hour's normalised return path"}
H, K, STRIDE, MIN_LIB_DAYS, REFIT = 12, 40, 6, 60, 20
GRID = np.arange(12, B - H, STRIDE)   # decision bars with a full lookback path and a full forward window


class Doppelganger:
    def __init__(self, m: Market, fs):
        self.pred = {k: np.full((m.S, 0, B), np.nan) for k in METHODS}      # neighbour-mean label (sigma units)
        self.pup = {k: np.full((m.S, 0, B), np.nan) for k in METHODS}       # raw neighbour share with positive label
        self.base_reg = np.full((m.S, 0, B), np.nan)                         # regime-conditional baseline prediction
        self.done = 0
        self._cache = {}
        self.update(m, fs)

    # -- library construction -------------------------------------------------
    def _rows(self, m: Market, fs):
        """Dense per-session layout [D, S*len(GRID), ...] so 'one match per session' is a vector min."""
        S, D, G = m.S, m.D, len(GRID)
        X = np.stack([fs[k][:, :, GRID] for k in STATE_FEATURES], axis=-1)              # [S, D, G, F]
        r, rv = fs["_r"], fs["_rv78"]
        with np.errstate(all="ignore"):
            path = np.stack([np.nansum(r[:, :, b - 11:b + 1 - j], axis=2) if j else np.nansum(r[:, :, b - 11:b + 1], axis=2)
                             for b in GRID for j in range(11, -1, -1)], axis=-1).reshape(S, D, G, 12)
            path = path / (rv[:, :, GRID, None] * np.sqrt(12))
            path = path - path.mean(axis=-1, keepdims=True)
            fwd, mae = forward_labels(m, H)
            scale = rv[:, :, GRID] * np.sqrt(H)
            y, a = fwd[:, :, GRID] / scale, mae[:, :, GRID] / scale
        tr = lambda z: np.moveaxis(z, 0, 1).reshape(D, S * G, *z.shape[3:])
        X, path, y, a = tr(X), tr(path), tr(y), tr(a)
        ok = np.isfinite(X).all(-1) & np.isfinite(path).all(-1)
        return X, path, y, a, ok

    def update(self, m: Market, fs):
        """(Re)compute walk-forward predictions for sessions not yet processed."""
        S, D, G = m.S, m.D, len(GRID)
        if D == self.done:
            return
        X, path, y, a, ok = self._rows(m, fs)
        self.X, self.path, self.y, self.mae, self.ok = X, path, y, a, ok
        reg = fs["regime"][0, :, 0].astype(int)
        self.reg = reg
        pad = D - self.done
        for k in METHODS:
            self.pred[k] = np.concatenate([self.pred[k], np.full((S, pad, B), np.nan)], axis=1)
            self.pup[k] = np.concatenate([self.pup[k], np.full((S, pad, B), np.nan)], axis=1)
        self.base_reg = np.concatenate([self.base_reg, np.full((S, pad, B), np.nan)], axis=1)
        for d in range(max(self.done, MIN_LIB_DAYS), D):
            sc = self._scaler(d)
            yl, okl = y[:d], ok[:d] & np.isfinite(y[:d])
            same = reg[:d] == reg[d]
            if (okl & same[:, None]).sum() > 50:
                self.base_reg[:, d][:, GRID] = np.nanmean(np.where(okl & same[:, None], yl, np.nan))
            for meth in METHODS:
                Q, L = self._vectors(meth, d, sc)
                dist, arg = self._nearest(Q, L[:d], okl, same if meth == "knn_regime" else None)
                top = np.argsort(dist, axis=1)[:, :K]
                dsel = np.take_along_axis(dist, top, 1)
                ysel = yl[top, np.take_along_axis(arg, top, 1)]
                ysel = np.where(np.isfinite(dsel), ysel, np.nan)
                enough = np.isfinite(ysel).sum(1) >= 10
                with np.errstate(all="ignore"):
                    pm = np.where(enough, np.nanmean(ysel, 1), np.nan)
                    pu = np.where(enough, np.nanmean(np.where(np.isfinite(ysel), ysel > 0, np.nan), 1), np.nan)
                pm = np.where(ok[d], pm, np.nan)
                pu = np.where(ok[d], pu, np.nan)
                self.pred[meth][:, d][:, GRID] = pm.reshape(S, G)
                self.pup[meth][:, d][:, GRID] = pu.reshape(S, G)
        self.done = D

    def _scaler(self, d: int):
        key = (d - MIN_LIB_DAYS) // REFIT
        if self._cache.get("key") != key:
            lib = MIN_LIB_DAYS + key * REFIT            # statistics frozen at the last refit boundary <= d
            Xl, okl = self.X[:lib], self.ok[:lib]
            flat = Xl[okl]
            mu, sd = flat.mean(0), flat.std(0) + 1e-9
            Z, yy = (flat - mu) / sd, self.y[:lib][okl]
            g = np.isfinite(yy)
            Zg, yg = np.clip(Z[g], -5, 5), yy[g]
            beta = np.linalg.solve(Zg.T @ Zg + 50.0 * np.eye(Zg.shape[1]), Zg.T @ yg)
            w = np.abs(beta) / (np.abs(beta).mean() + 1e-12)
            self._cache = {"key": key, "mu": mu, "sd": sd, "w": np.sqrt(np.clip(w, 0.2, 5.0)), "beta": beta}
        return self._cache

    def _vectors(self, meth, d, sc, q=None):
        if meth == "knn_shape":
            return (self.path[d] if q is None else q[1]), self.path
        Z = np.clip((self.X - sc["mu"]) / sc["sd"], -5, 5)
        qz = Z[d] if q is None else np.clip((q[0] - sc["mu"]) / sc["sd"], -5, 5)
        if meth == "knn_learned":
            return qz * sc["w"], Z * sc["w"]
        return qz, Z

    @staticmethod
    def _nearest(Q, L, okl, same_regime):
        """Squared distance from each query to the best-matching row of every earlier session."""
        Qc = np.nan_to_num(Q).astype(np.float32)
        Lc = np.nan_to_num(L).astype(np.float32)
        D_, R_, F_ = Lc.shape
        d2 = (Qc ** 2).sum(-1)[:, None, None] + (Lc ** 2).sum(-1)[None] - 2 * (Qc @ Lc.reshape(-1, F_).T).reshape(len(Qc), D_, R_)
        d2 = np.where(okl[None], np.maximum(d2, 0), np.inf)
        if same_regime is not None:
            d2 = np.where(same_regime[None, :, None], d2, np.inf)
        return d2.min(-1), d2.argmin(-1)

    # -- strategy-language columns -------------------------------------------
    def write_columns(self, fs, method: str, calib: tuple[float, float] | None = None):
        """dop_mean_z / dop_pup, forward-filled within the session from the last decision bar (causal)."""
        def ffill(a):
            a = a.copy()
            for b in range(1, B):
                a[:, :, b] = np.where(np.isfinite(a[:, :, b]), a[:, :, b], a[:, :, b - 1])
            return a
        fs.set("dop_mean_z", ffill(self.pred[method]))
        pu = ffill(self.pup[method])
        if calib is not None:
            pu = np.clip(calib[0] + calib[1] * (pu - 0.5), 0.01, 0.99)
        fs.set("dop_pup", pu)

    # -- evaluation ----------------------------------------------------------
    def evaluate(self, d0: int, d1: int, seed: int = 0) -> dict:
        """Out-of-sample skill of each method over sessions [d0, d1) versus the baselines."""
        rng = np.random.default_rng(seed)
        S = self.pred["knn_z"].shape[0]
        G = len(GRID)
        y = np.moveaxis(self.y[d0:d1].reshape(d1 - d0, S, G), 0, 1)   # [S, D, G]
        days = np.broadcast_to(np.arange(d0, d1)[None, :, None], y.shape)
        out = {}
        base_rate = float(np.nanmean(y > 0)) if np.isfinite(y).any() else 0.5
        for meth in METHODS:
            p = self.pred[meth][:, d0:d1][:, :, GRID]
            pu = self.pup[meth][:, d0:d1][:, :, GRID]
            br = self.base_reg[:, d0:d1][:, :, GRID]
            ok = np.isfinite(p) & np.isfinite(y)
            n = int(ok.sum())
            if n < 500:
                out[meth] = {"n": n, "pass": False, "reason": "insufficient out-of-sample predictions"}
                continue
            yy, pp, pq, dd = y[ok], p[ok], pu[ok], days[ok]
            ud = np.unique(dd)
            # Pooled rank IC with a session-cluster bootstrap. A per-session IC is NOT used: ranking inside one
            # session de-means by that session's realised path, which manufactures a spurious correlation
            # between "move so far" and "move to come" even on a pure random walk.
            from scipy.stats import rankdata
            rx, ry = rankdata(pp), rankdata(yy)
            rx, ry = rx - rx.mean(), ry - ry.mean()
            _, inv = np.unique(dd, return_inverse=True)
            sxy, sxx, syy = np.bincount(inv, rx * ry), np.bincount(inv, rx * rx), np.bincount(inv, ry * ry)
            ic = float(sxy.sum() / np.sqrt(sxx.sum() * syy.sum()))
            nb = int(np.ceil(len(ud) / 5))
            st = rng.integers(0, len(ud), (500, nb))
            idx = ((st[:, :, None] + np.arange(5)[None, None, :]) % len(ud)).reshape(500, -1)
            bs = sxy[idx].sum(1) / np.sqrt(sxx[idx].sum(1) * syy[idx].sum(1))
            # calibration: shrink the raw neighbour share toward 0.5 with a slope fitted on the first half only
            half = dd < np.median(ud)
            slope = float(np.clip(np.polyfit(pq[half] - 0.5, (yy[half] > 0).astype(float), 1)[0], 0, 1)) if half.sum() > 200 else 0.0
            icpt = float((yy[half] > 0).mean()) if half.sum() else 0.5
            cal = np.clip(icpt + slope * (pq - 0.5), 0.01, 0.99)
            hit = (yy > 0).astype(float)
            te = ~half
            brier_m = float(((cal[te] - hit[te]) ** 2).mean())
            brier_b = float(((icpt - hit[te]) ** 2).mean())
            bins = np.clip(((pq - 0.2) / 0.6 * 6).astype(int), 0, 5)
            rel = [{"bin": [round(0.2 + i * 0.1, 2), round(0.3 + i * 0.1, 2)], "n": int((bins == i).sum()),
                    "predicted": float(pq[bins == i].mean()), "calibrated": float(cal[bins == i].mean()), "observed": float(hit[bins == i].mean())}
                   for i in range(6) if (bins == i).sum() >= 30]
            mse_u, mse_m = float((yy ** 2).mean()), float(((yy - pp) ** 2).mean())
            okb = np.isfinite(br[ok])
            mse_r = float(((yy[okb] - br[ok][okb]) ** 2).mean()) if okb.any() else None
            # shrunk prediction skill: is there any slope of outcome on prediction?
            b_ = float(np.polyfit(pp[half], yy[half], 1)[0]) if half.sum() > 200 else 0.0
            mse_s = float(((yy[te] - np.clip(b_, 0, 1) * pp[te]) ** 2).mean())
            mse_u_te = float((yy[te] ** 2).mean())
            res = {"n": n, "ic": ic, "ic_ci90": [float(np.quantile(bs, .05)), float(np.quantile(bs, .95))],
                   "mse_skill_raw_vs_unconditional": 1 - mse_m / mse_u,
                   "mse_skill_shrunk_vs_unconditional": 1 - mse_s / mse_u_te,
                   "mse_regime_baseline": mse_r, "mse_unconditional": mse_u,
                   "brier": brier_m, "brier_base_rate": brier_b, "brier_skill": 1 - brier_m / brier_b,
                   "calibration": {"intercept": icpt, "slope": slope}, "reliability": rel, "base_rate_up": base_rate}
            res["pass"] = bool(res["ic_ci90"][0] > 0 and res["brier_skill"] > 0 and res["mse_skill_shrunk_vs_unconditional"] > 0)
            if not res["pass"]:
                why = []
                if res["ic_ci90"][0] <= 0: why.append("rank-IC lower bound not above zero")
                if res["brier_skill"] <= 0: why.append("calibrated probabilities do not beat the base rate")
                if res["mse_skill_shrunk_vs_unconditional"] <= 0: why.append("no MSE improvement over the unconditional forecast")
                res["reason"] = "; ".join(why)
            out[meth] = res
        return out

    # -- interactive query -----------------------------------------------------
    def query(self, m: Market, fs, s: int, d: int, b: int, method: str = "knn_z", k: int = K) -> dict:
        """Explain one decision point: its fingerprint, the earlier sessions it most resembles, what followed."""
        if d < MIN_LIB_DAYS:
            return {"available": False, "reason": f"needs at least {MIN_LIB_DAYS} earlier sessions"}
        b = int(np.clip(b, 11, B - 1))
        x = np.array([fs[kf][s, d, b] for kf in STATE_FEATURES])
        r, rv = fs["_r"][s, d], fs["_rv78"][s, d, b]
        pth = np.array([np.nansum(r[b - 11:b + 1 - j]) if j else np.nansum(r[b - 11:b + 1]) for j in range(11, -1, -1)]) / (rv * np.sqrt(12))
        pth = pth - pth.mean()
        if not (np.isfinite(x).all() and np.isfinite(pth).all()):
            return {"available": False, "reason": "fingerprint has missing features at this bar"}
        sc = self._scaler(d)
        Q, L = self._vectors(method, d, sc, q=(x[None], pth[None]))
        okl = self.ok[:d] & np.isfinite(self.y[:d])
        dist, arg = self._nearest(Q, L[:d], okl, (self.reg[:d] == self.reg[d]) if method == "knn_regime" else None)
        dist, arg = dist[0], arg[0]
        top = np.argsort(dist)[:k]
        top = top[np.isfinite(dist[top])]
        G, F = len(GRID), len(STATE_FEATURES)
        matches, ys, maes = [], [], []
        for dd in top:
            row = int(arg[dd]); ms, mb = row // G, int(GRID[row % G])
            yv, mv = float(self.y[dd, row]), float(self.mae[dd, row])
            scale = float(fs["_rv78"][ms, dd, mb] * np.sqrt(H))
            ys.append(yv); maes.append(mv)
            matches.append({"symbol": m.symbols[ms], "day": m.days[dd].isoformat(), "d": int(dd), "bar": mb, "ts": m.ts(int(dd), mb),
                            "distance": float(np.sqrt(dist[dd])), "similarity": float(1 / (1 + np.sqrt(dist[dd] / F))),
                            "fwd_sigma": yv, "fwd_bps": yv * scale * 1e4, "mae_sigma": mv, "regime": int(self.reg[dd])})
        ys, maes = np.array(ys), np.array(maes)
        rng = np.random.default_rng(d * 100 + b)
        boot = rng.choice(ys, (500, len(ys))).mean(1) if len(ys) else np.zeros(1)
        lib_typ = float(np.sqrt(np.nanmedian(np.sort(dist[np.isfinite(dist)])[:max(k, 1)]))) if np.isfinite(dist).any() else None
        caveats = []
        if len(ys) < k: caveats.append(f"Only {len(ys)} eligible sessions matched (wanted {k}).")
        if len(top):
            span = (max(top) - min(top))
            if span < 60: caveats.append("Matches cluster within a few months: they may reflect one episode, not a repeatable state.")
            mism = float(np.mean(self.reg[top] != self.reg[d]))
            if mism > 0.5: caveats.append(f"{mism:.0%} of matches come from a different volatility regime.")
            nearest = float(np.sqrt(dist[top[0]]))
            if nearest > 1.5 * np.sqrt(F) * 0.5: caveats.append("Nearest match is far away: the current state is unusual relative to history.")
        caveats.append("Matches are selected on similarity only; a similar past does not imply a similar future.")
        caveats.append("Standard errors assume independent matches; neighbouring sessions are positively dependent, so intervals are optimistic.")
        if m.kind == "synthetic": caveats.append("Library is SYNTHETIC data.")
        by_reg = {REGIME_NAMES[g]: {"n": int((self.reg[top] == g).sum()), "mean_sigma": float(ys[self.reg[top] == g].mean())}
                  for g in (0, 1, 2) if (self.reg[top] == g).sum() >= 3} if len(top) else {}
        return {"available": True, "method": method, "symbol": m.symbols[s], "day": m.days[d].isoformat(), "bar": b, "ts": m.ts(d, b),
                "regime": int(self.reg[d]),
                "fingerprint": [{"feature": kf, "value": float(v), "z": float(z)} for kf, v, z in zip(STATE_FEATURES, x, np.clip((x - sc["mu"]) / sc["sd"], -5, 5))],
                "path": pth.tolist(), "matches": matches, "n": int(len(ys)),
                "forward": {"horizon_bars": H, "mean_sigma": float(ys.mean()) if len(ys) else None, "median_sigma": float(np.median(ys)) if len(ys) else None,
                            "p_up_raw": float((ys > 0).mean()) if len(ys) else None, "mean_ci90": [float(np.quantile(boot, .05)), float(np.quantile(boot, .95))],
                            "hist": np.histogram(np.clip(ys, -3, 3), bins=24, range=(-3, 3))[0].tolist(),
                            "mae_hist": np.histogram(np.clip(maes, -3, 0), bins=12, range=(-3, 0))[0].tolist(),
                            "mae_median_sigma": float(np.median(maes)) if len(maes) else None, "mae_p10_sigma": float(np.quantile(maes, .1)) if len(maes) else None},
                "by_regime": by_reg, "caveats": caveats, "typical_distance": lib_typ}
