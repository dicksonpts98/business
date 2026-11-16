"""Strategy registry: immutable versions, a guarded lifecycle, frozen deployment artifacts, rollback.

CANDIDATE -> APPROVED (Skeptic only) -> SHADOW -> CHAMPION -> RETIRED / QUARANTINED / ROLLED_BACK
Every transition is validated here and appended to the promotions log. Promotion is to PAPER trading only."""
from __future__ import annotations
import hashlib, json, time
from .db import DB, jd
from .dsl import StrategySpec

ALLOWED = {
    "CANDIDATE": {"APPROVED", "REJECTED"},
    "APPROVED": {"SHADOW", "REJECTED"},
    "SHADOW": {"CHAMPION", "RETIRED", "QUARANTINED"},
    "CHAMPION": {"RETIRED", "QUARANTINED", "ROLLED_BACK"},
    "RETIRED": {"CHAMPION"},          # only through rollback()
    "REJECTED": set(), "QUARANTINED": set(), "ROLLED_BACK": set(), "BASELINE": set(),
}


class PromotionError(PermissionError):
    pass


def register(db: DB, spec: StrategySpec, *, cycle_id=None, epoch=None, parent_id=None, hypothesis=None,
             status="CANDIDATE", name=None) -> str:
    h = spec.hash()
    old = db.one("SELECT id FROM strategies WHERE spec_hash=? AND (epoch IS ? OR status='BASELINE')", (h, epoch))
    if old:
        return old["id"]
    with db.tx():
        if parent_id:
            par = db.one("SELECT name, version FROM strategies WHERE id=?", (parent_id,))
            name = par["name"]
            ver = db.one("SELECT MAX(version) v FROM strategies WHERE name=?", (name,))["v"] + 1
        else:
            if name is None:
                n = db.one("SELECT COUNT(DISTINCT name) n FROM strategies WHERE status!='BASELINE'")["n"] + 1
                name = f"DRW-{n:04d}"
            ver = (db.one("SELECT COALESCE(MAX(version),0) v FROM strategies WHERE name=?", (name,))["v"]) + 1
        sid = f"{name}-v{ver}"
        db.x("INSERT INTO strategies(id,name,version,spec_hash,spec,family,parent_id,cycle_id,epoch,status,hypothesis,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
             (sid, name, ver, h, jd(spec.model_dump()), spec.family, parent_id, cycle_id, epoch, status, hypothesis, time.time()))
    return sid


def get(db: DB, sid: str) -> dict | None:
    r = db.one("SELECT * FROM strategies WHERE id=?", (sid,))
    if r:
        r["spec_obj"] = StrategySpec.model_validate(json.loads(r["spec"]))
    return r


def spec_of(db: DB, sid: str) -> StrategySpec:
    return get(db, sid)["spec_obj"]


def by_status(db: DB, *statuses) -> list[dict]:
    q = ",".join("?" * len(statuses))
    return db.q(f"SELECT * FROM strategies WHERE status IN ({q}) ORDER BY created", statuses)


def champion(db: DB) -> dict | None:
    r = db.one("SELECT id FROM strategies WHERE status='CHAMPION'")
    return get(db, r["id"]) if r else None


def _artifact(db: DB, row: dict, cfg) -> tuple[str, str]:
    spec = json.loads(row["spec"])
    mid = spec["trigger"].get("model_id")
    model = db.one("SELECT id, sha, train_end FROM models WHERE id=?", (mid,)) if mid else None
    art = {"strategy_id": row["id"], "spec": spec, "spec_hash": row["spec_hash"], "model": model,
           "risk_sha": cfg.risk.sha, "policy_sha": cfg.policy.sha, "mode": "PAPER_ONLY"}
    body = json.dumps(art, sort_keys=True)
    return body, hashlib.sha256(body.encode()).hexdigest()


