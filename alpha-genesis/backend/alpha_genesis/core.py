"""Shared runtime context: configuration, database, market grid, feature store and the engines' state.
Also owns chronological dataset partitioning and the guarded view the research engines must use."""
from __future__ import annotations
import json, time
from dataclasses import dataclass
from pathlib import Path
import numpy as np
from . import backtest, liedetector, models, registry
from .config import BARS_PER_DAY as B, Config
from .db import DB, jd
from .doppelganger import Doppelganger, METHODS
from .dsl import Cond, Exit, StrategySpec, Trigger, signals
from .features import FeatureStore
from .market import Market


class HoldoutAccessError(PermissionError):
    pass


@dataclass(frozen=True)
class Epoch:
    id: int
    dev_start: int
    dev_end: int      # == validation start
    val_end: int      # == holdout start
    holdout_end: int  # == forward start

    def part(self, name: str) -> tuple[int, int]:
        return {"dev": (self.dev_start, self.dev_end), "val": (self.dev_end, self.val_end),
                "holdout": (self.val_end, self.holdout_end)}[name]


class ResearchView:
    """What the strategy generator may touch: development and validation sessions only. Any request
    reaching into the holdout or forward sessions raises, and the attempt is audited."""
    def __init__(self, ctx: "Ctx", actor: str = "darwin"):
        self.ctx, self.actor = ctx, actor

    def run(self, spec: StrategySpec, part: str, scenario: str = "base", d0=None, d1=None) -> backtest.Result:
        ep = self.ctx.epoch
        if part not in ("dev", "val"):
            self.ctx.db.audit(self.actor, "holdout.access_denied", {"part": part})
            raise HoldoutAccessError(f"{self.actor} may not evaluate on {part!r}")
        a, b = ep.part(part)
        d0, d1 = (a if d0 is None else d0), (b if d1 is None else d1)
        if d0 < a or d1 > b:
            self.ctx.db.audit(self.actor, "holdout.access_denied", {"range": [d0, d1]})
            raise HoldoutAccessError("requested sessions fall outside the permitted partition")
        return self.ctx.backtest(spec, d0, d1, scenario)


