"""Self-learning proof: train, receive observations, detect a reason to re-evaluate, generate and judge a
versioned challenger, preserve and roll back champions, recover from interruption, survive restart."""
import hashlib, json, shutil, sqlite3
from pathlib import Path
import numpy as np
import pytest
from alpha_genesis import jobs, learning, models, registry, skeptic
from alpha_genesis.dsl import Exit, StrategySpec, Trigger
from alpha_genesis.paper import InjectedCrash
from alpha_genesis.registry import PromotionError
from alpha_genesis.runtime import Runtime
from conftest import make_cfg


def test_first_models_are_trained_versioned_and_hashed(ro):
    rows = ro.ctx.db.q("SELECT * FROM models ORDER BY id")
    assert {r["id"] for r in rows} == {"logit-v1", "lgbm-v1"}
    for r in rows:
        blob = (ro.cfg.data_dir / r["path"]).read_bytes()
        assert hashlib.sha256(blob).hexdigest() == r["sha"]
        m = json.loads(r["metrics"])
        assert m["n_train"] > 5000 and 0.3 < m["internal_auc"] < 0.9 and len(m["importance"]) == len(m["features"])


def test_tampered_model_artifact_is_refused(world):
    r = world.ctx.db.one("SELECT * FROM models WHERE id='logit-v1'")
    p = world.cfg.data_dir / r["path"]
    p.write_bytes(p.read_bytes() + b"x")
    with pytest.raises(IOError, match="hash"):
        models.load(world.ctx.db, "logit-v1")


def test_new_observations_trigger_retraining_and_a_versioned_challenger(world_base, tmp_path):
    """Sessions arrive -> schedule fires -> a new epoch is locked from never-searched forward sessions ->
    models are retrained as v2 (v1 untouched) -> Darwin generates challengers -> the Skeptic rules on them."""
    dst = tmp_path / "w"
    shutil.copytree(world_base, dst)
    rt = Runtime(make_cfg(dst, learning={"evolve_every_sessions": 20, "min_holdout_days": 40}), log=lambda *a: None)
    ctx, db = rt.ctx, rt.ctx.db
    champ0 = registry.champion(db)["id"]
    v1 = {r["id"]: (r["sha"], (dst / r["path"]).read_bytes()) for r in db.q("SELECT * FROM models")}
    ep0 = ctx.epoch
    n_strat0 = db.one("SELECT COUNT(*) n FROM strategies WHERE status!='BASELINE'")["n"]
    out = rt.advance(30)                      # 11 forward sessions already exist: cycles fire at 20 and 40 forward sessions
    assert all(o["status"] == "ok" for o in out)
    cycles = db.q("SELECT * FROM cycles ORDER BY id")
    assert len(cycles) >= 3 and all(c["status"] == "done" for c in cycles)
    assert any("scheduled" in c["trigger"] for c in cycles[1:])
    # a new epoch was locked and its holdout is exactly the forward sessions the old search never saw
    ep1 = ctx.epoch
    assert ep1.id == ep0.id + 1 and ep1.val_end == ep0.holdout_end and ep1.holdout_end > ep0.holdout_end
    assert ep1.holdout_end - ep1.val_end >= 40
    # retraining produced new immutable versions and left the old artifacts byte-identical
    ids = {r["id"]: r for r in db.q("SELECT * FROM models")}
    assert {"logit-v1", "lgbm-v1", "logit-v2", "lgbm-v2"} <= set(ids)
    for mid, (sha, blob) in v1.items():
        assert ids[mid]["sha"] == sha and (dst / ids[mid]["path"]).read_bytes() == blob
    assert ids["logit-v2"]["train_end"] == ep1.dev_end > ids["logit-v1"]["train_end"]
    assert json.loads(ids["logit-v2"]["metrics"])["n_train"] > json.loads(ids["logit-v1"]["metrics"])["n_train"]
    # challengers were generated, versioned, and each one was ruled on by the Skeptic under the fixed policy
    new = db.q("SELECT * FROM strategies WHERE status!='BASELINE' AND epoch=?", (ep1.id,))
    assert new and db.one("SELECT COUNT(*) n FROM strategies WHERE status!='BASELINE'")["n"] > n_strat0
    for s in new:
        rep = db.one("SELECT verdict, policy_sha FROM skeptic_reports WHERE strategy_id=?", (s["id"],))
        assert rep and rep["policy_sha"] == rt.cfg.policy.sha and s["status"] != "CANDIDATE"
        assert (rep["verdict"] == "APPROVED") == (s["status"] in ("APPROVED", "SHADOW", "CHAMPION", "RETIRED"))
    # the previous champion is preserved: still champion, or retired with its deployment artifact intact
    old = registry.get(db, champ0)
    assert old["status"] in ("CHAMPION", "RETIRED")
    dep = db.one("SELECT * FROM deployments WHERE strategy_id=? ORDER BY id LIMIT 1", (champ0,))
    assert hashlib.sha256(dep["artifact"].encode()).hexdigest() == dep["sha"] and json.loads(dep["artifact"])["mode"] == "PAPER_ONLY"
    assert db.one("SELECT COUNT(*) n FROM metrics WHERE kind='drift'")["n"] == 30 + 11
    assert db.verify_audit()[0]


