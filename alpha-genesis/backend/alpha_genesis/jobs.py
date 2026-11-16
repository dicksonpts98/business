"""Persistent job queue, scheduler and worker. Jobs survive restarts: a job found 'running' with an expired
lease is returned to the queue and its handler resumes from its own checkpoint."""
from __future__ import annotations
import json, threading, time, traceback
from .db import DB, jd

MAX_ATTEMPTS = 3


def enqueue(db: DB, kind: str, payload: dict | None = None, dedupe: str | None = None) -> int | None:
    try:
        return db.x("INSERT INTO jobs(kind,payload,status,created,dedupe) VALUES(?,?,?,?,?)", (kind, jd(payload or {}), "queued", time.time(), dedupe or None))
    except Exception:
        return None      # an identical job is already queued or running


def claim(db: DB, lease_s: float = 900) -> dict | None:
    with db.tx():
        j = db.one("SELECT * FROM jobs WHERE status='queued' ORDER BY id LIMIT 1")
        if not j:
            return None
        db.x("UPDATE jobs SET status='running', attempts=attempts+1, started=?, lease_until=? WHERE id=?", (time.time(), time.time() + lease_s, j["id"]))
    return db.one("SELECT * FROM jobs WHERE id=?", (j["id"],))


def finish(db: DB, jid: int, error: str | None = None):
    j = db.one("SELECT * FROM jobs WHERE id=?", (jid,))
    if error is None:
        db.x("UPDATE jobs SET status='done', finished=?, error=NULL WHERE id=?", (time.time(), jid))
    elif j["attempts"] < MAX_ATTEMPTS:
        db.x("UPDATE jobs SET status='queued', error=? WHERE id=?", (error[-2000:], jid))
        db.x("INSERT INTO recovery_log(ts,message) VALUES(?,?)", (time.time(), f"job {jid} ({j['kind']}) failed on attempt {j['attempts']}; re-queued to resume from its checkpoint"))
    else:
        db.x("UPDATE jobs SET status='failed', finished=?, error=? WHERE id=?", (time.time(), error[-2000:], jid))
        db.alert("critical", "jobs", f"job {jid} ({j['kind']}) failed permanently after {j['attempts']} attempts")


def recover(db: DB, force: bool = False) -> int:
    """Return orphaned running jobs to the queue. force=True at process start (no other worker can own them)."""
    rows = db.q("SELECT id, kind FROM jobs WHERE status='running'" + ("" if force else " AND lease_until < ?"), () if force else (time.time(),))
    for r in rows:
        db.x("UPDATE jobs SET status='queued' WHERE id=?", (r["id"],))
        db.x("INSERT INTO recovery_log(ts,message) VALUES(?,?)", (time.time(), f"job {r['id']} ({r['kind']}) was interrupted; re-queued"))
    return len(rows)


def set_schedule(db: DB, name: str, kind: str, interval_s: float, enabled: bool = True):
    db.x("""INSERT INTO schedules(name,kind,interval_s,next_run,enabled) VALUES(?,?,?,?,?)
            ON CONFLICT(name) DO UPDATE SET interval_s=excluded.interval_s, enabled=excluded.enabled, next_run=excluded.next_run""",
         (name, kind, interval_s, time.time() + interval_s, int(enabled)))


def tick(db: DB) -> int:
    """Enqueue every schedule that has come due."""
    n = 0
    for s in db.q("SELECT * FROM schedules WHERE enabled=1 AND next_run<=?", (time.time(),)):
        if enqueue(db, s["kind"], {"schedule": s["name"]}, f"sched:{s['name']}"):
            n += 1
        db.x("UPDATE schedules SET next_run=?, last_run=? WHERE name=?", (time.time() + s["interval_s"], time.time(), s["name"]))
    return n


class Worker(threading.Thread):
    def __init__(self, db: DB, handlers: dict, poll_s: float = 1.0):
        super().__init__(daemon=True, name="alpha-genesis-worker")
        self.db, self.handlers, self.poll_s = db, handlers, poll_s
        self.stop_flag = threading.Event()
        self.current: dict | None = None

    def run_one(self) -> bool:
        j = claim(self.db)
        if not j:
            return False
        self.current = j
        try:
            self.handlers[j["kind"]](json.loads(j["payload"]))
            finish(self.db, j["id"])
        except Exception:
            finish(self.db, j["id"], traceback.format_exc())
        finally:
            self.current = None
        return True

    def drain(self, limit: int = 100) -> int:
        n = 0
        while n < limit and self.run_one():
            n += 1
        return n

    def run(self):
        recover(self.db, force=True)
        while not self.stop_flag.is_set():
            try:
                tick(self.db)
                if not self.run_one():
                    self.stop_flag.wait(self.poll_s)
            except Exception:
                self.db.alert("critical", "worker", "worker loop error: " + traceback.format_exc()[-400:])
                self.stop_flag.wait(5)