class Ctx:
    def __init__(self, cfg: Config):
        self.cfg, self.db = cfg, DB(cfg.db_path)
        self.market: Market | None = None
        self.fs: FeatureStore | None = None
        self.dop: Doppelganger | None = None
        self.fail_at: str | None = None      # failure-injection hook used by the recovery tests
        self._sig_cache: dict = {}

    # -- lifecycle -------------------------------------------------------------
    @property
    def bars_dir(self) -> Path: return self.cfg.data_dir / "bars"
    @property
    def reserve_dir(self) -> Path: return self.cfg.data_dir / "feed_reserve"
    @property
    def initialized(self) -> bool: return (self.bars_dir / "_manifest.json").exists() and self.db.one("SELECT 1 FROM epochs") is not None

    def load(self) -> "Ctx":
        """Rebuild all in-memory state from disk (used at every process start)."""
        self.market = Market.load(self.bars_dir)
        self.fs = FeatureStore(self.market, self.cfg.proxy)
        liedetector.detect(self.market, self.fs)
        self.dop = self._load_dop()
        st = self.engine("doppelganger")
        self.dop.write_columns(self.fs, (st or {}).get("method") or "knn_z", (st or {}).get("calib"))
        for r in self.db.q("SELECT id FROM models"):
            models.write_scores(self.db, self.fs, r["id"], self.market.D)
        self._sig_cache.clear()
        return self

    def _load_dop(self) -> Doppelganger:
        cache = self.cfg.data_dir / "dop_cache.npz"
        if cache.exists():
            try:
                z = np.load(cache, allow_pickle=False)
                if int(z["done"]) <= self.market.D and str(z["days0"]) == self.market.days[0].isoformat():
                    dg = Doppelganger.__new__(Doppelganger)
                    dg.pred = {k: z["pred_" + k] for k in METHODS}
                    dg.pup = {k: z["pup_" + k] for k in METHODS}
                    dg.base_reg, dg.done, dg._cache = z["base_reg"], int(z["done"]), {}
                    dg.update(self.market, self.fs)
                    if dg.done == self.market.D and int(z["done"]) == self.market.D:
                        dg.X, dg.path, dg.y, dg.mae, dg.ok = dg._rows(self.market, self.fs)
                        dg.reg = self.fs["regime"][0, :, 0].astype(int)
                    return dg
            except Exception as e:  # corrupt cache: rebuild from bars
                self.db.x("INSERT INTO recovery_log(ts,message) VALUES(?,?)", (time.time(), f"similarity cache unreadable ({e}); rebuilt"))
        dg = Doppelganger(self.market, self.fs)
        self.save_dop(dg)
        return dg

    def save_dop(self, dg=None):
        dg = dg or self.dop
        tmp = self.cfg.data_dir / "dop_cache.tmp.npz"
        np.savez(tmp, done=dg.done, days0=self.market.days[0].isoformat(), base_reg=dg.base_reg,
                 **{"pred_" + k: v for k, v in dg.pred.items()}, **{"pup_" + k: v for k, v in dg.pup.items()})
        tmp.replace(self.cfg.data_dir / "dop_cache.npz")

    # -- partitions --------------------------------------------------------------
    @property
    def epoch(self) -> Epoch:
        r = self.db.one("SELECT * FROM epochs ORDER BY id DESC LIMIT 1")
        return Epoch(r["id"], r["dev_start"], r["dev_end"], r["val_end"], r["holdout_end"])

    def new_epoch(self, holdout_start: int | None = None) -> Epoch:
        """Lock a chronological partition. First epoch: 50/25/25 of the available sessions. Later epochs:
        the holdout is exactly the forward sessions accumulated since the previous lock (never seen by any
        search), and everything earlier — including the previous, already consumed holdout — becomes
        development (2/3) and validation (1/3)."""
        D, days = self.market.D, self.market.days
        warm = 60                                   # sessions needed before features/similarity are fully formed
        if holdout_start is None:
            hs = int(D * 0.75)
        else:
            hs = holdout_start
        dev_end = warm + int((hs - warm) * 2 / 3)
        eid = self.db.x("""INSERT INTO epochs(created,dev_start,dev_end,val_end,holdout_end,dev_start_day,val_start_day,holdout_start_day,holdout_end_day)
                           VALUES(?,?,?,?,?,?,?,?,?)""", (time.time(), warm, dev_end, hs, D, days[warm].isoformat(), days[dev_end].isoformat(),
                                                          days[hs].isoformat(), days[D - 1].isoformat()))
        self.db.audit("system", "epoch.locked", {"epoch": eid, "dev": [warm, dev_end], "val": [dev_end, hs], "holdout": [hs, D]})
        return self.epoch

    def holdout_uses(self, epoch_id: int | None = None) -> int:
        return self.db.one("SELECT COUNT(*) n FROM holdout_ledger WHERE epoch=?", (epoch_id or self.epoch.id,))["n"]

    def consume_holdout(self, subject: str, purpose: str) -> bool:
        """Record a holdout evaluation. Returns False if this subject already used it for this purpose."""
        try:
            self.db.x("INSERT INTO holdout_ledger(ts,epoch,subject,purpose) VALUES(?,?,?,?)", (time.time(), self.epoch.id, subject, purpose))
        except Exception:
            return False
        self.db.audit("skeptic", "holdout.consumed", {"epoch": self.epoch.id, "subject": subject, "purpose": purpose})
        return True

    # -- shared evaluation ---------------------------------------------------------
    def min_day(self, spec: StrategySpec) -> int:
        mid = spec.trigger.model_id
        if not mid:
            return 0
        r = self.db.one("SELECT train_end FROM models WHERE id=?", (mid,))
        return int(r["train_end"]) if r else 10 ** 9

    def signals(self, spec: StrategySpec) -> np.ndarray:
        h = (spec.hash(), self.market.D)
        if h not in self._sig_cache:
            if len(self._sig_cache) > 400:
                self._sig_cache.clear()
            self._sig_cache[h] = signals(spec, self.fs, self.market.sidx(self.cfg.proxy), self.min_day(spec))
        return self._sig_cache[h]

    def backtest(self, spec: StrategySpec, d0: int, d1: int, scenario: str = "base", sig=None, equity0=None) -> backtest.Result:
        return backtest.run(spec, self.market, self.fs, self.cfg, d0, d1, scenario, sig=self.signals(spec) if sig is None else sig, equity0=equity0)

    # -- engine status ---------------------------------------------------------------
    def engine(self, name: str) -> dict | None:
        r = self.db.one("SELECT * FROM engine_status WHERE engine=?", (name,))
        if not r:
            return None
        d = json.loads(r["detail"])
        d["enabled"] = bool(r["enabled"])
        return d

    def set_engine(self, name: str, enabled: bool, detail: dict):
        self.db.x("INSERT INTO engine_status(engine,enabled,detail,updated) VALUES(?,?,?,?) ON CONFLICT(engine) DO UPDATE SET enabled=excluded.enabled, detail=excluded.detail, updated=excluded.updated",
                  (name, int(enabled), jd(detail), time.time()))

    def gate_doppelganger(self):
        """Enable similarity features for strategy search only if a method shows out-of-sample skill on the
        development + validation sessions (the holdout is not consulted)."""
        ep = self.epoch
        ev = self.dop.evaluate(ep.dev_start, ep.val_end)
        passing = {k: v for k, v in ev.items() if v.get("pass")}
        method = max(passing, key=lambda k: passing[k]["ic"]) if passing else "knn_z"
        cal = ev[method].get("calibration")
        calib = (cal["intercept"], cal["slope"]) if cal else None
        self.set_engine("doppelganger", bool(passing), {"method": method, "calib": calib, "evaluation": ev, "epoch": ep.id,
                        "window": [self.market.days[ep.dev_start].isoformat(), self.market.days[ep.val_end - 1].isoformat()],
                        "reason": "skill detected" if passing else "no retrieval method beat the unconditional and base-rate baselines; contribution to strategy selection disabled"})
        self.dop.write_columns(self.fs, method, calib)
        self._sig_cache.clear()
        return bool(passing)

    # -- baselines ---------------------------------------------------------------------
    def baseline_specs(self) -> dict[str, StrategySpec]:
        logit = self.db.one("SELECT id FROM models WHERE kind='logit' ORDER BY version DESC LIMIT 1")
        out = {
            "BASE-NO-TRADE": StrategySpec(family="baseline", trigger=Trigger(kind="none")),
            "BASE-RANDOM": StrategySpec(family="baseline", trigger=Trigger(kind="random", rate=0.006, seed=1234), exit=Exit(max_hold=12, stop_atr=2.0)),
            "BASE-PASSIVE": StrategySpec(family="baseline", trigger=Trigger(kind="passive"), exit=Exit(max_hold=77, stop_atr=5.0)),
            "BASE-MOMENTUM-ORB": StrategySpec(family="baseline", trigger=Trigger(kind="feature", feat="or_pos", thr=0.5), exit=Exit(max_hold=24, stop_atr=2.5)),
            "BASE-MEANREV-VWAP": StrategySpec(family="baseline", trigger=Trigger(kind="feature", feat="vwap_z", thr=2.0, invert=True), exit=Exit(max_hold=12, stop_atr=2.5)),
            "BASE-FAILED-BREAKOUT": StrategySpec(family="baseline", trigger=Trigger(kind="event", patterns=["ORB_FAIL_UP", "ORB_FAIL_DOWN", "PDH_FAIL", "PDL_FAIL"]),
                                                 exit=Exit(max_hold=12, stop_kind="invalidation")),
            "BASE-SIMILARITY": StrategySpec(family="baseline", trigger=Trigger(kind="feature", feat="dop_mean_z", thr=0.25), exit=Exit(max_hold=12, stop_atr=2.5)),
        }
        if logit:
            out[f"BASE-ML-{logit['id'].upper()}"] = StrategySpec(family="baseline", trigger=Trigger(kind="model", model_id=logit["id"], thr=0.03),
                                                                 exit=Exit(max_hold=12, stop_atr=2.5))
        return out

    def ensure_baselines(self):
        for name, spec in self.baseline_specs().items():
            if not self.db.one("SELECT 1 FROM strategies WHERE id=?", (name + "-v1",)):
                registry.register(self.db, spec, status="BASELINE", name=name, epoch=None)

    def store_events(self, events: list[dict]):
        with self.db.tx() as c:
            c.executemany("INSERT OR IGNORE INTO events(symbol,day,d,bar,ts,pattern,direction,level,invalidation,context) VALUES(?,?,?,?,?,?,?,?,?,?)",
                          [(e["symbol"], e["day"], e["d"], e["bar"], e["ts"], e["pattern"], e["direction"], e["level"], e["invalidation"], jd(e["context"])) for e in events])
