"""Synthetic market generator — for controlled algorithmic testing ONLY.

Nothing produced here is historical market data. The generator can plant known, documented
effects so the research pipeline has a positive control (can it find an effect that exists?) and,
with the plants off, a null control (does it refuse to find one that does not?)."""
from __future__ import annotations
from datetime import date
import numpy as np
from . import mcal
from .config import BARS_PER_DAY as B
from .market import Market

PROFILE = {  # beta to market factor, idiosyncratic vol (in units of base bar sigma), price, base bar volume
    "SPY": (1.0, 0.25, 450.0, 9e5), "QQQ": (1.2, 0.40, 380.0, 6e5),
    "NVDA": (1.8, 1.60, 480.0, 5e5), "TSLA": (1.7, 2.00, 250.0, 1.2e6),
}
BASE_SIGMA = 0.0009            # market-factor 5-minute return sigma in the "normal" regime
REGIME_VOL = (0.7, 1.0, 1.6)   # calm, normal, volatile


def generate(symbols: list[str], n_days: int, seed: int = 7, start: date = date(2023, 1, 3),
             plant_orb: float = 0.30, plant_vwap: float = 0.04, decay_start: int | None = None,
             plant_regimes: tuple[int, ...] = (0, 1, 2)) -> Market:
    """plant_orb: reversal drift (in bar sigmas, per bar, for 12 bars) after a failed opening-range break,
    active only in hidden regimes `plant_regimes` and only before session index `decay_start`.
    plant_vwap: pull toward session VWAP in the calm regime. Set both to 0 for a null market."""
    rng = np.random.default_rng(seed)
    days = mcal.trading_days(start, n_days)
    S = len(symbols)
    m = Market(symbols, days, "synthetic", {
        "label": "SYNTHETIC", "generator": "alpha_genesis.synthetic.generate", "seed": seed,
        "planted_effects": ([{"name": "failed_opening_range_reversal", "strength_sigma_per_bar": plant_orb,
                              "bars": 12, "hidden_regimes": list(plant_regimes), "decay_start_session": decay_start}]
                            if plant_orb else []) +
                           ([{"name": "vwap_reversion_calm_regime", "strength": plant_vwap}] if plant_vwap else []),
        "warning": "Synthetic data. Results say nothing about real markets."})
    # hidden regime chain
    reg = np.zeros(n_days, dtype=int)
    reg[0] = 1
    for d in range(1, n_days):
        reg[d] = reg[d - 1] if rng.random() < 0.97 else rng.integers(0, 3)
    m.hidden_regime = reg
    x = np.linspace(0, 1, B)
    ushape = 0.75 + 1.1 * (x - 0.45) ** 2 * 4  # higher vol at open/close
    ushape /= ushape.mean()
    vshape = 0.6 + 2.2 * (x - 0.5) ** 2 * 4
    vshape /= vshape.mean()
    px = np.array([PROFILE.get(s, (1.3, 1.0, 100.0, 5e5))[2] for s in symbols])
    beta = np.array([PROFILE.get(s, (1.3, 1.0, 100.0, 5e5))[0] for s in symbols])
    idio = np.array([PROFILE.get(s, (1.3, 1.0, 100.0, 5e5))[1] for s in symbols])
    bvol = np.array([PROFILE.get(s, (1.3, 1.0, 100.0, 5e5))[3] for s in symbols])
    fx = 1.36
    for d in range(n_days):
        nb = mcal.n_bars(days[d])
        vm = REGIME_VOL[reg[d]]
        sig_m = BASE_SIGMA * vm * ushape
        fac = rng.standard_t(5, B) / np.sqrt(5 / 3) * sig_m
        eps = rng.standard_t(5, (S, B)) / np.sqrt(5 / 3) * (BASE_SIGMA * vm * ushape)[None, :] * idio[:, None]
        gap_f = rng.normal(0, BASE_SIGMA * vm * 4.0)
        wick = np.abs(rng.normal(0, 0.45, (S, B, 2)))
        vnoise = np.exp(rng.normal(0, 0.3, (S, B)))
        plant_on = plant_orb > 0 and reg[d] in plant_regimes and (decay_start is None or d < decay_start)
        fx *= float(np.exp(rng.normal(0, 0.0035)))
        m.fx[d] = fx
        for s in range(S):
            sig = np.sqrt((beta[s] * sig_m) ** 2 + (BASE_SIGMA * vm * ushape * idio[s]) ** 2)
            p = px[s] * np.exp(beta[s] * gap_f + rng.normal(0, BASE_SIGMA * vm * idio[s] * 3.0))
            orh = orl = np.nan
            state, since, drift_left, drift_dir = 0, 0, 0, 0  # state: 0 none, +1 broke up, -1 broke down
            pv = vv = 0.0
            dh, dl = -np.inf, np.inf
            for b in range(nb):
                r = beta[s] * fac[b] + eps[s, b]
                if drift_left > 0:
                    r += drift_dir * plant_orb * sig[b]
                    drift_left -= 1
                if plant_vwap and reg[d] == 0 and vv > 0 and b >= 6:
                    z = np.log(p / (pv / vv)) / (sig[b] * np.sqrt(b + 1))
                    r -= plant_vwap * sig[b] * float(np.clip(z, -3, 3))
                o = p
                c = o * np.exp(r)
                hi = max(o, c) * np.exp(wick[s, b, 0] * sig[b])
                lo = min(o, c) * np.exp(-wick[s, b, 1] * sig[b])
                vol = bvol[s] * vshape[b] * vnoise[s, b] * (1 + 1.5 * abs(r) / sig[b]) * (0.8 + 0.3 * vm)
                m.o[s, d, b], m.h[s, d, b], m.l[s, d, b], m.c[s, d, b], m.v[s, d, b] = o, hi, lo, c, round(vol)
                pv += (hi + lo + c) / 3 * vol
                vv += vol
                dh, dl = max(dh, hi), min(dl, lo)
                if b == 5:
                    orh, orl = dh, dl
                elif b > 5 and plant_on:  # generator-side failed-break state machine
                    if state == 0:
                        if c > orh: state, since = 1, 0
                        elif c < orl: state, since = -1, 0
                    else:
                        since += 1
                        if state == 1 and c < orh and since <= 6:
                            drift_left, drift_dir, state = 12, -1, 2
                        elif state == -1 and c > orl and since <= 6:
                            drift_left, drift_dir, state = 12, +1, 2
                        elif since > 6:
                            state = 2
                p = c
            px[s] = p
    return m
