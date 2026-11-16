"""SQLite persistence: WAL, transactional state changes, and an append-only hash-chained audit log."""
from __future__ import annotations
import hashlib, json, sqlite3, threading, time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS datasets(id INTEGER PRIMARY KEY, label TEXT, kind TEXT, version INTEGER, checksum TEXT,
  provenance TEXT, n_days INTEGER, created REAL);
CREATE TABLE IF NOT EXISTS data_issues(id INTEGER PRIMARY KEY, ts REAL, symbol TEXT, day TEXT, kind TEXT, severity TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS epochs(id INTEGER PRIMARY KEY, created REAL, dev_start INTEGER, dev_end INTEGER, val_end INTEGER,
  holdout_end INTEGER, dev_start_day TEXT, val_start_day TEXT, holdout_start_day TEXT, holdout_end_day TEXT);
CREATE TABLE IF NOT EXISTS holdout_ledger(id INTEGER PRIMARY KEY, ts REAL, epoch INTEGER, subject TEXT, purpose TEXT,
  UNIQUE(epoch, subject, purpose));
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, symbol TEXT, day TEXT, d INTEGER, bar INTEGER, ts TEXT, pattern TEXT,
  direction INTEGER, level REAL, invalidation REAL, context TEXT, UNIQUE(symbol, day, bar, pattern));
CREATE INDEX IF NOT EXISTS ix_events_day ON events(day, symbol);
CREATE TABLE IF NOT EXISTS cycles(id INTEGER PRIMARY KEY, epoch INTEGER, status TEXT, stage TEXT, state TEXT, trigger TEXT,
  started REAL, finished REAL, summary TEXT);
CREATE TABLE IF NOT EXISTS hypotheses(id INTEGER PRIMARY KEY, cycle_id INTEGER, family TEXT, kind TEXT, statement TEXT,
  evidence TEXT, status TEXT, created REAL);
CREATE TABLE IF NOT EXISTS trials(id INTEGER PRIMARY KEY, cycle_id INTEGER, spec_hash TEXT, family TEXT, origin TEXT, generation INTEGER,
  spec TEXT, dev TEXT, val TEXT, stage TEXT, UNIQUE(cycle_id, spec_hash));
CREATE TABLE IF NOT EXISTS strategies(id TEXT PRIMARY KEY, name TEXT, version INTEGER, spec_hash TEXT, spec TEXT, family TEXT,
  parent_id TEXT, cycle_id INTEGER, epoch INTEGER, status TEXT, hypothesis TEXT, created REAL, artifact_sha TEXT);
CREATE TABLE IF NOT EXISTS skeptic_reports(id INTEGER PRIMARY KEY, strategy_id TEXT, cycle_id INTEGER, verdict TEXT, checks TEXT,
  policy_sha TEXT, created REAL);
CREATE TABLE IF NOT EXISTS promotions(id INTEGER PRIMARY KEY, ts REAL, strategy_id TEXT, from_status TEXT, to_status TEXT,
  reason TEXT, evidence TEXT);
CREATE TABLE IF NOT EXISTS deployments(id INTEGER PRIMARY KEY, ts REAL, strategy_id TEXT, artifact TEXT, sha TEXT, active INTEGER);
CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY, kind TEXT, version INTEGER, epoch INTEGER, train_end INTEGER, path TEXT,
  sha TEXT, metrics TEXT, created REAL);
CREATE TABLE IF NOT EXISTS arena_runs(id INTEGER PRIMARY KEY, ts REAL, epoch INTEGER, results TEXT);
CREATE TABLE IF NOT EXISTS ablations(id INTEGER PRIMARY KEY, ts REAL, epoch INTEGER, results TEXT);
CREATE TABLE IF NOT EXISTS engine_status(engine TEXT PRIMARY KEY, enabled INTEGER, detail TEXT, updated REAL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, client_id TEXT UNIQUE, strategy_id TEXT, symbol TEXT, side INTEGER,
  qty INTEGER, kind TEXT, stop_px REAL, target_px REAL, status TEXT, filled_qty INTEGER DEFAULT 0, avg_px REAL,
  signal_ts TEXT, created_ts TEXT, updated_ts TEXT, reason TEXT, meta TEXT);
CREATE TABLE IF NOT EXISTS fills(id INTEGER PRIMARY KEY, order_id INTEGER, ts TEXT, qty INTEGER, px REAL, commission_usd REAL);
CREATE TABLE IF NOT EXISTS positions(symbol TEXT PRIMARY KEY, strategy_id TEXT, side INTEGER, qty INTEGER, entry_px REAL,
  entry_ts TEXT, stop_px REAL, target_px REAL, exit_by_bar INTEGER, d INTEGER, entry_bar INTEGER, fx REAL, cost_usd REAL, meta TEXT);
CREATE TABLE IF NOT EXISTS broker_positions(symbol TEXT PRIMARY KEY, qty INTEGER, avg_px REAL);
CREATE TABLE IF NOT EXISTS paper_trades(id INTEGER PRIMARY KEY, strategy_id TEXT, symbol TEXT, side INTEGER, qty INTEGER, day TEXT, d INTEGER,
  entry_ts TEXT, exit_ts TEXT, entry_px REAL, exit_px REAL, gross_cad REAL, cost_cad REAL, net_cad REAL, r_multiple REAL,
  exit_reason TEXT, regime INTEGER, explanation TEXT, attribution TEXT);