def test_strategy_versions_are_immutable(world):
    db = world.ctx.db
    sid = registry.champion(db)["id"]
    with pytest.raises(sqlite3.DatabaseError, match="immutable"):
        db.x("UPDATE strategies SET spec='{}' WHERE id=?", (sid,))
    spec = registry.spec_of(db, sid)
    child = spec.model_copy(update={"exit": Exit(max_hold=spec.exit.max_hold + 1, stop_kind=spec.exit.stop_kind, stop_atr=spec.exit.stop_atr)})
    cid = registry.register(db, child, parent_id=sid, epoch=world.ctx.epoch.id)
    assert cid.split("-v")[0] == sid.split("-v")[0] and int(cid.split("-v")[1]) > int(sid.split("-v")[1])
    assert registry.spec_of(db, sid).hash() == spec.hash()                 # parent unchanged
    assert [r["id"] for r in registry.lineage(db, cid)][:2] == [cid, sid]


def test_unauthorised_promotion_is_impossible(world):
    db, cfg = world.ctx.db, world.cfg
    spec = StrategySpec(family="event", trigger=Trigger(kind="event", patterns=["PDH_FAIL"]), exit=Exit(max_hold=7))
    sid = registry.register(db, spec, epoch=world.ctx.epoch.id)
    champ = registry.champion(db)["id"]
    for to in ("CHAMPION", "SHADOW"):
        with pytest.raises(PromotionError):
            registry.transition(db, cfg, sid, to, "sneaky", {"shadow_days": 99, "forward_ok": True, "risk_sha": cfg.risk.sha})
    with pytest.raises(PromotionError):                                    # approval needs a real Skeptic report…
        registry.transition(db, cfg, sid, "APPROVED", "self-approved", {"skeptic_report_id": 1}, actor="skeptic")
    rid = db.x("INSERT INTO skeptic_reports(strategy_id,verdict,checks,created) VALUES(?,?,?,0)", (sid, "REJECTED", "{}"))
    with pytest.raises(PromotionError):                                    # …with an APPROVED verdict…
        registry.transition(db, cfg, sid, "APPROVED", "x", {"skeptic_report_id": rid}, actor="skeptic")
    rid2 = db.x("INSERT INTO skeptic_reports(strategy_id,verdict,checks,created) VALUES(?,?,?,0)", ("someone-else", "APPROVED", "{}"))
    with pytest.raises(PromotionError):                                    # …issued for this strategy…
        registry.transition(db, cfg, sid, "APPROVED", "x", {"skeptic_report_id": rid2}, actor="skeptic")
    with pytest.raises(sqlite3.DatabaseError, match="APPROVED Research Skeptic report"):   # …and raw SQL is blocked too
        db.x("UPDATE strategies SET status='CHAMPION' WHERE id=?", (sid,))
    assert registry.get(db, sid)["status"] == "CANDIDATE" and registry.champion(db)["id"] == champ


