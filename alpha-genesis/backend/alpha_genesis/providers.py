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
        fx = fx[fx["date"] < day].sort_values("date")       # a daily rate is only known after its own day ends
        if not len(fx):
            return None
        return float(fx["rate"].iloc[-1]), fx["date"].iloc[-1]

    def next_session(self, after):
        return None  # a static import has no future sessions


class ChainProvider(Provider):
    """Replay a held-back reserve first, then hand over to a live provider when the reserve is exhausted."""
    def __init__(self, first: Provider, then: Provider | None):
        self.first, self.then = first, then
        self.name, self.verified = (then.name if then else first.name), first.verified

    def _pick(self, day):
        return self.first if day in getattr(self.first, "reserve").days else self.then

    def fetch_session(self, day, symbols):
        return self._pick(day).fetch_session(day, symbols)

    def fetch_fx(self, day):
        return self._pick(day).fetch_fx(day)

    def next_session(self, after):
        return self.first.next_session(after) or (self.then.next_session(after) if self.then else None)


class AlphaVantageMcpProvider(Provider):
    """Real market data through the official Alpha Vantage MCP server (https://mcp.alphavantage.co/mcp).

    Verified live: MCP handshake, authentication, tool discovery, TIME_SERIES_DAILY and FX_DAILY.
    NOT verified: TIME_SERIES_INTRADAY — a free API key is refused ("premium endpoint"), so the 5-minute
    path below is written to the tool's published schema and exercised only against a simulated server."""
    name, verified = "alphavantage-mcp", False
    URL = "https://mcp.alphavantage.co/mcp"

    def __init__(self, token: str | None, client=None):
        from .mcp_client import McpClient
        if client is None and not token:
            raise RuntimeError("Alpha Vantage API key missing: set ALPHAVANTAGE_API_KEY (free key: https://www.alphavantage.co/support/#api-key)")
        self.mcp = client or McpClient(self.URL, token)
        self._months: dict[tuple[str, str], pd.DataFrame] = {}
        self._fx: pd.DataFrame | None = None

    @staticmethod
    def _csv(text: str) -> pd.DataFrame:
        import io
        df = pd.read_csv(io.StringIO(text))
        if "timestamp" not in df.columns or len(df) == 0:
            raise quality.DataError(f"unexpected response from data server: {text[:120]!r}")
        return df

    def intraday_month(self, sym: str, month: str) -> pd.DataFrame:
        """All regular-session 5-minute bars of one calendar month (YYYY-MM), UTC bar-open timestamps."""
        if (sym, month) not in self._months:
            df = self._csv(self.mcp.call_tool("TIME_SERIES_INTRADAY", {"symbol": sym, "interval": "5min", "month": month, "outputsize": "full",
                                                                       "extended_hours": False, "adjusted": True, "datatype": "csv"}))
            df = quality.normalize(df, sym, tz="America/New_York")      # Alpha Vantage intraday stamps are US/Eastern
            self._months[(sym, month)] = df
        return self._months[(sym, month)]

    def daily(self, sym: str, full: bool = False) -> pd.DataFrame:
        df = self._csv(self.mcp.call_tool("TIME_SERIES_DAILY", {"symbol": sym, "outputsize": "full" if full else "compact", "datatype": "csv"}))
        return df.rename(columns={"timestamp": "date"}).sort_values("date").reset_index(drop=True)

    def fx_daily(self) -> pd.DataFrame:
        if self._fx is None:
            df = self._csv(self.mcp.call_tool("FX_DAILY", {"from_symbol": "USD", "to_symbol": "CAD", "datatype": "csv"}))
            df["date"] = pd.to_datetime(df["timestamp"]).dt.date
            self._fx = df[["date", "close"]].rename(columns={"close": "rate"}).sort_values("date").reset_index(drop=True)
        return self._fx

    def fetch_session(self, day, symbols):
        out = []
        for sym in symbols:
            df = self.intraday_month(sym, f"{day:%Y-%m}")
            out.append(df[df["timestamp"].dt.tz_convert("America/New_York").dt.date == day])
        return pd.concat(out, ignore_index=True) if out else pd.DataFrame()

    def fetch_fx(self, day):
        fx = self.fx_daily()
        fx = fx[fx["date"] < day]            # the rate known before the session opens
        if not len(fx):
            return None
        return float(fx["rate"].iloc[-1]), fx["date"].iloc[-1]

    def download(self, symbols: list[str], out_dir: Path, months: list[str], daily_only: bool = False) -> dict:
        """Save real history as files the local-files provider can import. Returns what was and was not obtained."""
        from .mcp_client import McpError
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        rep = {"server": self.mcp.server, "saved": [], "failed": [], "calls": 0}
        try:
            fx = self.fx_daily()
            fx.to_csv(out_dir / "fx_usdcad.csv", index=False)
            rep["saved"].append({"file": "fx_usdcad.csv", "rows": len(fx), "from": str(fx["date"].iloc[0]), "to": str(fx["date"].iloc[-1])})
        except (McpError, quality.DataError) as e:
            rep["failed"].append({"what": "USD/CAD", "error": str(e)})
        for sym in symbols:
            try:
                if daily_only:
                    df = self.daily(sym)
                    (out_dir / "daily").mkdir(exist_ok=True)
                    df.to_csv(out_dir / "daily" / f"{sym}.csv", index=False)
                    rep["saved"].append({"file": f"daily/{sym}.csv", "rows": len(df), "from": str(df["date"].iloc[0]), "to": str(df["date"].iloc[-1])})
                else:
                    parts = [self.intraday_month(sym, mth) for mth in months]
                    df = pd.concat(parts, ignore_index=True).drop_duplicates("timestamp").sort_values("timestamp")
                    df.drop(columns="symbol").to_csv(out_dir / f"{sym}.csv", index=False)
                    rep["saved"].append({"file": f"{sym}.csv", "rows": len(df), "from": str(df["timestamp"].iloc[0]), "to": str(df["timestamp"].iloc[-1])})
            except (McpError, quality.DataError) as e:
                rep["failed"].append({"what": f"{sym} {'daily' if daily_only else '5-minute'}", "error": str(e)})
        rep["calls"], rep["server"] = self.mcp.calls, self.mcp.server
        return rep


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
