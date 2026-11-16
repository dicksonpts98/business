"""MCP data integration, tested against a simulated MCP server that mimics the behaviour observed from the
real Alpha Vantage server (session header, JSON and SSE replies, in-band rate-limit and plan errors)."""
import json
from datetime import date
import httpx
import numpy as np
import pytest
from alpha_genesis import mcal
from alpha_genesis.market import Market
from alpha_genesis.mcp_client import McpAuthError, McpClient, McpPremiumRequired, McpRateLimited
from alpha_genesis.providers import AlphaVantageMcpProvider, ingest_session

DAY = date(2026, 10, 12)


def intraday_csv(day=DAY, px=500.0):
    rows = ["timestamp,open,high,low,close,volume"]
    for b in range(77, -1, -1):                       # newest first, US/Eastern wall-clock, like the real service
        m = 570 + b * 5
        rows.append(f"{day} {m // 60:02d}:{m % 60:02d}:00,{px + b},{px + b + 1},{px + b - 1},{px + b + 0.5},{1000 + b}")
    return "\n".join(rows)


class FakeServer:
    def __init__(self, token="k", sse=False, premium_intraday=False, throttle=0):
        self.token, self.sse, self.premium, self.throttle, self.log = token, sse, premium_intraday, throttle, []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.headers.get("authorization") != f"Bearer {self.token}":
            return httpx.Response(401, json={"error": "invalid_request"})
        msg = json.loads(req.content)
        self.log.append((msg["method"], msg.get("params", {}).get("name"), req.headers.get("mcp-session-id")))
        if msg["method"] == "initialize":
            res = {"protocolVersion": "2024-11-05", "serverInfo": {"name": "fake-av", "version": "1"}, "capabilities": {"tools": {}}}
        elif msg["method"] == "tools/list":
            res = {"tools": [{"name": "TIME_SERIES_INTRADAY"}, {"name": "FX_DAILY"}]}
        else:
            name, args = msg["params"]["name"], msg["params"]["arguments"]
            if self.throttle:
                self.throttle -= 1
                text = json.dumps({"error": {"type": "rate_limit", "message": "Please consider spreading out your free API requests more sparingly (1 request per second)", "detail": "rate limit reached"}})
            elif name == "TIME_SERIES_INTRADAY" and self.premium:
                text = json.dumps({"error": {"type": "rate_limit", "message": "This is a premium endpoint. You may subscribe…", "detail": "rate limit reached"}})
            elif name == "TIME_SERIES_INTRADAY":
                assert args["interval"] == "5min" and args["extended_hours"] is False and args["month"] == "2026-10"
                text = intraday_csv(px=500.0 if args["symbol"] == "SPY" else 300.0)
            elif name == "FX_DAILY":
                text = "timestamp,open,high,low,close\n2026-10-12,1.40,1.41,1.39,1.4050\n2026-10-09,1.39,1.40,1.38,1.3990\n2026-10-08,1.39,1.40,1.38,1.3950"
            else:
                text = "timestamp,open,high,low,close,volume\n2026-10-12,1,2,0.5,1.5,10"
            res = {"content": [{"type": "text", "text": text}]}
        body = {"jsonrpc": "2.0", "id": msg["id"], "result": res}
        if self.sse:
            return httpx.Response(200, headers={"content-type": "text/event-stream", "mcp-session-id": "s1"}, text=f"event: message\ndata: {json.dumps(body)}\n\n")
        return httpx.Response(200, headers={"mcp-session-id": "s1"}, json=body)


def client(server, **kw):
    return McpClient("https://mcp.test/mcp", "k", min_interval_s=0, transport=httpx.MockTransport(server), sleep=lambda s: None, **kw)


@pytest.mark.parametrize("sse", [False, True])
def test_handshake_session_and_tool_call(sse):
    srv = FakeServer(sse=sse)
    c = client(srv)
    assert c.initialize()["serverInfo"]["name"] == "fake-av" and c.session_id == "s1"
    assert [t["name"] for t in c.list_tools()] == ["TIME_SERIES_INTRADAY", "FX_DAILY"]
    assert c.call_tool("FX_DAILY", {"from_symbol": "USD", "to_symbol": "CAD"}).startswith("timestamp,")
    assert srv.log[0][2] is None and all(s == "s1" for _, _, s in srv.log[1:])       # session id is echoed after the handshake


