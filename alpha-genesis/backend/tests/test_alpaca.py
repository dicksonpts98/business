"""Alpaca market-data client and history store, against a simulated Alpaca server (httpx MockTransport).
These tests prove the software's behaviour; they are not evidence about the live service."""
import json
from datetime import date, datetime, timedelta, timezone
import httpx
import numpy as np
import pandas as pd
import pytest
from alpha_genesis import mcal
from alpha_genesis.alpaca import AlpacaAuthError, AlpacaClient, AlpacaEntitlementError, AlpacaError, AlpacaHistory, BankOfCanadaFx
from alpha_genesis.market import Market
from alpha_genesis.providers import ingest_session

KEY, SECRET = "test-key-id", "test-secret"


def session_bars(day, px=100.0, extended=True, dup=False):
    out = []
    o, c = mcal.session(day)
    t = o - timedelta(minutes=30 if extended else 0)
    i = 0
    while t < c + timedelta(minutes=30 if extended else 0):
        out.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": px + i, "h": px + i + 1, "l": px + i - 1, "c": px + i + 0.5, "v": 1000 + i})
        t += timedelta(minutes=5); i += 1
    return out + (out[:3] if dup else [])


class FakeAlpaca:
    def __init__(self, page=60, sip_ok=True, fail=None, dup=False):
        self.page, self.sip_ok, self.fail, self.dup, self.calls, self.urls = page, sip_ok, list(fail or []), dup, [], []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.urls.append(str(req.url))
        if req.headers.get("apca-api-key-id") != KEY or req.headers.get("apca-api-secret-key") != SECRET:
            return httpx.Response(401, json={"message": "unauthorized."})
        if self.fail:
            code = self.fail.pop(0)
            if code == "drop":
                raise httpx.ConnectError("connection reset")
            return httpx.Response(code, json={"message": "too many requests." if code == 429 else "internal error"}, headers={"retry-after": "2"} if code == 429 else {})
        q = dict(req.url.params)
        self.calls.append((req.url.path, q.get("feed"), q.get("start", "")[:7], q.get("page_token")))
        if req.url.path == "/v1/corporate-actions":
            return httpx.Response(200, json={"corporate_actions": {"forward_splits": [{"symbol": "NVDA", "ex_date": "2024-06-10", "new_rate": 10, "old_rate": 1}]}})
        if q["feed"] == "sip" and not self.sip_ok:
            return httpx.Response(403, json={"message": "subscription does not permit querying recent SIP data"})
        assert q["timeframe"] == "5Min" and q["adjustment"] == "split"
        start, end = datetime.fromisoformat(q["start"]), datetime.fromisoformat(q["end"])
        bars, d = [], start.date()
        while d < end.date():
            if mcal.is_trading_day(d):
                bars += session_bars(d, 100.0 if "SPY" in req.url.path else 50.0, dup=self.dup)
            d += timedelta(days=1)
        off = int(q.get("page_token") or 0)
        nxt = off + self.page
        return httpx.Response(200, json={"bars": bars[off:nxt], "symbol": "X", "next_page_token": str(nxt) if nxt < len(bars) else None},
                              headers={"x-ratelimit-remaining": "150"})


def client(srv, **kw):
    return AlpacaClient(KEY, SECRET, transport=httpx.MockTransport(srv), sleep=kw.pop("sleep", lambda s: None), **kw)


def hist(tmp_path, srv, today=date(2024, 5, 20), **kw):
    return AlpacaHistory(tmp_path / "alpaca", client(srv), today=today, **kw)


def test_pagination_collects_every_page_in_order():
    srv = FakeAlpaca(page=25)
    o, c = mcal.session(date(2024, 3, 12))
    df = client(srv).bars("SPY", datetime(2024, 3, 12, tzinfo=timezone.utc), datetime(2024, 3, 13, tzinfo=timezone.utc))
    assert len(df) == 90 and df["timestamp"].is_monotonic_increasing and len(srv.calls) == 4
    assert [c_[3] for c_ in srv.calls] == [None, "25", "50", "75"]


def test_rate_limit_server_error_and_dropped_connection_are_retried_with_backoff():
    slept = []
    srv = FakeAlpaca(fail=[429, 500, "drop"])
    c = client(srv, sleep=slept.append)
    assert len(c.bars("SPY", datetime(2024, 3, 12, tzinfo=timezone.utc), datetime(2024, 3, 13, tzinfo=timezone.utc))) == 90
    assert c.retries == 3 and slept[0] == 2.0 and slept[1] < slept[2]           # Retry-After honoured, then exponential
    with pytest.raises(AlpacaError, match="after 3 attempts"):
        client(FakeAlpaca(fail=[500] * 9), max_retries=2).get("/v2/stocks/SPY/bars", {})