def test_shadow_strategy_needs_forward_evidence_before_promotion(world):
    db, cfg = world.ctx.db, world.cfg
    sh = registry.by_status(db, "SHADOW")
    if not sh:
        pytest.skip("base world has no remaining shadow strategy")
    for ev in ({"shadow_days": 2, "forward_ok": True, "risk_sha": cfg.risk.sha}, {"shadow_days": 50, "forward_ok": False, "risk_sha": cfg.risk.sha},
               {"shadow_days": 50, "forward_ok": True, "risk_sha": "stale"}):
        with pytest.raises(PromotionError):
            registry.transition(db, cfg, sh[0]["id"], "CHAMPION", "premature", ev)


def test_rejected_challenger_is_isolated(world):
    """A challenger that fails review is recorded, kept out of deployment, and leaves the champion untouched."""
    ctx, db = world.ctx, world.ctx.db
    champ = registry.champion(db)
    dep = registry.active_deployment(db)
    bad = StrategySpec(family="feature", trigger=Trigger(kind="feature", feat="ret_3_z", thr=0.6), exit=Exit(max_hold=3, stop_atr=1.0))   # overtrades noise
    sid = registry.register(db, bad, epoch=ctx.epoch.id, parent_id=champ["id"])
    uses = ctx.holdout_uses()
    rep = skeptic.review(ctx, sid, {"n_trials": 50})
    assert rep["verdict"] == "REJECTED" and rep["failed"]
    assert registry.get(db, sid)["status"] == "REJECTED"
    assert ctx.holdout_uses() == uses                                      # a loser never gets to see the holdout
    assert [c for c in rep["checks"] if c["check"] == "holdout"][0]["status"] == "na"
    for to in ("APPROVED", "SHADOW", "CHAMPION"):
        with pytest.raises(PromotionError):
            registry.transition(db, world.cfg, sid, to, "resurrect", {"skeptic_report_id": rep["id"]}, actor="skeptic")
    assert registry.champion(db)["id"] == champ["id"] and registry.active_deployment(db)["sha"] == dep["sha"]
    assert db.one("SELECT lesson FROM kb_lessons WHERE subject=?", (sid,))["lesson"].startswith("skeptic_rejected")


def _force_second_champion(rt):
    """Promote a second strategy through the legitimate gate (real approval, real evidence fields)."""
    db, cfg = rt.ctx.db, rt.cfg
    sh = registry.by_status(db, "SHADOW")
    assert sh, "need a shadow strategy"
    registry.transition(db, cfg, sh[0]["id"], "CHAMPION", "test promotion", {"shadow_days": cfg.policy.min_shadow_days, "forward_ok": True, "risk_sha": cfg.risk.sha}, "arena")
    return sh[0]["id"]


def test_faulty_promotion_is_rolled_back_to_the_preserved_champion(world):
    db = world.ctx.db
    first = registry.champion(db)["id"]
    art1 = db.one("SELECT artifact, sha FROM deployments WHERE strategy_id=? AND active=1", (first,))
    second = _force_second_champion(world)
    assert registry.champion(db)["id"] == second and registry.get(db, first)["status"] == "RETIRED"
    assert registry.active_deployment(db)["strategy_id"] == second
    restored = registry.rollback(db, world.cfg, "faulty promotion detected", actor="operator")
    assert restored == first and registry.champion(db)["id"] == first
    assert registry.get(db, second)["status"] == "ROLLED_BACK"
    dep = registry.active_deployment(db)
    assert dep["strategy_id"] == first and dep["sha"] == art1["sha"] and dep["artifact"] == art1["artifact"]     # the original frozen artifact
    log = [(r["strategy_id"], r["to_status"]) for r in db.q("SELECT * FROM promotions ORDER BY id")][-4:]
    assert log == [(first, "RETIRED"), (second, "CHAMPION"), (second, "ROLLED_BACK"), (first, "CHAMPION")]
    with pytest.raises(PromotionError):
        registry.transition(db, world.cfg, second, "CHAMPION", "come back", {"shadow_days": 99, "forward_ok": True, "risk_sha": world.cfg.risk.sha})
    d = world.advance(1)[0]
    assert d["paper"]["strategy"] == first                                 # paper trading continues on the restored champion


