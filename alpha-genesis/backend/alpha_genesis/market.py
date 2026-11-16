"""Market store: bars on a dense (symbol, session, 5-minute slot) grid with NaN for missing bars.

Persisted as Parquet (one long-format file per symbol) with a sha256 checksum and a dataset version
row per write. USD/CAD is a separate daily series so CAD risk never silently borrows a stale rate."""
from __future__ import annotations
import hashlib, json, time
from datetime import date
from pathlib import Path
import numpy as np
import pandas as pd
from . import mcal
from .config import BARS_PER_DAY as B

FIELDS = ("o", "h", "l", "c", "v")
COLS = {"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"}


class Market:
    def __init__(self, symbols: list[str], days: list[date], kind: str, provenance: dict | None = None):
        self.symbols, self.days, self.kind = list(symbols), list(days), kind
        self.provenance = provenance or {}
        S, D = len(symbols), len(days)
        for f in FIELDS:
            setattr(self, f, np.full((S, D, B), np.nan))
        self.fx = np.full(D, np.nan)          # USD->CAD, as known at the session open
        self.fx_asof = list(days)             # date each rate was observed
        self.version = 0

    # -- shape helpers -------------------------------------------------------
    @property
    def S(self): return len(self.symbols)
    @property
    def D(self): return len(self.days)
    def sidx(self, sym): return self.symbols.index(sym)
    def didx(self, day: date): return self.days.index(day)
    @property
    def valid(self): return np.isfinite(self.c)

    def ts(self, d: int, bar: int) -> str:
        """ISO UTC timestamp of the *close* of a bar: the moment its information becomes available."""
        return mcal.bar_open_utc(self.days[d], bar + 1).isoformat()

    def append_days(self, n: int, days: list[date]):
        for f in FIELDS:
            a = getattr(self, f)
            setattr(self, f, np.concatenate([a, np.full((self.S, n, B), np.nan)], axis=1))
        self.fx = np.concatenate([self.fx, np.full(n, np.nan)])
        self.days += days
        self.fx_asof += days

    def truncated(self, D: int) -> "Market":
        m = Market(self.symbols, self.days[:D], self.kind, self.provenance)
        for f in FIELDS:
            setattr(m, f, getattr(self, f)[:, :D].copy())
        m.fx, m.fx_asof = self.fx[:D].copy(), self.fx_asof[:D]
        return m

    # -- long <-> grid -------------------------------------------------------
    def to_long(self, s: int, d0: int = 0, d1: int | None = None) -> pd.DataFrame:
        d1 = self.D if d1 is None else d1
        base = np.array([np.datetime64(mcal.bar_open_utc(d, 0).replace(tzinfo=None), "ns") for d in self.days[d0:d1]])
        grid = (base[:, None] + (np.arange(B) * 5).astype("timedelta64[m]")[None, :]) if len(base) else np.zeros((0, B), "datetime64[ns]")
        ok = self.valid[s, d0:d1]
        out = pd.DataFrame({"timestamp": pd.to_datetime(grid[ok]).tz_localize("UTC")})
        for f in FIELDS:
            out[COLS[f]] = getattr(self, f)[s, d0:d1][ok]
        out["symbol"] = self.symbols[s]
        return out

    def put_long(self, df: pd.DataFrame) -> int:
        """Write validated long-format bars (UTC bar-open timestamps) onto the grid. Returns bars written."""
        n = 0
        dmap = {d: i for i, d in enumerate(self.days)}
        for row in df.itertuples(index=False):
            bi = mcal.bar_index(row.timestamp.to_pydatetime())
            if bi is None or bi[0] not in dmap or row.symbol not in self.symbols:
                continue
            s, d, b = self.sidx(row.symbol), dmap[bi[0]], bi[1]
            self.o[s, d, b], self.h[s, d, b], self.l[s, d, b] = row.open, row.high, row.low
            self.c[s, d, b], self.v[s, d, b] = row.close, row.volume
            n += 1
        return n

    # -- persistence ---------------------------------------------------------
    def save(self, root: Path, db=None, label: str = "bars") -> str:
        root.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256()
        for s, sym in enumerate(self.symbols):
            p = root / f"{sym}.parquet"
            tmp = p.with_suffix(".tmp")
            self.to_long(s).to_parquet(tmp, index=False)
            tmp.replace(p)
            h.update(p.read_bytes())
        fx = pd.DataFrame({"day": [d.isoformat() for d in self.days], "usdcad": self.fx,
                           "asof": [d.isoformat() for d in self.fx_asof]})
        fx.to_parquet(root / "_fx.parquet", index=False)
        h.update((root / "_fx.parquet").read_bytes())
        self.version += 1
        manifest = {"symbols": self.symbols, "days": [d.isoformat() for d in self.days], "kind": self.kind,
                    "provenance": self.provenance, "version": self.version, "checksum": h.hexdigest()}
        (root / "_manifest.json").write_text(json.dumps(manifest))
        if db is not None:
            db.x("INSERT INTO datasets(label,kind,version,checksum,provenance,n_days,created) VALUES(?,?,?,?,?,?,?)",
                 (label, self.kind, self.version, h.hexdigest(), json.dumps(self.provenance), self.D, time.time()))
        return h.hexdigest()

    @classmethod
    def load(cls, root: Path, verify: bool = True) -> "Market":
        man = json.loads((root / "_manifest.json").read_text())
        days = [date.fromisoformat(x) for x in man["days"]]
        m = cls(man["symbols"], days, man["kind"], man["provenance"])
        m.version = man["version"]
        h = hashlib.sha256()
        dmap = {d: i for i, d in enumerate(days)}
        for s, sym in enumerate(m.symbols):
            p = root / f"{sym}.parquet"
            h.update(p.read_bytes())
            df = pd.read_parquet(p)
            if len(df) == 0:
                continue
            loc = df["timestamp"].dt.tz_convert("America/New_York")
            di = np.array([dmap[x] for x in loc.dt.date])
            bi = ((loc.dt.hour * 60 + loc.dt.minute - 570) // 5).to_numpy()
            for f in FIELDS:
                getattr(m, f)[s, di, bi] = df[COLS[f]].to_numpy()
        fx = pd.read_parquet(root / "_fx.parquet")
        h.update((root / "_fx.parquet").read_bytes())
        m.fx = fx["usdcad"].to_numpy().copy()
        m.fx_asof = [date.fromisoformat(x) for x in fx["asof"]]
        if verify and h.hexdigest() != man["checksum"]:
            raise IOError(f"dataset checksum mismatch in {root}: files were modified or corrupted")
        return m
