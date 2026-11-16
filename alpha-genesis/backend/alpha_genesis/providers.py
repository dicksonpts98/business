"""Market-data providers behind one interface. Research engines only ever see a Market grid."""
from __future__ import annotations
from abc import ABC, abstractmethod
from datetime import date, datetime, timedelta
from pathlib import Path
import pandas as pd
from . import mcal, quality
from .market import Market


class Provider(ABC):
    name = "abstract"
    verified = False   # True only for integrations exercised by the automated tests

    @abstractmethod
    def fetch_session(self, day: date, symbols: list[str]) -> pd.DataFrame:
        """Long-format 5-minute bars (UTC bar-open timestamp, symbol, OHLCV) for one completed session."""

    def fetch_fx(self, day: date) -> tuple[float, date] | None:
        """USD->CAD rate and the date it was observed; None when unavailable (never fabricated)."""
        return None

    def next_session(self, after: date) -> date | None:
        return mcal.next_trading_day(after)


class SimulatedFeed(Provider):
    """Offline feed: replays sessions from a reserve Market the research engines have never seen."""
    name, verified = "synthetic-simulated-feed", True

    def __init__(self, reserve_dir: Path):
        self.reserve = Market.load(reserve_dir)

    def fetch_session(self, day, symbols):
        if day not in self.reserve.days:
            return pd.DataFrame(columns=["timestamp", "symbol", "open", "high", "low", "close", "volume"])
        d = self.reserve.didx(day)
        return pd.concat([self.reserve.to_long(self.reserve.sidx(s), d, d + 1) for s in symbols], ignore_index=True)

    def fetch_fx(self, day):
        if day not in self.reserve.days:
            return None
        return float(self.reserve.fx[self.reserve.didx(day)]), day

    def next_session(self, after):
        later = [d for d in self.reserve.days if d > after]
        return later[0] if later else None


class FileProvider(Provider):
    """Local CSV/Parquet import. One file per symbol: <dir>/<SYMBOL>.csv|.parquet with
    timestamp,open,high,low,close,volume. Optional <dir>/corporate_actions.csv and <dir>/fx_usdcad.csv (date,rate)."""
    name, verified = "local-files", True

    def __init__(self, directory: Path, tz: str | None = None):
        self.dir, self.tz = Path(directory), tz
        self._cache: dict[str, pd.DataFrame] = {}
        self.issues: list[dict] = []

    def load_symbol(self, sym: str) -> pd.DataFrame:
        if sym in self._cache:
            return self._cache[sym]
        for ext, reader in ((".parquet", pd.read_parquet), (".csv", pd.read_csv)):
            p = self.dir / f"{sym}{ext}"
            if p.exists():
                try:
                    raw = reader(p)
                except Exception as e:
                    raise quality.DataError(f"{sym}: corrupted or unreadable file {p.name} ({e})") from e
                df = quality.normalize(raw, sym, self.tz)
                ca = self.dir / "corporate_actions.csv"
                if ca.exists():
                    df = quality.apply_adjustments(df, pd.read_csv(ca))
                step = df["timestamp"].sort_values().diff().dt.total_seconds().median()
                if step and step < 300:
                    df = quality.resample_5m(df)
                df, issues = quality.validate(df, sym)
                self.issues += issues
                self._cache[sym] = df
                return df
        raise quality.DataError(f"{sym}: no CSV or Parquet file in {self.dir}")

    def all_days(self, symbols) -> list[date]:
        days = set()
        for s in symbols:
            df = self.load_symbol(s)
            days |= set(df["timestamp"].dt.tz_convert("America/New_York").dt.date)
        return sorted(d for d in days if mcal.is_trading_day(d))

    def fetch_session(self, day, symbols):
        out = []
        for s in symbols:
            df = self.load_symbol(s)
            loc = df["timestamp"].dt.tz_convert("America/New_York").dt.date
            out.append(df[loc == day])
        return pd.concat(out, ignore_index=True)

    def fetch_fx(self, day):
        p = self.dir / "fx_usdcad.csv"
        if not p.exists():
            return None
        fx = pd.read_csv(p)
        fx["date"] = pd.to_datetime(fx["date"]).dt.date
        fx = fx[fx["date"] <= day].sort_values("date")
        if not len(fx):
            return None
        return float(fx["rate"].iloc[-1]), fx["date"].iloc[-1]

    def next_session(self, after):
        return None  # a static import has no future sessions


