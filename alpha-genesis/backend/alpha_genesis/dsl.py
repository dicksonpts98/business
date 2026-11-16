"""Typed, constrained strategy-definition language shared by Darwin, the Arena, the Skeptic and paper trading.

A strategy is data, not code: a trigger, optional filters and trade-avoidance conditions, an exit
policy and a sizing rule, all validated against the feature registry. Signals are evaluated at a
bar's close and can only be executed at the next bar's open."""
from __future__ import annotations
import hashlib, json
from typing import Literal
import numpy as np
from pydantic import BaseModel, Field, model_validator
from .config import BARS_PER_DAY as B
from .features import REGISTRY
from .liedetector import PATTERN_IDS

FAMILIES = ("event", "feature", "similarity", "ml", "combo", "baseline")


class Cond(BaseModel):
    feat: str
    op: Literal[">", "<"]
    thr: float

    @model_validator(mode="after")
    def _check(self):
        if self.feat not in REGISTRY:
            raise ValueError(f"unknown feature {self.feat!r}")
        lo, hi, _ = REGISTRY[self.feat]
        if not (lo - 1e-9 <= self.thr <= hi + 1e-9):
            raise ValueError(f"threshold {self.thr} outside [{lo}, {hi}] for {self.feat}")
        return self


class Trigger(BaseModel):
    kind: Literal["event", "feature", "model", "random", "passive", "none"]
    patterns: list[str] = []
    invert: bool = False           # event: trade *with* the failed move instead of fading it; feature/model: fade
    feat: str | None = None
    thr: float | None = None
    model_id: str | None = None
    seed: int = 0
    rate: float = Field(0.0, ge=0, le=0.05)

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "event":
            if not self.patterns or any(p not in PATTERN_IDS for p in self.patterns):
                raise ValueError("event trigger needs known pattern ids")
        if self.kind == "feature":
            if self.feat not in REGISTRY or not REGISTRY[self.feat][2]:
                raise ValueError("feature trigger needs a signed registry feature")
            if self.thr is None or not (0 < self.thr <= REGISTRY[self.feat][1]):
                raise ValueError("feature trigger threshold out of range")
        if self.kind == "model" and (not self.model_id or self.thr is None or not (0 < self.thr <= 0.3)):
            raise ValueError("model trigger needs model_id and 0 < thr <= 0.3")
        return self


class Exit(BaseModel):
    max_hold: int = Field(12, ge=2, le=77)
    stop_kind: Literal["atr", "invalidation"] = "atr"
    stop_atr: float = Field(2.0, ge=0.5, le=5.0)
    target_r: float | None = Field(None, ge=0.5, le=5.0)


