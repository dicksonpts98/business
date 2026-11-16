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
    """Alpaca PAPER trading adapter. UNVERIFIED — never exercised against the live service. The base URL is
    fixed to the paper endpoint; there is deliberately no parameter that could point it at live trading."""
    is_paper, name = True, "alpaca-paper"
    BASE = "https://paper-api.alpaca.markets/v2"

    def __init__(self, key: str | None, secret: str | None):
        if not key or not secret:
            raise BrokerError("Alpaca paper credentials missing (ALPACA_API_KEY / ALPACA_API_SECRET)")
        self.headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}

    def submit(self, client_id, strategy_id, symbol, side, qty, kind, ts, meta=None):
        import httpx
        try:
            r = httpx.post(f"{self.BASE}/orders", headers=self.headers, timeout=15, json={
                "symbol": symbol, "qty": str(qty), "side": "buy" if side > 0 else "sell", "type": "market",
                "time_in_force": "day", "client_order_id": client_id})
        except httpx.HTTPError as e:
            raise BrokerDisconnected(str(e)) from e
        if r.status_code == 422 and "client_order_id" in r.text:      # duplicate: fetch the original
            r = httpx.get(f"{self.BASE}/orders:by_client_order_id", headers=self.headers, params={"client_order_id": client_id}, timeout=15)
        if r.status_code >= 400:
            return {"client_id": client_id, "status": "REJECTED", "reason": r.text[:200]}
        return {"client_id": client_id, "status": "SUBMITTED", "broker_id": r.json().get("id")}

    def fill_market(self, client_id, px, bar_volume, ts):
        raise NotImplementedError("Alpaca fills arrive from the broker; poll /orders:by_client_order_id (not wired: unverified integration)")

    def positions(self):
        import httpx
        r = httpx.get(f"{self.BASE}/positions", headers=self.headers, timeout=15)
        r.raise_for_status()
        return {p["symbol"]: int(float(p["qty"])) for p in r.json()}