class AlpacaProvider(Provider):
    """Alpaca Market Data v2 adapter. UNVERIFIED: written against the public API documentation and
    never exercised against the live service (no credentials / network in the build environment)."""
    name, verified = "alpaca", False
    BASE = "https://data.alpaca.markets/v2"

    def __init__(self, key: str | None, secret: str | None, feed: str = "iex"):
        if not key or not secret:
            raise RuntimeError("Alpaca credentials missing: set ALPACA_API_KEY and ALPACA_API_SECRET in the environment or .env")
        self.headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self.feed = feed

    def fetch_session(self, day, symbols):
        import httpx
        s = mcal.session(day)
        if s is None:
            return pd.DataFrame()
        rows = []
        for sym in symbols:
            token = None
            while True:
                params = {"timeframe": "5Min", "start": s[0].isoformat(), "end": s[1].isoformat(), "limit": 1000,
                          "adjustment": "split", "feed": self.feed}
                if token:
                    params["page_token"] = token
                r = httpx.get(f"{self.BASE}/stocks/{sym}/bars", params=params, headers=self.headers, timeout=30)
                r.raise_for_status()
                js = r.json()
                for b in js.get("bars") or []:
                    rows.append({"timestamp": b["t"], "symbol": sym, "open": b["o"], "high": b["h"], "low": b["l"],
                                 "close": b["c"], "volume": b["v"]})
                token = js.get("next_page_token")
                if not token:
                    break
        df = pd.DataFrame(rows)
        if len(df):
            df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
        return df
    # Alpaca does not serve USD/CAD: fetch_fx stays None and the Risk Guardian blocks CAD sizing until an
    # FX source (fx_usdcad.csv or another provider) is configured.


def ingest_session(market: Market, provider: Provider, day: date, db=None) -> dict:
    """Validate and append one completed session. Returns a summary; issues are persisted, gaps stay gaps."""
    import time
    raw = provider.fetch_session(day, market.symbols)
    issues, clean = [], []
    for sym in market.symbols:
        part = raw[raw["symbol"] == sym] if len(raw) else raw
        if len(part) == 0:
            issues.append(quality.issue(sym, day, "missing_bars", "error", "no bars delivered for the session"))
            continue
        part, iss = quality.validate(part, sym, [day])
        if len(market.days) and len(part):  # split check against the stored previous close
            s = market.sidx(sym)
            prev = market.c[s, -1][~pd.isna(market.c[s, -1])]
            if len(prev):
                r = float(part["open"].iloc[0] / prev[-1])
                for k in quality.SPLIT_RATIOS:
                    if abs(r * k - 1) < 0.04 or abs(r / k - 1) < 0.04:
                        iss.append(quality.issue(sym, day, "suspected_split", "error", f"overnight ratio {r:.4f} vs stored close"))
        issues += iss
        if str(day) in quality.blocking_days(iss):
            continue  # quarantine the symbol-day rather than ingest unadjusted prices
        clean.append(part)
    if day not in market.days:
        market.append_days(1, [day])
    n = market.put_long(pd.concat(clean, ignore_index=True)) if clean else 0
    d = market.didx(day)
    fx = provider.fetch_fx(day)
    if fx is not None:
        market.fx[d], market.fx_asof[d] = fx
    elif d > 0:
        market.fx[d], market.fx_asof[d] = market.fx[d - 1], market.fx_asof[d - 1]  # carried, with its true as-of date
        issues.append(quality.issue(None, day, "fx_carried", "warn", f"no USD/CAD for session; last observation {market.fx_asof[d]}"))
    if db is not None:
        for i in issues:
            db.x("INSERT INTO data_issues(ts,symbol,day,kind,severity,detail) VALUES(?,?,?,?,?,?)",
                 (time.time(), i["symbol"], i["day"], i["kind"], i["severity"], i["detail"]))
    return {"day": str(day), "bars": n, "issues": issues}
