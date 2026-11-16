"""End-to-end integration: the whole pipeline from raw bars to re-evaluation after new data, the API
contract the dashboard relies on, and the operational commands."""
import json, os, shutil, subprocess, sys
import numpy as np
import pytest
from fastapi.testclient import TestClient
from alpha_genesis import learning, registry
from alpha_genesis.api import create_app
from alpha_genesis.runtime import Runtime
from conftest import make_cfg


def test_end_to_end_pipeline(tmp_path):
    """Data ingestion -> pattern detection -> historical similarity -> candidate generation -> backtesting ->
    independent validation -> tournament -> paper promotion or rejection -> new data -> retraining -> re-evaluation."""
    rt = Runtime(make_cfg(tmp_path, learning={"evolve_every_sessions": 20, "min_holdout_days": 40}), log=lambda *a: None)
    ctx, db = rt.ctx, rt.ctx.db
    m = ctx.market
    # 1 ingestion (versioned, checksummed, labelled synthetic)
    assert m.D == 330 and m.kind == "synthetic" and db.one("SELECT checksum FROM datasets")["checksum"]
    # 2 pattern detection
    n_ev = db.one("SELECT COUNT(*) n, COUNT(DISTINCT pattern) p FROM events")
    assert n_ev["n"] > 5000 and n_ev["p"] >= 12
    # 3 historical similarity (evaluated against baselines; enabled or disabled on evidence)
    st = ctx.engine("doppelganger")
    assert set(st["evaluation"]) == {"knn_z", "knn_regime", "knn_learned", "knn_shape"} and isinstance(st["enabled"], bool)
    assert np.isfinite(ctx.fs["dop_mean_z"][:, 100:]).mean() > 0.5
    # 4-6 generation, backtesting, independent validation
    s1 = learning.run_cycle(ctx, learning.start_cycle(ctx, "e2e initial"))
    assert s1["hypotheses"] >= 2 and s1["trials"] >= 60 and s1["shortlisted"] >= 1
    assert db.one("SELECT COUNT(*) n FROM trials WHERE stage IN ('validated','val_failed')")["n"] == s1["shortlisted"]
    assert db.one("SELECT COUNT(*) n FROM skeptic_reports")["n"] == len(s1["verdicts"]) >= 1
    # 7 tournament
    ar = json.loads(db.one("SELECT results FROM arena_runs ORDER BY id DESC LIMIT 1")["results"])
    assert len(ar["competitors"]) >= 9
    # 8 promotion or rejection, by rule
    assert set(s1["verdicts"].values()) <= {"SHADOW", "REJECTED"}
    assert db.one("SELECT COUNT(*) n FROM promotions")["n"] >= len(s1["verdicts"])
    approved = [k for k, v in s1["verdicts"].items() if v == "SHADOW"]
    assert approved, "positive control: the planted effect should yield at least one approval"
    # 9 new data: sessions arrive one at a time; paper trading starts only after the shadow period
    out = rt.advance(41)
    assert [o["status"] for o in out] == ["ok"] * 41 and ctx.market.D == 371
    first_trade_day = next(i for i, o in enumerate(out) if o["paper"]["strategy"])
    assert first_trade_day >= rt.cfg.policy.min_shadow_days
    assert db.one("SELECT COUNT(*) n FROM paper_trades")["n"] > 10 and db.one("SELECT COUNT(*) n FROM equity")["n"] == 41
    clean = [o["paper"] for o in out if o["paper"]["strategy"] and o["paper"]["interventions"] == 0]
    assert len(clean) >= 20 and max(abs(p["discrepancy_cad"]) for p in clean) < 0.01    # paper execution == research assumptions
    # 10 retraining on the new epoch
    assert ctx.epoch.id == 2 and {r["id"] for r in db.q("SELECT id FROM models")} == {"logit-v1", "lgbm-v1", "logit-v2", "lgbm-v2"}
    # 11 re-evaluation: new cycles ran, on the new partition, with their own trials and verdicts
    cyc = db.q("SELECT * FROM cycles ORDER BY id")
    assert len(cyc) == 3 and [c["status"] for c in cyc] == ["done"] * 3 and cyc[-1]["epoch"] == 2 and "new epoch 2" in cyc[-1]["trigger"]
    assert db.one("SELECT COUNT(*) n FROM trials WHERE cycle_id=?", (cyc[-1]["id"],))["n"] >= 60
    assert json.loads(db.one("SELECT results FROM arena_runs ORDER BY id DESC LIMIT 1")["results"])["epoch"] == 2
    # the ledger and the audit chain tell the same story
    assert db.verify_audit()[0]
    acts = {r["action"] for r in db.q("SELECT DISTINCT action FROM audit_log")}
    assert {"bootstrap", "epoch.locked", "models.trained", "cycle.opened", "cycle.done", "holdout.consumed", "review.approved", "strategy.champion", "risk.approve"} <= acts


@pytest.fixture(scope="module")
def client(ro):
    return TestClient(create_app(ro))


def test_api_endpoints_serve_labelled_real_results(client, ro):
    db = ro.ctx.db
    eid = db.one("SELECT id FROM events ORDER BY id DESC LIMIT 1")["id"]
    rid = db.one("SELECT id FROM skeptic_reports ORDER BY id LIMIT 1")["id"]
    champ = registry.champion(db)["id"]
    urls = ["/api/status", "/api/command", "/api/days", "/api/market/bars?symbol=SPY&n=2", "/api/market/radar", "/api/twins?symbol=NVDA&bar=40",
            "/api/events?limit=5", "/api/events/stats", f"/api/events/{eid}/replay", "/api/darwin", "/api/darwin/cycle/1", "/api/arena",
            f"/api/strategy/{champ}/trades", "/api/skeptic", f"/api/skeptic/report/{rid}", "/api/paper", "/api/learning", "/api/settings"]
    for u in urls:
        r = client.get(u)
        assert r.status_code == 200, (u, r.text[:200])
        assert r.json()["data_kind"] == "synthetic", u                      # every screen can label its data
    assert client.get("/api/health").json()["ok"] is True
    assert "strategy_id" in client.get("/api/export/promotions.csv").text.splitlines()[0]
    assert client.get("/api/export/sqlite_master.csv").status_code == 404


