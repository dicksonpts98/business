"""Minimal Model Context Protocol client (Streamable HTTP transport) so the platform can use a remote MCP
server as a data source on its own — no language model in the loop.

Verified against the official Alpha Vantage server (https://mcp.alphavantage.co/mcp): handshake, session
header, tools/list and tools/call. The API key is sent as a bearer token, never in the URL."""
from __future__ import annotations
import json, time
import httpx


class McpError(RuntimeError):
    pass


class McpAuthError(McpError):
    pass


class McpRateLimited(McpError):
    pass


class McpPremiumRequired(McpError):
    """The server answered, but this tool or option is not included in the caller's plan."""


class McpClient:
    def __init__(self, url: str, token: str | None = None, min_interval_s: float = 1.3, timeout_s: float = 90.0,
                 transport: httpx.BaseTransport | None = None, sleep=time.sleep):
        self.url, self.min_interval, self._sleep = url, min_interval_s, sleep
        headers = {"Accept": "application/json, text/event-stream", "User-Agent": "alpha-genesis/0.1"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self.http = httpx.Client(headers=headers, timeout=timeout_s, transport=transport)
        self.session_id: str | None = None
        self.server: dict = {}
        self._id, self._last = 0, 0.0
        self.calls = 0

    def _rpc(self, method: str, params: dict | None = None) -> dict:
        wait = self.min_interval - (time.monotonic() - self._last)
        if wait > 0:
            self._sleep(wait)
        self._id += 1
        body = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            body["params"] = params
        h = {"Mcp-Session-Id": self.session_id} if self.session_id else {}
        try:
            r = self.http.post(self.url, json=body, headers=h)
        except httpx.HTTPError as e:
            raise McpError(f"MCP transport error: {e}") from e
        finally:
            self._last = time.monotonic()
        if r.status_code in (401, 403):
            raise McpAuthError(f"MCP server refused the request ({r.status_code}): missing or invalid credential")
        if r.status_code >= 400:
            raise McpError(f"MCP server returned HTTP {r.status_code}: {r.text[:200]}")
        self.session_id = r.headers.get("mcp-session-id", self.session_id)
        if "text/event-stream" in r.headers.get("content-type", ""):
            msg = None
            for line in r.text.splitlines():           # the reply to our request is the SSE event carrying our id
                if line.startswith("data:"):
                    try:
                        m = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if m.get("id") == self._id:
                        msg = m
            if msg is None:
                raise McpError("MCP stream ended without a response")
        else:
            msg = r.json()
        if "error" in msg:
            raise McpError(f"MCP error {msg['error'].get('code')}: {msg['error'].get('message')}")
        return msg.get("result", {})

    def initialize(self) -> dict:
        res = self._rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "alpha-genesis", "version": "0.1.0"}})
        self.server = res.get("serverInfo", {})
        return res

    def list_tools(self) -> list[dict]:
        return self._rpc("tools/list").get("tools", [])

    def call_tool(self, name: str, arguments: dict, retries: int = 2) -> str:
        """Returns the tool's text content. Provider-level failures reported inside a successful MCP reply
        (rate limits, plan restrictions) are raised as typed errors rather than returned as data."""
        if self.session_id is None and not self.server:
            self.initialize()
        for attempt in range(retries + 1):
            self.calls += 1
            res = self._rpc("tools/call", {"name": name, "arguments": arguments})
            text = "".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")
            err = None
            if res.get("isError"):
                err = {"message": text}
            elif text.lstrip().startswith("{"):
                try:
                    err = (json.loads(text) or {}).get("error")
                except ValueError:
                    err = None
            if not err:
                return text
            m = str(err.get("message", err))
            if "premium" in m.lower() and "endpoint" in m.lower():
                raise McpPremiumRequired(f"{name}: not available on this API plan ({m[:160]})")
            if "rate limit" in (m + str(err.get("detail", ""))).lower() or err.get("type") == "rate_limit":
                if "per day" in m and "sparingly" not in m:
                    raise McpRateLimited(f"{name}: daily quota exhausted ({m[:160]})")
                if attempt < retries:
                    self._sleep(2.5 * (attempt + 1))
                    continue
                raise McpRateLimited(f"{name}: rate limited ({m[:160]})")
            raise McpError(f"{name}: {m[:200]}")
        raise McpError(f"{name}: no result")