def test_key_travels_as_bearer_header_never_in_the_url():
    seen = {}
    def spy(req):
        seen["url"], seen["auth"] = str(req.url), req.headers.get("authorization")
        return FakeServer()(req)
    McpClient("https://mcp.test/mcp", "k", min_interval_s=0, transport=httpx.MockTransport(spy)).initialize()
    assert seen == {"url": "https://mcp.test/mcp", "auth": "Bearer k"}


def test_bad_credential_plan_limit_and_rate_limit_are_typed_errors():
    with pytest.raises(McpAuthError):
        McpClient("https://mcp.test/mcp", "wrong", min_interval_s=0, transport=httpx.MockTransport(FakeServer())).initialize()
    with pytest.raises(McpPremiumRequired):
        client(FakeServer(premium_intraday=True)).call_tool("TIME_SERIES_INTRADAY", {"symbol": "SPY", "interval": "5min"})
    c = client(FakeServer(throttle=2))
    assert c.call_tool("FX_DAILY", {}).startswith("timestamp,") and c.calls == 3      # backed off twice, then succeeded
    with pytest.raises(McpRateLimited):
        client(FakeServer(throttle=9)).call_tool("FX_DAILY", {})


def test_requests_are_paced():
    slept = []
    c = McpClient("https://mcp.test/mcp", "k", min_interval_s=1.3, transport=httpx.MockTransport(FakeServer()), sleep=slept.append)
    c.initialize(); c.list_tools()
    assert len(slept) == 1 and 0 < slept[0] <= 1.3


def test_provider_delivers_validated_bars_and_a_causal_fx_rate():
    srv = FakeServer()
    p = AlphaVantageMcpProvider(None, client=client(srv))
    m = Market(["SPY", "QQQ"], [], "historical")
    out = ingest_session(m, p, DAY)
    assert out["bars"] == 156 and not [i for i in out["issues"] if i["severity"] == "error"]
    assert m.o[0, 0, 0] == 500.0 and m.c[0, 0, 77] == 577.5 and m.o[1, 0, 0] == 300.0      # Eastern wall-clock 09:30 landed in slot 0
    assert mcal.bar_index(p.intraday_month("SPY", "2026-10")["timestamp"].min().to_pydatetime()) == (DAY, 0)
    assert m.fx[0] == pytest.approx(1.3990) and m.fx_asof[0] == date(2026, 10, 9)          # Friday's rate, not Monday's own close
    n = len(srv.log)
    p.fetch_session(DAY, ["SPY", "QQQ"]); p.fetch_fx(DAY)
    assert len(srv.log) == n                                                               # month and FX are cached: no quota wasted


def test_free_plan_refusal_is_reported_not_papered_over(tmp_path):
    p = AlphaVantageMcpProvider(None, client=client(FakeServer(premium_intraday=True)))
    rep = p.download(["SPY"], tmp_path, ["2026-10"])
    assert [s["file"] for s in rep["saved"]] == ["fx_usdcad.csv"]
    assert len(rep["failed"]) == 1 and "not available on this API plan" in rep["failed"][0]["error"]
    assert not (tmp_path / "SPY.csv").exists()                                            # no bars were invented
    with pytest.raises(McpPremiumRequired):
        ingest_session(Market(["SPY"], [], "historical"), p, DAY)


def test_download_writes_files_the_importer_accepts(tmp_path):
    from alpha_genesis.providers import FileProvider
    rep = AlphaVantageMcpProvider(None, client=client(FakeServer())).download(["SPY", "QQQ"], tmp_path, ["2026-10"])
    assert not rep["failed"] and rep["server"]["name"] == "fake-av"
    fp = FileProvider(tmp_path)
    assert fp.all_days(["SPY", "QQQ"]) == [DAY] and len(fp.fetch_session(DAY, ["SPY"])) == 78 and not fp.issues
    assert fp.fetch_fx(date(2026, 10, 13)) == (1.4050, date(2026, 10, 12))


def test_missing_key_is_a_clear_error():
    with pytest.raises(RuntimeError, match="ALPHAVANTAGE_API_KEY"):
        AlphaVantageMcpProvider(None)
