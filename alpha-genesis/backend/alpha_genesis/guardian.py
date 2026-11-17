"""ENGINE 6 — RISK GUARDIAN: independent pre-trade risk and execution authority.

Limits are read once from risk.toml into a frozen object. Nothing in the research or learning code
has an API to change them; the only mutable control is the kill switch, which is operator-driven
and audited. Every decision — approve or reject — is written to the immutable audit log.

A planned loss is not a guaranteed maximum: gaps and slippage can exceed it, and the Guardian
reports realised risk rather than assuming the plan held."""
from __future__ import annotations
import hashlib
from datetime import date, datetime
from . import mcal, registry
from .config import Config
from .db import DB


class LiveTradingForbidden(RuntimeError):
    pass


class RiskGuardian:
    def __init__(self, cfg: Config, db: DB):
        self.limits, self.db, self.cfg = cfg.risk, db, cfg
        if not self.limits.paper_only:
            raise LiveTradingForbidden("risk.toml must set paper_only = true; live trading requires a separate authorised implementation review")

    # -- kill switch / halts ---------------------------------------------------
    def kill(self, on: bool, actor: str, reason: str):
        self.db.set_meta("kill_switch", {"on": bool(on), "actor": actor, "reason": reason})
        self.db.audit(actor, "risk.kill_switch_on" if on else "risk.kill_switch_off", {"reason": reason})
        if on:
            self.db.alert("critical", "guardian", f"KILL SWITCH engaged by {actor}: {reason}")

    def halted(self) -> str | None:
        k = self.db.get_meta("kill_switch", {"on": False})
        if k.get("on"):
            return f"kill switch: {k.get('reason')}"
        r = self.db.get_meta("reconciliation_halt")
        if r:
            return f"reconciliation halt: {r}"
        return None

    def clear_reconciliation_halt(self, actor: str):
        self.db.set_meta("reconciliation_halt", None)
        self.db.audit(actor, "risk.reconciliation_halt_cleared", {})

    # -- pre-trade check ---------------------------------------------------------
    def check_entry(self, req: dict, st: dict) -> tuple[bool, str, int]:
        """req: strategy_id, artifact_sha, symbol, side, qty, entry_px, stop_px, fx, fx_asof(date), day(date),
        now(datetime UTC), data_ts(datetime UTC of the last bar received), client_id, broker_is_paper.
        st: equity, day_pnl (realised + unrealised), entries_today, positions [{symbol, notional_cad}].
        Returns (approved, reason, approved_qty) — the quantity may be reduced to fit exposure limits."""
        L = self.limits
        def no(reason):
            self.db.audit("guardian", "risk.reject", {"reason": reason, "client_id": req.get("client_id"), "symbol": req.get("symbol"), "strategy": req.get("strategy_id")})
            return False, reason, 0
        if not req.get("broker_is_paper", False):
            return no("broker is not a paper broker")
        h = self.halted()
        if h:
            return no(h)
        dep = registry.active_deployment(self.db)
        risk_cad, max_entries, max_loss = L.risk_per_trade_cad, L.max_entries_per_day, L.max_daily_loss_cad
        if dep is None or dep["strategy_id"] != req["strategy_id"] or dep["sha"] != req.get("artifact_sha"):
            exp = registry.experimental_deployment(self.db) if (dep is None and L.paper_mode == "experimental") else None
            if exp is None or exp["strategy_id"] != req["strategy_id"] or exp["sha"] != req.get("artifact_sha"):
                return no("unauthorised: order does not come from the active, frozen champion deployment")
            # experimental mode can only ever tighten the configured limits
            risk_cad = L.risk_per_trade_cad * min(1.0, L.experimental_risk_fraction)
            max_entries = min(L.max_entries_per_day, L.experimental_max_entries_per_day)
            max_loss = min(L.max_daily_loss_cad, L.experimental_max_daily_loss_cad)
        if self.db.one("SELECT 1 FROM orders WHERE client_id=?", (req["client_id"],)):
            return no("duplicate order (idempotency key already used)")
        sess = mcal.session(req["day"])
        if sess is None or not (sess[0] <= req["now"] < sess[1]):
            return no("market session closed")
        if (sess[1] - req["now"]).total_seconds() <= L.no_entry_last_minutes * 60:
            return no(f"inside the final {L.no_entry_last_minutes} minutes of the session")
        if (req["now"] - req["data_ts"]).total_seconds() > L.stale_data_seconds:
            return no("stale market data")
        if req.get("fx") is None or req["fx"] != req["fx"] or (req["day"] - req["fx_asof"]).days > L.fx_stale_days:
            return no("USD/CAD rate missing or stale: CAD risk cannot be computed")
        if not self.cfg.instrument(req["symbol"]).get("shortable", True) and req["side"] < 0:
            return no("instrument not shortable")
        if st["day_pnl"] <= -max_loss:
            return no("daily loss limit reached")
        if st["entries_today"] >= max_entries:
            return no("daily entry limit reached")
        if len(st["positions"]) >= L.max_positions:
            return no("maximum simultaneous positions reached")
        if any(p["symbol"] == req["symbol"] for p in st["positions"]):
            return no("position already open in instrument")
        dist = abs(req["entry_px"] - req["stop_px"])
        if dist <= 0:
            return no("invalid stop distance")
        qty = int(req["qty"])
        fx, px, eq = req["fx"], req["entry_px"], st["equity"]
        max_risk_qty = int(risk_cad / (dist * fx))
        open_notional = sum(p["notional_cad"] for p in st["positions"])
        cap = min(max_risk_qty, int(L.max_instrument_exposure_x * eq / (px * fx)),
                  int((min(L.max_total_exposure_x, L.leverage_ceiling_x) * eq - open_notional) / (px * fx)))
        if qty > cap:
            self.db.audit("guardian", "risk.resize", {"client_id": req["client_id"], "requested": qty, "approved": max(cap, 0)})
            qty = cap
        if qty < 1:
            return no("no size available within risk and exposure limits")
        self.db.audit("guardian", "risk.approve", {"client_id": req["client_id"], "symbol": req["symbol"], "qty": qty,
                                                   "planned_risk_cad": round(qty * dist * fx, 2)})
        return True, "approved", qty

    # -- LIVE experimental paper orders ---------------------------------------------
    def check_live(self, req: dict) -> tuple[bool, str, float]:
        """Pre-trade check for the live experimental mode. Its limits are separate from, and much tighter than,
        the research account's. Returns (approved, reason, quantity). Long orders may be fractional; short
        orders must be whole shares (fractional short sales are not supported)."""
        import math
        L = self.limits
        def no(reason):
            self.db.audit("guardian", "risk.reject_live", {"reason": reason, "client_id": req.get("client_id"), "symbol": req.get("symbol")})
            return False, reason, 0.0
        if not req.get("broker_is_paper"):
            return no("broker is not a paper broker")
        if not req.get("switch"):
            return no("experimental trading switch is off")
        h = self.halted()
        if h:
            return no(h)
        if req.get("suspended"):
            return no(f"suspended: {req['suspended']}")
        sess = mcal.session(req["day"])
        if sess is None or not (sess[0] <= req["now"] < sess[1]):
            return no("market session closed")
        if (sess[1] - req["now"]).total_seconds() <= L.no_entry_last_minutes * 60:
            return no(f"inside the final {L.no_entry_last_minutes} minutes of the session")
        fx = req.get("fx")
        if fx is None or fx != fx or req.get("fx_asof") is None or (req["day"] - req["fx_asof"]).days > L.fx_stale_days:
            return no("USD/CAD rate missing or stale: CAD limits cannot be computed")
        if req["entries_today"] >= L.live_experimental_max_entries_per_day:
            return no(f"daily entry limit reached ({L.live_experimental_max_entries_per_day})")
        if req["day_pnl_cad"] <= -L.live_experimental_max_daily_loss_cad:
            return no("experimental daily loss limit reached")
        if any(p["symbol"] == req["symbol"] for p in req["positions"]):
            return no("position already open in instrument")
        if req["side"] < 0 and not self.cfg.instrument(req["symbol"]).get("shortable", True):
            return no("instrument not shortable")
        px, dist = req["px"], req["dist"]
        if dist <= 0 or px <= 0:
            return no("invalid price or stop distance")
        cap_cad = L.live_experimental_max_position_cad
        open_cad = sum(p["notional_cad"] for p in req["positions"])
        room = min(cap_cad, L.live_experimental_leverage_x * (req.get("equity_usd") or 0) * fx - open_cad)      # no leverage against account equity
        loss_room = max(0.0, L.live_experimental_max_daily_loss_cad + req["day_pnl_cad"]) / 2                   # one trade may plan at most half the remaining loss budget
        qty = min(room / (px * fx), loss_room / (dist * fx))
        qty = math.floor(qty * 1e4) / 1e4 if req["side"] > 0 else float(math.floor(qty))
        if qty * px < 1.0:
            return no("no size available within the experimental limits" + (" (short sales need whole shares)" if req["side"] < 0 else ""))
        self.db.audit("guardian", "risk.approve_live", {"client_id": req["client_id"], "symbol": req["symbol"], "qty": qty, "notional_cad": round(qty * px * fx, 2),
                                                        "planned_risk_cad": round(qty * dist * fx, 2)})
        return True, "approved", qty

    # -- reconciliation ------------------------------------------------------------
    def reconcile(self, internal: dict[str, int], broker: dict[str, int]) -> list[dict]:
        diffs = [{"symbol": s, "internal": internal.get(s, 0), "broker": broker.get(s, 0)}
                 for s in sorted(set(internal) | set(broker)) if internal.get(s, 0) != broker.get(s, 0)]
        if diffs:
            self.db.set_meta("reconciliation_halt", diffs)
            self.db.audit("guardian", "risk.reconciliation_mismatch", {"diffs": diffs})
            self.db.alert("critical", "guardian", f"Position reconciliation mismatch: {diffs}. New entries halted until an operator clears it.")
        return diffs