def test_rollback_with_no_predecessor_falls_back_to_not_trading(world):
    db = world.ctx.db
    assert registry.rollback(db, world.cfg, "only champion is faulty") is None
    assert registry.champion(db) is None and registry.active_deployment(db) is None
    assert world.advance(1)[0]["paper"]["strategy"] is None


def test_tampered_deployment_artifact_is_detected(world):
    db = world.ctx.db
    db.x("UPDATE deployments SET artifact=REPLACE(artifact, 'PAPER_ONLY', 'LIVE') WHERE active=1")
    with pytest.raises(PromotionError, match="integrity"):
        registry.active_deployment(db)


def test_drift_detection_flags_a_shifted_distribution(world):
    ctx = world.ctx
    calm = learning.drift(ctx)
    assert len(calm["flagged"]) <= 2
    D, w = ctx.market.D, world.cfg.alpha["learning"]["drift_window_days"]
    for k in ("vol_ratio", "rel_vol", "vwap_z"):
        ctx.fs[k][:, D - w:] = ctx.fs[k][:, D - w:] * 2.5 + 1.0             # simulate a regime the models never saw
    shifted = learning.drift(ctx)
    assert {"vol_ratio", "rel_vol", "vwap_z"} <= set(shifted["flagged"])
    assert shifted["psi"]["vol_ratio"] > 0.25 > calm["psi"]["vol_ratio"]


def test_interrupted_research_cycle_resumes_from_its_checkpoint(world):
    ctx, db = world.ctx, world.ctx.db
    cid = learning.start_cycle(ctx, "test: interruption")
    ctx.fail_at = "evolve:2"
    with pytest.raises(InjectedCrash):
        learning.run_cycle(ctx, cid)
    mid = db.one("SELECT * FROM cycles WHERE id=?", (cid,))
    n_mid = db.one("SELECT COUNT(*) n FROM trials WHERE cycle_id=?", (cid,))["n"]
    assert mid["status"] == "running" and mid["stage"] == "evolve" and json.loads(mid["state"])["gen"] == 2 and n_mid > 20
    reborn = Runtime(make_cfg(world.cfg.data_dir), log=lambda *a: None)     # process restart
    summary = learning.run_cycle(reborn.ctx, cid)
    assert summary["resumed"] and reborn.ctx.db.one("SELECT status FROM cycles WHERE id=?", (cid,))["status"] == "done"
    n_end = reborn.ctx.db.one("SELECT COUNT(*) n, COUNT(DISTINCT spec_hash) u FROM trials WHERE cycle_id=?", (cid,))
    assert n_end["n"] == n_end["u"] > n_mid                                # nothing double-counted
    assert reborn.ctx.db.one("SELECT COUNT(*) n FROM recovery_log WHERE message LIKE '%resumed at stage%'")["n"] == 1
    # determinism: an uninterrupted run of the same cycle explores the same strategies
    gens_resumed = reborn.ctx.db.q("SELECT generation, COUNT(*) n FROM trials WHERE cycle_id=? GROUP BY generation ORDER BY generation", (cid,))
    assert [g["generation"] for g in gens_resumed][:4] == [0, 1, 2, 3]


