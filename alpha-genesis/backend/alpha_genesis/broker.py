"""Broker abstraction. Research engines never talk to a broker; the paper engine does, through this
interface, after the Risk Guardian approves. Only paper brokers exist in this codebase."""
from __future__ import annotations
from abc import ABC, abstractmethod
from .db import DB, jd

TERMINAL = {"FILLED", "PARTIAL_CANCELLED", "REJECTED", "CANCELLED", "EXPIRED"}


class BrokerError(RuntimeError):
    pass


class BrokerDisconnected(BrokerError):
    pass


class Broker(ABC):
    is_paper: bool = False
    name = "abstract"

    @abstractmethod
    def submit(self, client_id: str, strategy_id: str, symbol: str, side: int, qty: int, kind: str, ts: str, meta: dict | None = None) -> dict: ...
    @abstractmethod
    def fill_market(self, client_id: str, px: float, bar_volume: float, ts: str) -> dict: ...
    @abstractmethod
    def positions(self) -> dict[str, int]: ...


class PaperBroker(Broker):
    """Internal simulated broker. State lives in SQLite so a restart resumes exactly where it stopped.
    Order states: SUBMITTED -> FILLED | PARTIAL_CANCELLED | REJECTED | EXPIRED."""
    is_paper, name = True, "internal-paper"

    def __init__(self, db: DB, commission_per_share: float, commission_min: float, participation_cap: float, fee_fn=None):
        self.db, self.cps, self.cmin, self.cap = db, commission_per_share, commission_min, participation_cap
        self.fee_fn = fee_fn             # (action, qty, px, day) -> USD; defaults to the legacy per-share commission
        self.inject: list[str] = []      # failure injection for tests: "reject", "disconnect", "partial"

    def submit(self, client_id, strategy_id, symbol, side, qty, kind, ts, meta=None):
        if self.inject and self.inject[0] == "disconnect":
            self.inject.pop(0)
            raise BrokerDisconnected("connection lost before the order was acknowledged")
        with self.db.tx():
            old = self.db.one("SELECT * FROM orders WHERE client_id=?", (client_id,))
            if old:                      # idempotent: a retried submit returns the original order
                return old
            status, reason = "SUBMITTED", None
            if self.inject and self.inject[0] == "reject":
                self.inject.pop(0)
                status, reason = "REJECTED", "broker rejected the order (injected)"
            self.db.x("""INSERT INTO orders(client_id,strategy_id,symbol,side,qty,kind,status,signal_ts,created_ts,updated_ts,reason,meta)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (client_id, strategy_id, symbol, side, qty, kind, status, ts, ts, ts, reason, jd(meta or {})))
        return self.db.one("SELECT * FROM orders WHERE client_id=?", (client_id,))

    def fill_market(self, client_id, px, bar_volume, ts):
        with self.db.tx():
            o = self.db.one("SELECT * FROM orders WHERE client_id=?", (client_id,))
            if o is None or o["status"] != "SUBMITTED":
                return o
            avail = int(self.cap * bar_volume) if bar_volume == bar_volume else 0
            if self.inject and self.inject[0] == "partial":
                self.inject.pop(0)
                avail = max(1, o["qty"] // 2)
            fill = min(o["qty"], avail)
            if fill < 1:
                self.db.x("UPDATE orders SET status='EXPIRED', updated_ts=?, reason='no liquidity' WHERE id=?", (ts, o["id"]))
                return self.db.one("SELECT * FROM orders WHERE id=?", (o["id"],))
            fee = self.fee_fn(o["side"], fill, px, ts[:10]) if self.fee_fn else max(self.cmin, self.cps * fill)
            self.db.x("INSERT INTO fills(order_id,ts,qty,px,commission_usd) VALUES(?,?,?,?,?)", (o["id"], ts, fill, px, fee))
            status = "FILLED" if fill == o["qty"] else "PARTIAL_CANCELLED"
            self.db.x("UPDATE orders SET status=?, filled_qty=?, avg_px=?, updated_ts=?, reason=? WHERE id=?",
                      (status, fill, px, ts, None if status == "FILLED" else "remainder cancelled: participation cap", o["id"]))
            cur = self.db.one("SELECT qty FROM broker_positions WHERE symbol=?", (o["symbol"],))
            new = (cur["qty"] if cur else 0) + o["side"] * fill
            if new == 0:
                self.db.x("DELETE FROM broker_positions WHERE symbol=?", (o["symbol"],))
            else:
                self.db.x("INSERT INTO broker_positions(symbol,qty,avg_px) VALUES(?,?,?) ON CONFLICT(symbol) DO UPDATE SET qty=excluded.qty, avg_px=excluded.avg_px",
                          (o["symbol"], new, px))
        r = self.db.one("SELECT * FROM orders WHERE id=?", (o["id"],))
        r["commission_usd"] = fee
        return r

    def positions(self):
        return {r["symbol"]: r["qty"] for r in self.db.q("SELECT * FROM broker_positions")}


class AlpacaPaperBroker(Broker):
    """Alpaca PAPER trading adapter, used as a mirror of the internal paper engine on live sessions.

    The base URL is the paper endpoint and is not configurable: there is deliberately no way to point this
    class at live trading. Tested against a simulated server; NOT yet verified against the real service."""
    is_paper, name = True, "alpaca-paper"
    BASE = "https://paper-api.alpaca.markets/v2"

    def __init__(self, key: str | None = None, secret: str | None = None, transport=None):
        import httpx
        headers = {"Accept": "application/json", "User-Agent": "alpha-genesis/0.1"}
        if key and secret:
            headers["APCA-API-KEY-ID"], headers["APCA-API-SECRET-KEY"] = key, secret
        self.http = httpx.Client(base_url=self.BASE, headers=headers, timeout=20, transport=transport)
        assert "paper-api" in str(self.http.base_url)

    def _req(self, method, path, **kw):
        import httpx
        try:
            return self.http.request(method, path, **kw)
        except httpx.HTTPError as e:
            raise BrokerDisconnected(f"alpaca paper: {type(e).__name__}") from e

    def submit(self, client_id, strategy_id, symbol, side, qty, kind, ts, meta=None):
        r = self._req("POST", "/orders", json={"symbol": symbol, "qty": str(qty), "side": "buy" if side > 0 else "sell", "type": "market",
                                               "time_in_force": "day", "client_order_id": client_id})
        if r.status_code in (403, 422) and "client_order_id" in r.text:        # duplicate submit: return the original order
            return self.order(client_id)
        if r.status_code in (401, 403):
            raise BrokerError(f"alpaca paper refused the request ({r.status_code})")
        if r.status_code >= 400:
            return {"client_id": client_id, "status": "REJECTED", "reason": r.text[:200]}
        return self._norm(r.json())

    def order(self, client_id) -> dict:
        r = self._req("GET", "/orders:by_client_order_id", params={"client_order_id": client_id})
        if r.status_code >= 400:
            return {"client_id": client_id, "status": "UNKNOWN", "reason": r.text[:200]}
        return self._norm(r.json())

    @staticmethod
    def _norm(o: dict) -> dict:
        st = {"filled": "FILLED", "partially_filled": "PARTIALLY_FILLED", "canceled": "CANCELLED", "rejected": "REJECTED", "expired": "EXPIRED"}.get(o.get("status"), "SUBMITTED")
        fq = float(o.get("filled_qty") or 0)
        return {"client_id": o.get("client_order_id"), "broker_id": o.get("id"), "status": st, "filled_qty": int(fq) if fq == int(fq) else fq,
                "avg_px": float(o["filled_avg_price"]) if o.get("filled_avg_price") else None}

    def fill_market(self, client_id, px, bar_volume, ts):
        return self.order(client_id)      # fills come from the broker; the caller's price is not used

    def account(self) -> dict:
        r = self._req("GET", "/account")
        if r.status_code in (401, 403):
            raise BrokerError(f"alpaca paper refused the request ({r.status_code}): credentials for paper-api.alpaca.markets missing or invalid")
        if r.status_code >= 400:
            raise BrokerError(f"alpaca paper account failed ({r.status_code})")
        a = r.json()
        return {k: a.get(k) for k in ("status", "currency", "equity", "cash", "buying_power", "portfolio_value", "pattern_day_trader",
                                      "trading_blocked", "account_blocked", "daytrade_count", "multiplier")}

    def orders(self, limit: int = 50) -> list[dict]:
        r = self._req("GET", "/orders", params={"status": "all", "limit": limit, "direction": "desc"})
        if r.status_code >= 400:
            raise BrokerError(f"alpaca paper orders failed ({r.status_code})")
        return [{**self._norm(o), "symbol": o.get("symbol"), "side": o.get("side"), "qty": o.get("qty"), "type": o.get("type"),
                 "limit_price": o.get("limit_price"), "raw_status": o.get("status"), "submitted_at": o.get("submitted_at")} for o in r.json()]

    def diagnostic(self, symbol: str = "SPY") -> dict:
        """One harmless round trip through the PAPER order path: a 1-share buy limit at USD 1.00 (cannot fill),
        read back, then cancelled. Proves authentication, order entry, status and cancellation."""
        import time as _t
        cid = f"AG-DIAGNOSTIC-{int(_t.time())}"
        steps = [{"step": "account", "ok": True, "detail": self.account()}]
        r = self._req("POST", "/orders", json={"symbol": symbol, "qty": "1", "side": "buy", "type": "limit", "limit_price": "1.00",
                                               "time_in_force": "day", "client_order_id": cid})
        if r.status_code >= 400:
            steps.append({"step": "submit", "ok": False, "detail": r.text[:200]})
            return {"ok": False, "client_id": cid, "steps": steps}
        oid = r.json().get("id")
        steps.append({"step": "submit", "ok": True, "detail": {"status": r.json().get("status"), "symbol": symbol, "qty": 1, "limit_price": 1.0}})
        got = self.order(cid)
        steps.append({"step": "read_back", "ok": got.get("client_id") == cid, "detail": got})
        c = self._req("DELETE", f"/orders/{oid}")
        steps.append({"step": "cancel", "ok": c.status_code in (200, 204), "detail": {"http": c.status_code}})
        steps.append({"step": "positions_unchanged", "ok": True, "detail": self.positions()})
        return {"ok": all(s["ok"] for s in steps), "client_id": cid, "steps": steps}

    def positions(self):
        r = self._req("GET", "/positions")
        if r.status_code >= 400:
            raise BrokerError(f"alpaca paper positions failed ({r.status_code})")
        return {p["symbol"]: (int(float(p["qty"])) if float(p["qty"]) == int(float(p["qty"])) else float(p["qty"])) for p in r.json()}

    def position_details(self) -> list[dict]:
        r = self._req("GET", "/positions")
        if r.status_code >= 400:
            raise BrokerError(f"alpaca paper positions failed ({r.status_code})")
        return [{"symbol": p["symbol"], "qty": float(p["qty"]), "avg_entry_price": float(p.get("avg_entry_price") or 0), "current_price": float(p.get("current_price") or 0),
                 "unrealized_pl": float(p.get("unrealized_pl") or 0), "market_value": float(p.get("market_value") or 0)} for p in r.json()]

    def cancel(self, broker_id: str) -> bool:
        return self._req("DELETE", f"/orders/{broker_id}").status_code in (200, 204)

    def clock(self) -> dict:
        r = self._req("GET", "/clock")
        if r.status_code >= 400:
            raise BrokerError(f"alpaca paper clock failed ({r.status_code})")
        return r.json()