def transition(db: DB, cfg, sid: str, to: str, reason: str, evidence: dict | None = None, actor: str = "system", _rollback=False):
    evidence = evidence or {}
    with db.tx():
        row = db.one("SELECT * FROM strategies WHERE id=?", (sid,))
        if row is None:
            raise PromotionError(f"unknown strategy {sid}")
        frm = row["status"]
        if to not in ALLOWED.get(frm, set()):
            raise PromotionError(f"illegal transition {frm} -> {to} for {sid}")
        if frm == "RETIRED" and not _rollback:
            raise PromotionError("a retired strategy can only return through rollback()")
        if to == "APPROVED":
            rep = db.one("SELECT verdict FROM skeptic_reports WHERE id=? AND strategy_id=?", (evidence.get("skeptic_report_id"), sid))
            if not rep or rep["verdict"] != "APPROVED" or actor != "skeptic":
                raise PromotionError("approval requires an APPROVED report issued by the Research Skeptic")
        if to == "CHAMPION" and not _rollback:
            need = cfg.policy.min_shadow_days
            if evidence.get("shadow_days", 0) < need or not evidence.get("forward_ok"):
                raise PromotionError(f"promotion requires >= {need} shadow sessions with acceptable forward evidence")
            if evidence.get("risk_sha") != cfg.risk.sha:
                raise PromotionError("promotion evidence was not produced under the active risk limits")
        if to == "CHAMPION":
            cur = db.one("SELECT id FROM strategies WHERE status='CHAMPION'")
            if cur:
                _set(db, cur["id"], "CHAMPION", "ROLLED_BACK" if _rollback else "RETIRED",
                     f"replaced by {sid}" if not _rollback else f"rolled back in favour of {sid}", {"successor": sid})
            db.x("UPDATE deployments SET active=0 WHERE active=1")
            prior = db.one("SELECT * FROM deployments WHERE strategy_id=? ORDER BY id DESC LIMIT 1", (sid,))
            if _rollback and prior:
                body, sha = prior["artifact"], prior["sha"]
                if hashlib.sha256(body.encode()).hexdigest() != sha:
                    raise PromotionError("stored deployment artifact failed its integrity check")
            else:
                body, sha = _artifact(db, row, cfg)
            db.x("INSERT INTO deployments(ts,strategy_id,artifact,sha,active) VALUES(?,?,?,?,1)", (time.time(), sid, body, sha))
            db.x("UPDATE strategies SET artifact_sha=? WHERE id=?", (sha, sid))
        if frm == "CHAMPION":
            db.x("UPDATE deployments SET active=0 WHERE strategy_id=? AND active=1", (sid,))
        _set(db, sid, frm, to, reason, evidence)
    db.audit(actor, f"strategy.{to.lower()}", {"strategy": sid, "from": frm, "reason": reason})


def _set(db, sid, frm, to, reason, evidence):
    db.x("UPDATE strategies SET status=? WHERE id=?", (to, sid))
    db.x("INSERT INTO promotions(ts,strategy_id,from_status,to_status,reason,evidence) VALUES(?,?,?,?,?,?)",
         (time.time(), sid, frm, to, reason, jd(evidence)))


def rollback(db: DB, cfg, reason: str, actor: str = "system", to_status: str = "ROLLED_BACK") -> str | None:
    """Remove the current champion and restore the most recent healthy predecessor from its frozen artifact.
    Returns the restored strategy id, or None when the system falls back to not trading."""
    with db.tx():
        cur = db.one("SELECT id FROM strategies WHERE status='CHAMPION'")
        prev = db.one("""SELECT s.id FROM strategies s JOIN deployments d ON d.strategy_id=s.id
                         WHERE s.status='RETIRED' ORDER BY d.id DESC LIMIT 1""")
        if prev:
            if cur and to_status == "QUARANTINED":
                transition(db, cfg, cur["id"], "QUARANTINED", reason, {}, actor)
            transition(db, cfg, prev["id"], "CHAMPION", f"rollback: {reason}", {"rollback_of": cur["id"] if cur else None}, actor, _rollback=True)
            return prev["id"]
        if cur:
            transition(db, cfg, cur["id"], to_status, reason, {"fallback": "NO_TRADE"}, actor)
    return None


def active_deployment(db: DB) -> dict | None:
    d = db.one("SELECT * FROM deployments WHERE active=1 ORDER BY id DESC LIMIT 1")
    if d and hashlib.sha256(d["artifact"].encode()).hexdigest() != d["sha"]:
        raise PromotionError("active deployment artifact failed its integrity check")
    return d


def lineage(db: DB, sid: str) -> list[dict]:
    out, cur = [], sid
    while cur:
        r = db.one("SELECT id,parent_id,status,family,cycle_id,hypothesis,created FROM strategies WHERE id=?", (cur,))
        if not r:
            break
        out.append(r)
        cur = r["parent_id"]
    return out