CREATE TABLE IF NOT EXISTS equity(day TEXT PRIMARY KEY, d INTEGER, equity_cad REAL, pnl_cad REAL, strategy_id TEXT);
CREATE TABLE IF NOT EXISTS metrics(id INTEGER PRIMARY KEY, ts REAL, day TEXT, kind TEXT, payload TEXT);
CREATE INDEX IF NOT EXISTS ix_metrics_kind ON metrics(kind, id);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, ts REAL, level TEXT, source TEXT, message TEXT, ack INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS kb_family(family TEXT PRIMARY KEY, alpha REAL, beta REAL);
CREATE TABLE IF NOT EXISTS kb_lessons(id INTEGER PRIMARY KEY, ts REAL, cycle_id INTEGER, subject TEXT, family TEXT, elements TEXT, lesson TEXT);
CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY, kind TEXT, payload TEXT, status TEXT, attempts INTEGER DEFAULT 0,
  lease_until REAL, checkpoint TEXT, created REAL, started REAL, finished REAL, error TEXT, dedupe TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_dedupe ON jobs(dedupe) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS schedules(name TEXT PRIMARY KEY, kind TEXT, interval_s REAL, next_run REAL, enabled INTEGER, last_run REAL);
CREATE TABLE IF NOT EXISTS recovery_log(id INTEGER PRIMARY KEY, ts REAL, message TEXT);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY, ts REAL, actor TEXT, action TEXT, detail TEXT, prev_hash TEXT, hash TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS promo_no_update BEFORE UPDATE ON promotions BEGIN SELECT RAISE(ABORT, 'promotions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS promo_no_delete BEFORE DELETE ON promotions BEGIN SELECT RAISE(ABORT, 'promotions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS strat_no_unvalidated_deploy BEFORE UPDATE OF status ON strategies
  WHEN NEW.status IN ('SHADOW','CHAMPION') AND NOT EXISTS
    (SELECT 1 FROM skeptic_reports r WHERE r.strategy_id = NEW.id AND r.verdict = 'APPROVED')
  BEGIN SELECT RAISE(ABORT, 'deployment requires an APPROVED Research Skeptic report'); END;
CREATE TRIGGER IF NOT EXISTS strat_spec_immutable BEFORE UPDATE OF spec, spec_hash ON strategies
  BEGIN SELECT RAISE(ABORT, 'strategy versions are immutable'); END;
"""


def _clean(o):
    """Strict JSON: NaN and ±inf become null, numpy scalars become Python numbers."""
    import math
    import numpy as np
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return f if math.isfinite(f) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def jd(o) -> str:
    return json.dumps(_clean(o), sort_keys=True, default=_default, allow_nan=False)


def _default(o):
    import numpy as np
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        f = float(o)
        return None if f != f else f
    if isinstance(o, np.ndarray):
        return o.tolist()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    raise TypeError(type(o))


class DB:
    def __init__(self, path: Path | str):
        self.path = str(path)
        self._local = threading.local()
        self._lock = threading.RLock()
        self.conn.executescript(SCHEMA)

    @property
    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=30, isolation_level=None)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA busy_timeout=30000")
            self._local.c = c
        return c

    @contextmanager
    def tx(self):
        """BEGIN IMMEDIATE transaction; nested use joins the outer transaction."""
        c = self.conn
        if c.in_transaction:
            yield c
            return
        c.execute("BEGIN IMMEDIATE")
        try:
            yield c
            c.execute("COMMIT")
        except BaseException:
            c.execute("ROLLBACK")
            raise

    def q(self, sql, args=()) -> list[dict]:
        return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql, args=()) -> dict | None:
        r = self.conn.execute(sql, args).fetchone()
        return dict(r) if r else None

    def x(self, sql, args=()) -> int:
        with self.tx() as c:
            return c.execute(sql, args).lastrowid

    def get_meta(self, key, default=None):
        r = self.one("SELECT value FROM meta WHERE key=?", (key,))
        return json.loads(r["value"]) if r else default

    def set_meta(self, key, value):
        self.x("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, jd(value)))

    # -- immutable audit log ------------------------------------------------
    def audit(self, actor: str, action: str, detail: dict | None = None):
        with self._lock, self.tx() as c:
            prev = c.execute("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
            prev_hash = prev["hash"] if prev else "GENESIS"
            ts = time.time()
            body = jd(detail or {})
            h = hashlib.sha256(f"{prev_hash}|{ts!r}|{actor}|{action}|{body}".encode()).hexdigest()
            c.execute("INSERT INTO audit_log(ts,actor,action,detail,prev_hash,hash) VALUES(?,?,?,?,?,?)",
                      (ts, actor, action, body, prev_hash, h))

    def verify_audit(self) -> tuple[bool, int]:
        prev, n = "GENESIS", 0
        for r in self.conn.execute("SELECT * FROM audit_log ORDER BY id"):
            h = hashlib.sha256(f"{prev}|{r['ts']!r}|{r['actor']}|{r['action']}|{r['detail']}".encode()).hexdigest()
            if r["prev_hash"] != prev or r["hash"] != h:
                return False, n
            prev, n = h, n + 1
        return True, n

    def alert(self, level: str, source: str, message: str):
        self.x("INSERT INTO alerts(ts,level,source,message) VALUES(?,?,?,?)", (time.time(), level, source, message))

    def metric(self, kind: str, payload: dict, day: str | None = None):
        self.x("INSERT INTO metrics(ts,day,kind,payload) VALUES(?,?,?,?)", (time.time(), day, kind, jd(payload)))
