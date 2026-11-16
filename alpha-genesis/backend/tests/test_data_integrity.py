"""Data integrity: calendars, timezones, malformed files, corporate actions, checksums."""
from datetime import date, datetime, timezone
import numpy as np
import pandas as pd
import pytest
from alpha_genesis import mcal, quality
from alpha_genesis.market import Market
from alpha_genesis.providers import FileProvider, ingest_session
from alpha_genesis.synthetic import generate

SYMS = ["SPY", "QQQ"]


def frame(day=date(2024, 3, 12), n=78, sym="SPY", px=100.0):
    t0 = mcal.bar_open_utc(day, 0)
    ts = [t0 + pd.Timedelta(minutes=5 * i) for i in range(n)]
    return pd.DataFrame({"timestamp": ts, "symbol": sym, "open": px, "high": px + 1, "low": px - 1, "close": px + 0.5, "volume": 1000.0})


def kinds(issues):
    return {i["kind"] for i in issues}


def test_calendar_holidays_and_early_close():
    assert not mcal.is_trading_day(date(2024, 7, 4))
    assert not mcal.is_trading_day(date(2024, 3, 29))            # Good Friday
    assert not mcal.is_trading_day(date(2023, 6, 19))            # Juneteenth
    assert not mcal.is_trading_day(date(2024, 3, 9))             # Saturday
    assert mcal.is_trading_day(date(2024, 3, 12))
    assert mcal.n_bars(date(2024, 11, 29)) == 42                 # day after Thanksgiving closes 13:00
    assert mcal.n_bars(date(2024, 3, 12)) == 78
    assert mcal.session(date(2024, 12, 25)) is None


def test_timezone_conversion_across_dst():
    winter, summer = mcal.session(date(2024, 1, 10)), mcal.session(date(2024, 7, 10))
    assert winter[0].hour == 14 and winter[0].minute == 30       # 09:30 EST = 14:30 UTC
    assert summer[0].hour == 13 and summer[0].minute == 30       # 09:30 EDT = 13:30 UTC
    assert mcal.bar_index(datetime(2024, 7, 10, 13, 30, tzinfo=timezone.utc)) == (date(2024, 7, 10), 0)
    assert mcal.bar_index(datetime(2024, 1, 10, 13, 30, tzinfo=timezone.utc)) is None   # pre-market in winter
    assert mcal.bar_index(datetime(2024, 1, 10, 20, 55, tzinfo=timezone.utc)) == (date(2024, 1, 10), 77)
    assert mcal.bar_index(datetime(2024, 1, 10, 21, 0, tzinfo=timezone.utc)) is None    # the close is not a bar
    with pytest.raises(ValueError):
        mcal.bar_index(datetime(2024, 1, 10, 15, 0))


def test_naive_timestamps_rejected_unless_timezone_declared():
    df = frame()
    df["timestamp"] = df["timestamp"].dt.tz_convert("America/New_York").dt.tz_localize(None)
    with pytest.raises(quality.DataError):
        quality.normalize(df.drop(columns="symbol"), "SPY")
    ok = quality.normalize(df.drop(columns="symbol"), "SPY", tz="America/New_York")
    assert mcal.bar_index(ok["timestamp"].iloc[0].to_pydatetime()) == (date(2024, 3, 12), 0)


def test_wrong_timezone_shows_up_as_out_of_session():
    df = frame()
    df["timestamp"] = df["timestamp"].dt.tz_convert("America/New_York").dt.tz_localize(None)
    wrong = quality.normalize(df.drop(columns="symbol"), "SPY", tz="UTC")     # source was NY time, declared UTC
    clean, issues = quality.validate(wrong, "SPY", [date(2024, 3, 12)])
    assert "out_of_session" in kinds(issues) and "missing_bars" in kinds(issues)
    assert len(clean) < 78


def test_missing_and_duplicate_timestamps():
    df = frame().drop(index=[10, 11, 12])
    df = pd.concat([df, df.iloc[[5]]], ignore_index=True)
    clean, issues = quality.validate(df, "SPY", [date(2024, 3, 12)])
    assert {"missing_bars", "duplicate_timestamp"} <= kinds(issues)
    assert len(clean) == 75 and not clean["timestamp"].duplicated().any()


def test_invalid_ohlcv_rows_are_dropped_not_repaired():
    df = frame()
    df.loc[3, "high"] = df.loc[3, "low"] - 1          # high < low
    df.loc[4, "close"] = -5                           # negative price
    df.loc[5, "volume"] = -1                          # negative volume
    df.loc[6, "open"] = np.nan
    df.loc[7, "close"] = df.loc[7, "high"] + 5        # close above high
    clean, issues = quality.validate(df, "SPY", [date(2024, 3, 12)])
    assert "invalid_ohlcv" in kinds(issues) and len(clean) == 73
    m = Market(["SPY"], [date(2024, 3, 12)], "historical")
    m.put_long(clean)
    assert np.isnan(m.c[0, 0, 3:8]).all()             # the gap stays a gap


