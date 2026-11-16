"""Dependency-aware statistics used by the Skeptic, the Arena and the engine gates."""
from __future__ import annotations
import numpy as np
from scipy import stats as ss

EULER = 0.5772156649015329


def block_bootstrap_means(x: np.ndarray, block: int, n: int, rng) -> np.ndarray:
    """Circular block bootstrap of the mean of a (daily) series."""
    x = np.asarray(x, float)
    T = len(x)
    if T == 0:
        return np.zeros(n)
    block = max(1, min(block, T))
    nb = int(np.ceil(T / block))
    starts = rng.integers(0, T, (n, nb))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % T
    return x[idx.reshape(n, -1)[:, :T]].mean(axis=1)


def paired_prob_better(a: np.ndarray, b: np.ndarray, block: int, n: int, rng) -> float:
    """P(mean(a) > mean(b)) under a paired block bootstrap of daily differences."""
    d = np.asarray(a, float) - np.asarray(b, float)
    if len(d) == 0 or not np.any(d != 0):
        return 0.5
    return float((block_bootstrap_means(d, block, n, rng) > 0).mean())


def sharpe(daily: np.ndarray) -> float:
    daily = np.asarray(daily, float)
    sd = daily.std(ddof=1) if len(daily) > 1 else 0.0
    return float(daily.mean() / sd * np.sqrt(252)) if sd > 0 else 0.0


def deflated_sharpe(daily: np.ndarray, n_trials: int, trial_sharpes: np.ndarray | None = None) -> dict:
    """Bailey & López de Prado (2014). Probability that the true (per-period) Sharpe exceeds the maximum
    expected from `n_trials` unskilled trials, adjusting for sample length, skew and kurtosis."""
    r = np.asarray(daily, float)
    T = len(r)
    sd = r.std(ddof=1) if T > 1 else 0.0
    if T < 10 or sd == 0:
        return {"dsr": 0.0, "sr": 0.0, "sr0": 0.0, "n_trials": int(n_trials)}
    sr = r.mean() / sd
    sk, ku = float(ss.skew(r)), float(ss.kurtosis(r, fisher=False))
    if trial_sharpes is not None and len(trial_sharpes) > 1:
        v = float(np.var(np.asarray(trial_sharpes, float) / np.sqrt(252), ddof=1))
    else:
        v = 1.0 / T
    N = max(int(n_trials), 1)
    if N > 1:
        emax = np.sqrt(v) * ((1 - EULER) * ss.norm.ppf(1 - 1 / N) + EULER * ss.norm.ppf(1 - 1 / (N * np.e)))
    else:
        emax = 0.0
    den = np.sqrt(max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr ** 2))
    dsr = float(ss.norm.cdf((sr - emax) * np.sqrt(T - 1) / den))
    return {"dsr": dsr, "sr": float(sr * np.sqrt(252)), "sr0": float(emax * np.sqrt(252)), "n_trials": N, "skew": sk, "kurt": ku}


def pbo_cscv(M: np.ndarray, S: int = 8, max_splits: int = 70) -> dict:
    """Probability of backtest overfitting via combinatorially symmetric cross-validation.
    M: [T, N] daily P&L of N candidate configurations. PBO = share of splits in which the in-sample
    best ranks below the out-of-sample median."""
    from itertools import combinations
    T, N = M.shape
    if N < 4 or T < S * 5:
        return {"pbo": None, "reason": f"not applicable (N={N}, T={T})"}
    blocks = np.array_split(np.arange(T), S)
    combos = list(combinations(range(S), S // 2))
    if len(combos) > max_splits:
        combos = [combos[i] for i in np.linspace(0, len(combos) - 1, max_splits).astype(int)]
    logits = []
    for tr in combos:
        tri = np.concatenate([blocks[i] for i in tr])
        tei = np.concatenate([blocks[i] for i in range(S) if i not in tr])
        def sr(X):
            sd = X.std(axis=0)
            return np.where(sd > 0, X.mean(axis=0) / np.where(sd > 0, sd, 1), 0.0)
        best = int(np.argmax(sr(M[tri])))
        oos = sr(M[tei])
        w = (ss.rankdata(oos)[best]) / (N + 1)
        logits.append(np.log(w / (1 - w)))
    logits = np.array(logits)
    return {"pbo": float((logits <= 0).mean()), "n_splits": len(combos), "n_configs": int(N), "median_logit": float(np.median(logits))}


def psi(ref: np.ndarray, cur: np.ndarray, bins: int = 10) -> float:
    """Population stability index between a reference and a current sample."""
    ref, cur = ref[np.isfinite(ref)], cur[np.isfinite(cur)]
    if len(ref) < 50 or len(cur) < 50:
        return float("nan")
    edges = np.unique(np.quantile(ref, np.linspace(0, 1, bins + 1)))
    if len(edges) < 3:
        return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    p = np.histogram(ref, edges)[0] / len(ref)
    q = np.histogram(cur, edges)[0] / len(cur)
    p, q = np.clip(p, 1e-4, None), np.clip(q, 1e-4, None)
    return float(np.sum((q - p) * np.log(q / p)))


def bh_fdr(pvals: list[float], alpha: float) -> list[bool]:
    """Benjamini–Hochberg: which hypotheses survive at false-discovery rate alpha."""
    p = np.asarray(pvals, float)
    n = len(p)
    if n == 0:
        return []
    order = np.argsort(p)
    thr = alpha * (np.arange(1, n + 1)) / n
    ok = p[order] <= thr
    k = np.max(np.where(ok)[0]) + 1 if ok.any() else 0
    out = np.zeros(n, bool)
    out[order[:k]] = True
    return out.tolist()


def t_pvalue_pos(x: np.ndarray) -> float:
    """One-sided p-value that mean(x) > 0 (t-test; x should be weakly dependent, e.g. daily P&L)."""
    x = np.asarray(x, float)
    if len(x) < 3 or x.std(ddof=1) == 0:
        return 1.0
    t = x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))
    return float(1 - ss.t.cdf(t, len(x) - 1))


def spearman(a, b) -> float:
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 10:
        return float("nan")
    return float(ss.spearmanr(a[ok], b[ok]).statistic)


def max_drawdown(equity: np.ndarray) -> float:
    if len(equity) == 0:
        return 0.0
    peak = np.maximum.accumulate(equity)
    return float((equity - peak).min())
