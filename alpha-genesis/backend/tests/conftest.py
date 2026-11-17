"""Shared fixtures. All market data in the test-suite is SYNTHETIC and generated on the fly."""
import shutil
from pathlib import Path
import pytest
from alpha_genesis.config import Config, ROOT
from alpha_genesis.runtime import Runtime
from alpha_genesis import learning, registry

FAST = {"darwin": {"population": 28, "generations": 3, "optuna_trials": 6, "validate_top_k": 6, "seed": 11},
        "learning": {"evolve_every_sessions": 1000, "min_holdout_days": 40, "drift_window_days": 20, "sim_session_interval_seconds": 0}}


def make_cfg(data_dir, days=420, initial=330, plant=0.5, decay=None, seed=7, **over) -> Config:
    o = {k: dict(v) for k, v in FAST.items()}
    o["data"] = {"provider": "synthetic", "synthetic_days": days, "synthetic_initial_days": initial, "synthetic_seed": seed,
                 "synthetic_plant_orb": plant, "synthetic_plant_vwap": 0.0, "synthetic_decay_start": decay}
    o["execution"] = {"fee_model": "legacy"}      # existing tests were written against the pre-v3 commission schedule
    for k, v in over.items():
        o.setdefault(k, {}).update(v)
    return Config(config_dir=ROOT / "config", data_dir=Path(data_dir), overrides=o)


@pytest.fixture(scope="session")
def world_base(tmp_path_factory):
    """A bootstrapped platform on planted synthetic data, taken through one research cycle and enough
    forward sessions for a strategy to be promoted to paper champion by the normal, guarded route."""
    d = tmp_path_factory.mktemp("world")
    rt = Runtime(make_cfg(d), log=lambda *a: None)
    summary = learning.run_cycle(rt.ctx, learning.start_cycle(rt.ctx, "test: initial cycle"))
    assert summary["approved"], f"positive control failed: nothing approved on strongly planted data: {summary}"
    rt.advance(rt.cfg.policy.min_shadow_days + 1)
    assert registry.champion(rt.ctx.db) is not None, "no champion after the shadow period"
    rt.ctx.db.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return d


@pytest.fixture
def world(world_base, tmp_path):
    """A private, mutable copy of the base world."""
    dst = tmp_path / "w"
    shutil.copytree(world_base, dst)
    return Runtime(make_cfg(dst), log=lambda *a: None)


@pytest.fixture(scope="session")
def ro(world_base, tmp_path_factory):
    """A shared copy for tests that only read."""
    dst = tmp_path_factory.mktemp("ro") / "w"
    shutil.copytree(world_base, dst)
    return Runtime(make_cfg(dst), log=lambda *a: None)