def test_corrupted_and_malformed_files(tmp_path):
    (tmp_path / "SPY.parquet").write_bytes(b"this is not parquet")
    with pytest.raises(quality.DataError, match="corrupted"):
        FileProvider(tmp_path).load_symbol("SPY")
    (tmp_path / "QQQ.csv").write_text("timestamp,open,high\n2024-03-12T13:30:00Z,1,2\n")
    with pytest.raises(quality.DataError, match="missing columns"):
        FileProvider(tmp_path).load_symbol("QQQ")
    with pytest.raises(quality.DataError, match="no CSV"):
        FileProvider(tmp_path).load_symbol("NVDA")


def test_unexpected_split_is_flagged_and_quarantined():
    a, b = frame(date(2024, 3, 12), px=400.0), frame(date(2024, 3, 13), px=100.0)   # 4:1 split, unadjusted
    clean, issues = quality.validate(pd.concat([a, b], ignore_index=True), "SPY")
    assert "suspected_split" in kinds(issues)
    assert "2024-03-13" in quality.blocking_days(issues)


def test_split_adjustment_removes_the_discontinuity():
    a, b = frame(date(2024, 3, 12), px=400.0), frame(date(2024, 3, 13), px=100.0)
    adj = quality.apply_adjustments(pd.concat([a, b], ignore_index=True), pd.DataFrame([{"symbol": "SPY", "ex_date": "2024-03-13", "kind": "split", "value": 4}]))
    clean, issues = quality.validate(adj, "SPY")
    assert "suspected_split" not in kinds(issues)
    assert adj["open"].iloc[0] == pytest.approx(100.0) and adj["volume"].iloc[0] == pytest.approx(4000.0)


def test_stale_feed_bars_detected():
    df = frame()
    df.loc[20:30, ["open", "high", "low", "close"]] = 100.0
    df.loc[20:30, "volume"] = 0
    _, issues = quality.validate(df, "SPY", [date(2024, 3, 12)])
    assert "stale_bars" in kinds(issues)


def test_one_minute_bars_resample_to_five():
    t0 = mcal.bar_open_utc(date(2024, 3, 12), 0)
    df = pd.DataFrame({"timestamp": [t0 + pd.Timedelta(minutes=i) for i in range(10)], "symbol": "SPY", "open": np.arange(10.0) + 100,
                       "high": np.arange(10.0) + 101, "low": np.arange(10.0) + 99, "close": np.arange(10.0) + 100.5, "volume": 10.0})
    r = quality.resample_5m(df)
    assert len(r) == 2 and r["open"].iloc[0] == 100 and r["close"].iloc[0] == 104.5 and r["high"].iloc[1] == 110 and r["volume"].iloc[0] == 50


def test_csv_import_roundtrip_and_session_ingest(tmp_path):
    src = generate(SYMS, 6, seed=3)
    for s, sym in enumerate(SYMS):
        src.to_long(s).drop(columns="symbol").to_csv(tmp_path / f"{sym}.csv", index=False)
    pd.DataFrame({"date": [d.isoformat() for d in src.days], "rate": src.fx}).to_csv(tmp_path / "fx_usdcad.csv", index=False)
    fp = FileProvider(tmp_path)
    assert fp.all_days(SYMS) == src.days
    m = Market(SYMS, [], "historical")
    for d in src.days:
        out = ingest_session(m, fp, d)
        assert out["bars"] == 78 * 2
    assert np.allclose(m.c, src.c) and np.allclose(m.v, src.v)
    assert np.isnan(m.fx[0]) and np.allclose(m.fx[1:], src.fx[:-1])      # each session uses the previous day's rate, never its own


def test_missing_symbol_session_is_reported_not_fabricated(tmp_path):
    src = generate(SYMS, 3, seed=3)
    src.to_long(0).drop(columns="symbol").to_csv(tmp_path / "SPY.csv", index=False)
    q = src.to_long(1)
    q = q[q["timestamp"].dt.tz_convert("America/New_York").dt.date != src.days[2]]
    q.drop(columns="symbol").to_csv(tmp_path / "QQQ.csv", index=False)
    fp = FileProvider(tmp_path)
    m = Market(SYMS, [], "historical")
    for d in src.days:
        out = ingest_session(m, fp, d)
    assert any(i["kind"] == "missing_bars" and i["symbol"] == "QQQ" for i in out["issues"])
    assert np.isnan(m.c[1, 2]).all() and np.isfinite(m.c[0, 2]).all()
    assert any(i["kind"] == "fx_carried" for i in out["issues"]) or np.isfinite(m.fx[2])


def test_dataset_checksum_detects_tampering(tmp_path):
    m = generate(SYMS, 5, seed=1)
    m.save(tmp_path)
    assert Market.load(tmp_path).D == 5
    p = tmp_path / "SPY.parquet"
    df = pd.read_parquet(p)
    df.loc[0, "close"] += 0.01
    df.to_parquet(p, index=False)
    with pytest.raises(IOError, match="checksum"):
        Market.load(tmp_path)


def test_dataset_versions_are_recorded(ro):
    rows = ro.ctx.db.q("SELECT version, checksum, kind FROM datasets ORDER BY id")
    assert len(rows) >= 2 and len({r["checksum"] for r in rows}) == len(rows)
    assert all(r["kind"] == "synthetic" for r in rows)
    assert ro.ctx.market.provenance["label"] == "SYNTHETIC"
