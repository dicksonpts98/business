"""Configuration loading. Three files, three owners:
alpha.toml (operations), risk.toml (Risk Guardian), validation_policy.toml (Research Skeptic)."""
from __future__ import annotations
import hashlib, json, os, tomllib
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BARS_PER_DAY = 78  # 5-minute bars, 09:30-16:00 America/New_York


def _load(path: Path) -> dict:
    with open(path, "rb") as f:
        return tomllib.load(f)


def _sha(d: dict) -> str:
    return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()


@dataclass(frozen=True)
class Frozen:
    """Read-only attribute view over a dict; used for risk limits and validation policy."""
    _d: dict = field(default_factory=dict)

    def __getattr__(self, k):
        try:
            return self._d[k]
        except KeyError as e:
            raise AttributeError(k) from e

    def as_dict(self) -> dict:
        return dict(self._d)

    @property
    def sha(self) -> str:
        return _sha(self._d)


class Config:
    def __init__(self, config_dir: Path | None = None, data_dir: Path | None = None, overrides: dict | None = None):
        self.config_dir = Path(config_dir or os.environ.get("AG_CONFIG_DIR", ROOT / "config"))
        self.data_dir = Path(data_dir or os.environ.get("AG_DATA_DIR", ROOT / "data"))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.alpha = _load(self.config_dir / "alpha.toml")
        for k, v in (overrides or {}).items():  # {"darwin": {"population": 12}}
            self.alpha.setdefault(k, {}).update(v) if isinstance(v, dict) else self.alpha.__setitem__(k, v)
        for env, key, cast in (("AG_PROVIDER", "provider", str), ("AG_HISTORY_START", "history_start", str), ("AG_REPLAY_RESERVE_DAYS", "replay_reserve_days", int)):
            if os.environ.get(env):                 # per-deployment overrides without editing the shared config file
                self.alpha["data"][key] = cast(os.environ[env])
        self.risk = Frozen(_load(self.config_dir / "risk.toml"))
        self.policy = Frozen(_load(self.config_dir / "validation_policy.toml"))

    @property
    def symbols(self) -> list[str]:
        return list(self.alpha["universe"]["symbols"])

    @property
    def proxy(self) -> str:
        return self.alpha["universe"]["market_proxy"]

    @property
    def db_path(self) -> Path:
        return self.data_dir / "alpha_genesis.sqlite"

    def instrument(self, sym: str) -> dict:
        return self.alpha.get("instruments", {}).get(sym, {"half_spread_bps": 2.0, "shortable": True})

    def secret(self, name: str) -> str | None:
        """Credentials come only from the environment (or a local .env that is git-ignored)."""
        v = os.environ.get(name)
        if v:
            return v
        env = ROOT / ".env"
        if env.exists():
            for line in env.read_text().splitlines():
                if line.strip().startswith(name + "="):
                    return line.split("=", 1)[1].strip().strip('"')
        return None