def test_credentials_are_headers_only_and_bad_ones_fail_clearly(caplog):
    srv = FakeAlpaca()
    client(srv).bars("SPY", datetime(2024, 3, 12, tzinfo=timezone.utc), datetime(2024, 3, 13, tzinfo=timezone.utc))
    assert all(KEY not in u and SECRET not in u for u in srv.urls)
    bad = AlpacaClient("x", "y", transport=httpx.MockTransport(FakeAlpaca()))
    with pytest.raises(AlpacaAuthError) as e:
        bad.get("/v2/stocks/SPY/bars", {})
    assert "x" not in str(e.value).split("(")[0] and "APCA-API-KEY-ID" in str(e.value) and "y" != str(e.value)
    assert AlpacaClient(None, None).auth_mode == "network-injected" and "apca-api-key-id" not in AlpacaClient(None, None).http.headers


def test_history_store_filters_dedupes_checksums_and_is_incremental(tmp_path):
    srv = FakeAlpaca(dup=True)
    h = hist(tmp_path, srv)
    rep = h.update(["SPY", "QQQ"], date(2024, 3, 1), date(2024, 5, 20))
    s = rep["summary"]["symbols"]["SPY"]
    n_days = sum(mcal.is_trading_day(date(2024, 3, 1) + timedelta(days=i)) for i in range(92))      # whole months March–May, as served
    assert s["bars"] == 78 * n_days and s["months"] == 3 and s["feeds"] == ["sip"] and s["duplicates_removed"] > 0
    meta = h.manifest["months"]["SPY/2024-03"]
    assert meta["complete"] and meta["outside_session_removed"] > 0 and len(meta["sha256"]) == 64
    assert h.manifest["months"]["SPY/2024-05"]["complete"] is False                  # the current month stays open
    assert rep["summary"]["splits"][0]["symbol"] == "NVDA"
    n = len(srv.calls)
    h2 = hist(tmp_path, srv)                                                          # a new process: closed months come from disk
    h2.update(["SPY", "QQQ"], date(2024, 3, 1), date(2024, 5, 20))
    again = [c for c in srv.calls[n:] if c[0].startswith("/v2")]
    assert {c[2] for c in again} == {"2024-05"} and len([c for c in again if c[3] is None]) == 2                   # only the open month is refreshed
    p = tmp_path / "alpaca" / "SPY" / "2024-03.parquet"
    df = pd.read_parquet(p); df.loc[0, "close"] += 1; df.to_parquet(p, index=False)
    with pytest.raises(IOError, match="checksum"):
        hist(tmp_path, srv).month("SPY", "2024-03")


def test_feed_refusal_is_recorded_verbatim_and_falls_back_to_a_permitted_feed(tmp_path):
    h = hist(tmp_path, FakeAlpaca(sip_ok=False))
    h.update(["SPY"], date(2024, 3, 1), date(2024, 3, 31))
    assert h.manifest["feed_used"]["SPY/2024-03"] == "iex"
    r = h.manifest["restrictions"][0]
    assert r["feed"] == "sip" and "subscription does not permit" in r["error"] and KEY not in json.dumps(h.manifest)
    only_sip = AlpacaHistory(tmp_path / "b", client(FakeAlpaca(sip_ok=False)), feeds=("sip",), today=date(2024, 5, 20))
    with pytest.raises(AlpacaEntitlementError, match="no permitted feed"):
        only_sip.month("SPY", "2024-03")
    assert not (tmp_path / "b" / "SPY" / "2024-03.parquet").exists()                  # nothing invented in its place


def test_sessions_ingest_onto_the_grid_with_previous_day_fx(tmp_path):
    def boc(req):
        return httpx.Response(200, json={"observations": [{"d": "2024-03-08", "FXUSDCAD": {"v": "1.3480"}}, {"d": "2024-03-11", "FXUSDCAD": {"v": "1.3500"}},
                                                           {"d": "2024-03-12", "FXUSDCAD": {"v": "1.3999"}}]})
    fx = BankOfCanadaFx(tmp_path / "fx.parquet", transport=httpx.MockTransport(boc))
    assert fx.update(date(2024, 3, 1)) == 3 and BankOfCanadaFx(tmp_path / "fx.parquet").rate_before(date(2024, 3, 12)) == (1.35, date(2024, 3, 11))
    h = hist(tmp_path, FakeAlpaca(), fx=fx)
    m = Market(["SPY", "QQQ"], [], "historical")
    out = ingest_session(m, h, date(2024, 3, 12))
    assert out["bars"] == 156 and not out["issues"]
    assert m.o[0, 0, 0] == 106.0 and m.o[1, 0, 0] == 56.0                              # 09:30 ET bar (after 6 pre-market bars) in slot 0
    assert m.fx[0] == 1.35 and m.fx_asof[0] == date(2024, 3, 11)                       # never the session's own rate
    assert h.all_days(["SPY"], date(2024, 3, 11), date(2024, 3, 13)) == [date(2024, 3, 11), date(2024, 3, 12), date(2024, 3, 13)]
    assert h.next_session(date(2024, 5, 17)) == date(2024, 5, 20) and h.next_session(date(2024, 5, 20)) is None


def test_implausible_fx_is_rejected(tmp_path):
    bad = lambda req: httpx.Response(200, json={"observations": [{"d": "2024-03-11", "FXUSDCAD": {"v": "13.5"}}]})
    with pytest.raises(Exception, match="implausible"):
        BankOfCanadaFx(tmp_path / "fx.parquet", transport=httpx.MockTransport(bad)).update(date(2024, 3, 1))
