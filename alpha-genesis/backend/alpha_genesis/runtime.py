"""Process-level runtime: one context, one provider, one paper engine, one worker."""
from __future__ import annotations
import threading
from . import jobs, learning
from .config import Config
from .core import Ctx
from .paper import PaperEngine


class Runtime:
    def __init__(self, cfg: Config | None = None, log=print):
        self.cfg = cfg or Config()
        self.lock = threading.RLock()
        self.ctx = learning.bootstrap(Ctx(self.cfg), log)
        self.provider = learning.make_provider(self.ctx)
        self.engine = PaperEngine(self.ctx)
        from .broker import AlpacaPaperBroker
        self.alpaca_paper = AlpacaPaperBroker(self.cfg.secret("APCA_PAPER_KEY_ID") or self.cfg.secret("APCA_API_KEY_ID"),
                                              self.cfg.secret("APCA_PAPER_SECRET_KEY") or self.cfg.secret("APCA_API_SECRET_KEY"))
        if self.cfg.alpha.get("broker", {}).get("mirror") == "alpaca_paper":      # opt-in; paper endpoint only
            self.engine.mirror = self.alpaca_paper
        self.recovery = self.engine.recover()
        self.worker = jobs.Worker(self.ctx.db, {
            "session_close": self._session, "research_cycle": self._cycle, "ablation": lambda p: learning.ablation(self.ctx),
            "arena": lambda p: self._arena()})
        iv = self.cfg.alpha["learning"]["sim_session_interval_seconds"]
        if not self.ctx.db.one("SELECT 1 FROM schedules WHERE name='session_feed'"):
            jobs.set_schedule(self.ctx.db, "session_feed", "session_close", iv if iv > 0 else 3600, enabled=iv > 0)

    def enqueue(self, kind, payload=None, dedupe=None):
        return jobs.enqueue(self.ctx.db, kind, payload, dedupe)

    def _session(self, payload):
        with self.lock:
            return learning.session_close(self.ctx, self.provider, self.engine, self.enqueue)

    def _cycle(self, payload):
        cid = payload.get("cycle_id")
        if cid is None:
            with self.lock:
                cid = learning.start_cycle(self.ctx, payload.get("trigger", "manual request"))
        return learning.run_cycle(self.ctx, cid)

    def _arena(self):
        from . import arena
        with self.lock:
            return arena.decide(self.ctx, arena.run(self.ctx))

    def advance(self, n: int = 1, drain: bool = True) -> list[dict]:
        """Synchronously ingest n sessions (and run any research they trigger). Used by the CLI and tests."""
        out = []
        for _ in range(n):
            r = self._session({})
            out.append(r)
            if r["status"] != "ok":
                break
            if drain:
                self.worker.drain()
        return out

    def start(self):
        self.worker.start()

    def stop(self):
        self.worker.stop_flag.set()