def test_dashboard_numbers_equal_stored_experiments(client, ro):
    ctx = ro.ctx
    champ = registry.champion(ctx.db)
    a = client.get("/api/arena").json()["arena"]
    c = next(x for x in a["competitors"] if x["id"] == champ["id"])
    v0, v1 = ctx.epoch.part("val")
    fresh = ctx.backtest(champ["spec_obj"], v0, v1)
    assert c["validation"]["metrics"]["net_cad"] == pytest.approx(fresh.metrics["net_cad"]) and c["validation"]["equity"][-1] == pytest.approx(fresh.daily.sum(), abs=0.01)
    lab = client.get("/api/darwin").json()
    assert lab["total_trials"] == ctx.db.one("SELECT COUNT(*) n FROM trials")["n"]
    pt = client.get("/api/paper").json()
    assert pt["summary"]["n"] == ctx.db.one("SELECT COUNT(*) n FROM paper_trades")["n"] and pt["mode"].startswith("PAPER ONLY")


def test_replay_separates_what_was_known_from_what_came_after(client, ro):
    e = ro.ctx.db.one("SELECT * FROM events WHERE pattern='ORB_FAIL_UP' AND bar BETWEEN 10 AND 60 ORDER BY id DESC LIMIT 1")
    r = client.get(f"/api/events/{e['id']}/replay").json()
    assert max(c["bar"] for c in r["known_at_detection"]) == e["bar"] and min(c["bar"] for c in r["after_detection"]) == e["bar"] + 1
    assert r["outcome"]["entry_time"] == r["after_detection"][0]["time"] and r["detected_at"] == e["ts"]
    assert r["levels_at_detection"]["or_high"] == pytest.approx(e["level"])


def test_holdout_trades_are_withheld_from_strategies_never_granted_a_look(client, ro):
    rej = ro.ctx.db.one("SELECT s.id FROM strategies s WHERE s.status='REJECTED' AND s.id NOT IN (SELECT subject FROM holdout_ledger) LIMIT 1")
    if rej:
        assert client.get(f"/api/strategy/{rej['id']}/trades?window=holdout").status_code == 403
    assert client.get(f"/api/strategy/{registry.champion(ro.ctx.db)['id']}/trades?window=holdout").status_code == 200


def test_operator_controls_and_token(world, monkeypatch):
    c = TestClient(create_app(world))
    assert c.post("/api/control/kill?on=true&reason=drill").json()["kill_switch"]["on"] is True
    assert c.get("/api/status").json()["halt"].startswith("kill switch")
    c.post("/api/control/kill?on=false&reason=done")
    assert c.post("/api/control/advance?n=2").json() == {"queued": 2}
    D = world.ctx.market.D
    assert world.worker.drain() >= 2 and world.ctx.market.D == D + 2
    assert c.post("/api/control/schedule?interval_seconds=30").json()["schedules"][0]["enabled"] == 1
    bk = c.post("/api/control/backup").json()["backup"]
    assert os.path.exists(os.path.join(bk, "alpha_genesis.sqlite")) and os.path.exists(os.path.join(bk, "bars", "_manifest.json"))
    monkeypatch.setenv("AG_OPERATOR_TOKEN", "s3cret")
    assert c.post("/api/control/kill?on=true").status_code == 403
    assert c.post("/api/control/kill?on=true", headers={"X-Operator-Token": "s3cret"}).status_code == 200


def test_scheduler_enqueues_due_jobs_once(world):
    from alpha_genesis import jobs
    db = world.ctx.db
    jobs.set_schedule(db, "session_feed", "session_close", 0.01, True)
    import time
    time.sleep(0.05)
    assert jobs.tick(db) == 1 and jobs.tick(db) == 0                          # due once; an identical queued job is not duplicated
    D = world.ctx.market.D
    assert world.worker.drain() >= 1 and world.ctx.market.D == D + 1


def test_cli_status_verify_backup_restore(world_base, tmp_path):
    d = tmp_path / "cli"
    shutil.copytree(world_base, d)
    env = {**os.environ, "AG_DATA_DIR": str(d)}
    run = lambda *a: subprocess.run([sys.executable, "-W", "ignore", "-m", "alpha_genesis.cli", *a], env=env, capture_output=True, text=True, timeout=600)
    st = run("status")
    assert st.returncode == 0, st.stderr[-500:]
    assert json.loads(st.stdout)["champion"].startswith("DRW-")
    v = run("verify")
    assert v.returncode == 0 and json.loads(v.stdout)["audit_chain_ok"] is True
    bk = run("backup").stdout.strip().splitlines()[-1]
    adv = run("advance", "2")
    assert adv.returncode == 0 and len([l for l in adv.stdout.splitlines() if l.startswith("{")]) == 2
    assert json.loads(run("status").stdout)["sessions"] == 343
    assert run("restore", bk).returncode == 0
    assert json.loads(run("status").stdout)["sessions"] == 341               # state is back to the snapshot


def test_secrets_never_live_in_config_files():
    from alpha_genesis.config import ROOT
    for f in (ROOT / "config").glob("*.toml"):
        t = f.read_text().lower()
        assert "api_key" not in t and "secret" not in t and "password" not in t
    assert ".env" in (ROOT / ".gitignore").read_text()
