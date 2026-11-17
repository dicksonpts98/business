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

    def __init__(self, db: DB, commission_per_share: float, commission_min: float, participation_cap: float):
        self.db, self.cps, self.cmin, self.cap = db, commission_per_share, commission_min, participation_cap
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
            fee = max(self.cmin, self.cps * fill)
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
        if r.status_code == 422 and "client_order_id" in r.text:        # duplicate submit: return the original order
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
        return {"client_id": o.get("client_order_id"), "broker_id": o.get("id"), "status": st, "filled_qty": int(float(o.get("filled_qty") or 0)),
                "avg_px": float(o["filled_avg_price"]) if o.get("filled_avg_price") else None}

    def fill_market(self, client_id, px, bar_volume, ts):
        return self.order(client_id)      # fills come from the broker; the caller's price is not used

    def positions(self):
        r = self._req("GET", "/positions")
        if r.status_code >= 400:
            raise BrokerError(f"alpaca paper positions failed ({r.status_code})")
        return {p["symbol"]: int(float(p["qty"])) for p in r.json()}