class StrategySpec(BaseModel):
    family: Literal["event", "feature", "similarity", "ml", "combo", "baseline"]
    trigger: Trigger
    filters: list[Cond] = Field(default_factory=list, max_length=3)
    avoid: list[Cond] = Field(default_factory=list, max_length=2)
    side: Literal["both", "long", "short"] = "both"
    exit: Exit = Field(default_factory=Exit)
    sizing: Literal["fixed_risk", "half_risk"] = "fixed_risk"

    def canonical(self) -> dict:
        def rnd(o):
            if isinstance(o, float): return round(o, 3)
            if isinstance(o, dict): return {k: rnd(v) for k, v in sorted(o.items())}
            if isinstance(o, list): return [rnd(v) for v in o]
            return o
        d = self.model_dump()
        d["trigger"]["patterns"] = sorted(d["trigger"]["patterns"])
        d["filters"] = sorted(d["filters"], key=lambda c: (c["feat"], c["op"], c["thr"]))
        d["avoid"] = sorted(d["avoid"], key=lambda c: (c["feat"], c["op"], c["thr"]))
        return rnd(d)

    def hash(self) -> str:
        return hashlib.sha256(json.dumps(self.canonical(), sort_keys=True).encode()).hexdigest()[:16]

    def elements(self) -> list[str]:
        """Research ingredients, for the knowledge base of what has and has not survived."""
        t = self.trigger
        out = [f"pattern:{p}" for p in t.patterns] + ([f"trigger:{t.feat}"] if t.feat else []) + ([f"model:{t.model_id.split('-')[0]}"] if t.model_id else [])
        return out + [f"filter:{c.feat}" for c in self.filters] + [f"avoid:{c.feat}" for c in self.avoid]

    def uses(self, prefix: str) -> bool:
        t = self.trigger
        return any(c.feat.startswith(prefix) for c in self.filters + self.avoid) or bool(t.feat and t.feat.startswith(prefix))

    def describe(self) -> str:
        t = self.trigger
        if t.kind == "event":
            head = ("Follow" if t.invert else "Fade") + " " + "/".join(t.patterns)
        elif t.kind == "feature":
            head = f"{'Fade' if t.invert else 'Follow'} {t.feat} beyond ±{t.thr:g}"
        elif t.kind == "model":
            head = f"{'Fade' if t.invert else 'Follow'} model {t.model_id} beyond ±{t.thr:g}"
        elif t.kind == "random":
            head = f"Random entries (rate {t.rate:g}, seed {t.seed})"
        elif t.kind == "passive":
            head = "Buy the market proxy at the open, hold to the close"
        else:
            head = "Never trade"
        parts = [head]
        if self.side != "both": parts.append(f"{self.side} only")
        if self.filters: parts.append("when " + " and ".join(f"{c.feat} {c.op} {c.thr:g}" for c in self.filters))
        if self.avoid: parts.append("avoid if " + " or ".join(f"{c.feat} {c.op} {c.thr:g}" for c in self.avoid))
        e = self.exit
        stop = "pattern invalidation" if e.stop_kind == "invalidation" else f"{e.stop_atr:g}×ATR"
        parts.append(f"stop {stop}" + (f", target {e.target_r:g}R" if e.target_r else "") + f", max {e.max_hold} bars")
        return "; ".join(parts)


def _cond(c: Cond, fs) -> np.ndarray:
    a = fs[c.feat]
    with np.errstate(invalid="ignore"):
        return (a > c.thr) if c.op == ">" else (a < c.thr)   # NaN compares False: missing information never passes


def _edge(raw: np.ndarray) -> np.ndarray:
    prev = np.concatenate([np.zeros_like(raw[:, :, :1]), raw[:, :, :-1]], axis=2)
    return np.where(raw != prev, raw, 0)


def signals(spec: StrategySpec, fs, proxy_idx: int = 0, min_day: int = 0) -> np.ndarray:
    """Desired entry direction at each bar close: int8 [S, D, 78]. Uses only columns of the feature store."""
    shape = fs["tod"].shape
    t = spec.trigger
    if t.kind == "none":
        return np.zeros(shape, np.int8)
    if t.kind == "event":
        sig = np.zeros(shape, np.int16)
        for p in t.patterns:
            sig += fs["ev:" + p]
        sig = np.clip(sig, -1, 1)
    elif t.kind in ("feature", "model"):
        a = fs[t.feat] if t.kind == "feature" else fs["ml:" + t.model_id]
        with np.errstate(invalid="ignore"):
            raw = np.where(a > t.thr, 1, np.where(a < -t.thr, -1, 0))
        sig = _edge(raw)
    elif t.kind == "random":
        sig = np.zeros(shape, np.int16)
        for d in range(shape[1]):  # per-session streams: appending sessions never changes earlier draws
            rng = np.random.default_rng([t.seed, d])
            u = rng.random((shape[0], B))
            sig[:, d] = np.where(u < t.rate / 2, 1, np.where(u > 1 - t.rate / 2, -1, 0))
    elif t.kind == "passive":
        sig = np.zeros(shape, np.int16)
        sig[proxy_idx, :, 0] = 1
    if t.invert:
        sig = -sig
    ok = np.ones(shape, bool)
    for c in spec.filters:
        ok &= _cond(c, fs)
    for c in spec.avoid:
        ok &= ~_cond(c, fs)
    sig = np.where(ok, sig, 0)
    if spec.side == "long": sig = np.where(sig > 0, sig, 0)
    if spec.side == "short": sig = np.where(sig < 0, sig, 0)
    if min_day > 0:
        sig[:, :min_day] = 0
    return sig.astype(np.int8)
