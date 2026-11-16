"""Data-integrity checks run on every ingest. Bad rows are never repaired with invented values:
they are dropped (leaving an explicit gap) and logged as data issues."""
from __future__ import annotations
from datetime import date
import numpy as np
import pandas as pd
from . import mcal

REQUIRED = ["timestamp", "open", "high", "low", "close", "volume"]
SPLIT_RATIOS = (2, 3, 4, 5, 10, 20)


class DataError(ValueError):
    pass


def issue(symbol, day, kind, severity, detail):
    return {"symbol": symbol, "day": str(day) if day else None, "kind": kind, "severity": severity, "detail": detail}


def normalize(df: pd.DataFrame, symbol: str, tz: str | None = None) -> pd.DataFrame:
    """Column check + timezone normalisation to UTC. Naive timestamps are rejected unless tz is given."""
    df = df.rename(columns={c: c.lower().strip() for c in df.columns})
    df = df.rename(columns={"ts": "timestamp", "datetime": "timestamp", "date": "timestamp", "t": "timestamp",
                            "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"})
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise DataError(f"{symbol}: missing columns {missing}")
    try:
        ts = pd.to_datetime(df["timestamp"], errors="raise")
    except Exception as e:
        raise DataError(f"{symbol}: unparseable timestamps ({e})") from e
    if ts.dt.tz is None:
        if tz is None:
            raise DataError(f"{symbol}: naive timestamps and no source timezone declared")
        ts = ts.dt.tz_localize(tz, ambiguous="NaT", nonexistent="NaT")
    df = df.assign(timestamp=ts.dt.tz_convert("UTC"), symbol=symbol)
    for c in REQUIRED[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[["timestamp", "symbol", *REQUIRED[1:]]]


def resample_5m(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate finer bars (e.g. 1-minute) to 5-minute bars labelled by bar-open time."""
    g = df.set_index("timestamp").groupby("symbol").resample("5min", label="left", closed="left")
    out = g.agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna(subset=["open"])
    return out.reset_index()


def validate(df: pd.DataFrame, symbol: str, expected_days: list[date] | None = None) -> tuple[pd.DataFrame, list[dict]]:
    """Returns (clean rows, issues). Rows failing hard checks are removed, never patched."""
    issues: list[dict] = []
    n0 = len(df)
    bad_ts = df["timestamp"].isna()
    if bad_ts.any():
        issues.append(issue(symbol, None, "invalid_timestamp", "error", f"{int(bad_ts.sum())} rows with ambiguous/missing timestamps dropped"))
        df = df[~bad_ts]
    dup = df.duplicated("timestamp", keep="first")
    if dup.any():
        issues.append(issue(symbol, None, "duplicate_timestamp", "error", f"{int(dup.sum())} duplicate bars dropped (first kept)"))
        df = df[~dup]
    df = df.sort_values("timestamp")
    num = df[["open", "high", "low", "close", "volume"]]
    bad = (num.isna().any(axis=1) | (num[["open", "high", "low", "close"]] <= 0).any(axis=1) | (df["volume"] < 0)
           | (df["high"] < df["low"]) | (df["high"] < df[["open", "close"]].max(axis=1)) | (df["low"] > df[["open", "close"]].min(axis=1)))
    if bad.any():
        issues.append(issue(symbol, None, "invalid_ohlcv", "error", f"{int(bad.sum())} bars with impossible OHLCV dropped"))
        df = df[~bad]
    idx = [mcal.bar_index(t.to_pydatetime()) for t in df["timestamp"]]
    off = np.array([i is None for i in idx])
    if off.any():
        issues.append(issue(symbol, None, "out_of_session", "warn", f"{int(off.sum())} bars outside the regular session or off the 5-minute grid ignored"))
        df = df[~off]
        idx = [i for i in idx if i is not None]
    days = pd.Series([i[0] for i in idx], index=df.index)
    counts = days.value_counts()
    for day in (expected_days or sorted(counts.index)):
        exp, got = mcal.n_bars(day), int(counts.get(day, 0))
        if got < exp:
            issues.append(issue(symbol, day, "missing_bars", "error" if got == 0 else "warn", f"{exp - got} of {exp} bars missing"))
    # unexpected corporate action: overnight move that looks like an unadjusted split
    if len(df):
        first = df.groupby(days)["open"].first()
        last = df.groupby(days)["close"].last()
        ratio = (first / last.shift(1)).dropna()
        for day, r in ratio.items():
            for k in SPLIT_RATIOS:
                if abs(r * k - 1) < 0.04 or abs(r / k - 1) < 0.04:
                    issues.append(issue(symbol, day, "suspected_split", "error",
                                        f"overnight price ratio {r:.4f} ≈ {'1/' if r < 1 else ''}{k}: unadjusted corporate action?"))
        flat = (df["high"] == df["low"]) & (df["volume"] == 0)
        runs = flat.groupby(days).sum()
        for day, n in runs.items():
            if n >= 6:
                issues.append(issue(symbol, day, "stale_bars", "warn", f"{int(n)} zero-volume flat bars (stale feed?)"))
    if n0 and len(df) == 0:
        issues.append(issue(symbol, None, "no_usable_rows", "error", "all rows rejected"))
    return df, issues


def blocking_days(issues: list[dict]) -> set[str]:
    """Session dates whose data must not be traded or learned from until reviewed."""
    return {i["day"] for i in issues if i["day"] and i["kind"] in ("suspected_split",)}


def apply_adjustments(df: pd.DataFrame, actions: pd.DataFrame) -> pd.DataFrame:
    """Back-adjust prices/volume before each ex-date. actions: symbol, ex_date, kind(split|dividend), value
    (split: new-per-old ratio, e.g. 10 for 10:1; dividend: cash amount per share)."""
    df = df.copy()
    px = ["open", "high", "low", "close"]
    for a in actions.itertuples(index=False):
        ex = pd.Timestamp(a.ex_date).tz_localize("America/New_York").tz_convert("UTC")
        m = (df["symbol"] == a.symbol) & (df["timestamp"] < ex)
        if not m.any():
            continue
        if a.kind == "split":
            df.loc[m, px] = df.loc[m, px] / a.value
            df.loc[m, "volume"] = df.loc[m, "volume"] * a.value
        elif a.kind == "dividend":
            prev_close = df.loc[m, "close"].iloc[-1]
            df.loc[m, px] = df.loc[m, px] * (1 - a.value / prev_close)
    return df