def test_job_queue_survives_restart_and_retries_from_checkpoint(world):
    db = world.ctx.db
    cid = learning.start_cycle(world.ctx, "test: queued")
    jid = jobs.enqueue(db, "research_cycle", {"cycle_id": cid}, f"cycle:{cid}")
    assert jobs.enqueue(db, "research_cycle", {"cycle_id": cid}, f"cycle:{cid}") is None      # de-duplicated
    world.ctx.fail_at = "tune"
    assert world.worker.run_one()                                          # fails inside the handler
    j = db.one("SELECT * FROM jobs WHERE id=?", (jid,))
    assert j["status"] == "queued" and j["attempts"] == 1 and "InjectedCrash" in j["error"]
    db.x("UPDATE jobs SET status='running', lease_until=0 WHERE id=?", (jid,))                # simulate a process killed mid-job
    reborn = Runtime(make_cfg(world.cfg.data_dir), log=lambda *a: None)
    assert jobs.recover(reborn.ctx.db, force=True) == 1
    assert reborn.worker.drain() >= 1
    assert reborn.ctx.db.one("SELECT status FROM jobs WHERE id=?", (jid,))["status"] == "done"
    assert reborn.ctx.db.one("SELECT status FROM cycles WHERE id=?", (cid,))["status"] == "done"
    assert reborn.ctx.db.one("SELECT COUNT(*) n FROM recovery_log WHERE message LIKE '%re-queued%'")["n"] >= 2


def test_job_fails_permanently_after_bounded_retries(world):
    db = world.ctx.db
    world.worker.handlers["boom"] = lambda p: 1 / 0
    jid = jobs.enqueue(db, "boom")
    assert world.worker.drain() == jobs.MAX_ATTEMPTS
    j = db.one("SELECT * FROM jobs WHERE id=?", (jid,))
    assert j["status"] == "failed" and "ZeroDivisionError" in j["error"]
    assert db.one("SELECT COUNT(*) n FROM alerts WHERE source='jobs' AND level='critical'")["n"] == 1


def test_state_is_identical_after_restart_and_learning_continues(world):
    a = world
    snap = lambda rt: (rt.ctx.market.D, rt.ctx.epoch, registry.champion(rt.ctx.db)["id"], rt.engine.equity(),
                       {r["id"]: r["status"] for r in rt.ctx.db.q("SELECT id, status FROM strategies")},
                       float(np.nansum(rt.ctx.fs["vwap_z"])), float(np.nansum(rt.ctx.dop.pred["knn_z"])), rt.ctx.db.get_meta("last_cycle_session"))
    a.advance(2)
    before = snap(a)
    b = Runtime(make_cfg(a.cfg.data_dir), log=lambda *x: None)
    after = snap(b)
    assert before[:5] == after[:5] and before[5] == pytest.approx(after[5]) and before[6] == pytest.approx(after[6]) and before[7] == after[7]
    out = b.advance(2)
    assert [o["status"] for o in out] == ["ok", "ok"] and b.ctx.market.D == before[0] + 2
    assert b.ctx.db.one("SELECT COUNT(*) n FROM equity")["n"] == a.ctx.db.one("SELECT COUNT(*) n FROM equity")["n"]


def test_feed_failure_is_survived_and_retried(world):
    real = world.provider.fetch_session
    world.provider.fetch_session = lambda day, symbols: real(day, symbols).iloc[0:0]          # feed delivers nothing
    D = world.ctx.market.D
    out = world.advance(1)[0]
    assert out["status"] == "feed_failure" and world.ctx.market.D == D and len(world.ctx.market.fx) == D
    assert world.ctx.db.one("SELECT COUNT(*) n FROM alerts WHERE source='data'")["n"] == 1
    world.provider.fetch_session = real
    assert world.advance(1)[0]["status"] == "ok" and world.ctx.market.D == D + 1


def test_partial_feed_is_ingested_with_gaps_and_flagged(world):
    real = world.provider.fetch_session
    def partial(day, symbols):
        df = real(day, symbols)
        return df[df["symbol"] != "TSLA"]
    world.provider.fetch_session = partial
    out = world.advance(1)[0]
    m = world.ctx.market
    assert out["status"] == "ok" and np.isnan(m.c[m.sidx("TSLA"), -1]).all() and np.isfinite(m.c[0, -1]).all()
    assert world.ctx.db.one("SELECT COUNT(*) n FROM data_issues WHERE symbol='TSLA' AND kind='missing_bars'")["n"] == 1
    assert world.ctx.db.one("SELECT COUNT(*) n FROM paper_trades WHERE symbol='TSLA' AND d=?", (m.D - 1,))["n"] == 0
