"""Supervised models. Each trained model is an immutable, versioned artifact (pickle + sha256); retraining
never edits a model in place — it creates the next version. A model's scores are usable only on sessions
after its training window (enforced by min_day in the backtester and paper trader)."""
from __future__ import annotations
import hashlib, pickle, time
from pathlib import Path
import numpy as np
from .features import BASE_FEATURES, forward_labels
from .liedetector import PATTERN_IDS
from .market import Market

HORIZON = 12
KINDS = ("logit", "lgbm")


def _matrix(fs, d0: int, d1: int) -> np.ndarray:
    cols = [fs[k][:, d0:d1] for k in BASE_FEATURES]
    ev = sum(fs["ev:" + p][:, d0:d1].astype(float) for p in PATTERN_IDS)
    ev3 = ev.copy()
    ev3[:, :, 1:] += ev[:, :, :-1]
    ev3[:, :, 2:] += ev[:, :, :-2]
    return np.stack(cols + [ev3], axis=-1)          # [S, D, 78, F]; last column = net failed-pattern direction, last 3 bars


def train(kind: str, m: Market, fs, train_end: int, model_dir: Path, db, epoch: int, seed: int = 0) -> str:
    """Fit on sessions [0, train_end). Labels end inside their own session, so a session split needs no purge;
    the last 20% of training sessions is an internal check of calibration only."""
    assert kind in KINDS
    fwd, _ = forward_labels(m, HORIZON)
    X = _matrix(fs, 0, train_end)[:, :, ::2]
    y = fwd[:, :train_end, ::2]
    days = np.broadcast_to(np.arange(train_end)[None, :, None], y.shape)
    ok = np.isfinite(X).all(-1) & np.isfinite(y)
    X, yb, days = X[ok], (y[ok] > 0).astype(int), days[ok]
    cut = int(train_end * 0.8)
    def make():
        if kind == "logit":
            from sklearn.linear_model import LogisticRegression
            from sklearn.pipeline import make_pipeline
            from sklearn.preprocessing import StandardScaler
            return make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=300))
        import lightgbm as lgb
        return lgb.LGBMClassifier(n_estimators=120, num_leaves=8, learning_rate=0.03, min_child_samples=300, subsample=0.8,
                                  subsample_freq=1, colsample_bytree=0.8, reg_lambda=5.0, random_state=seed, verbose=-1, n_jobs=2)
    chk = make().fit(np.clip(X[days < cut], -8, 8), yb[days < cut])
    p = chk.predict_proba(np.clip(X[days >= cut], -8, 8))[:, 1]
    yt = yb[days >= cut]
    base = yb[days < cut].mean()
    from sklearn.metrics import roc_auc_score
    metrics = {"n_train": int(len(yb)), "internal_auc": float(roc_auc_score(yt, p)) if len(set(yt)) > 1 else None,
               "internal_brier": float(((p - yt) ** 2).mean()), "internal_brier_base": float(((base - yt) ** 2).mean()),
               "features": BASE_FEATURES + ["ev_net3"], "train_sessions": [0, train_end]}
    model = make().fit(np.clip(X, -8, 8), yb)
    if kind == "lgbm":
        metrics["importance"] = dict(zip(metrics["features"], [int(v) for v in model.feature_importances_]))
    else:
        metrics["importance"] = dict(zip(metrics["features"], [float(abs(v)) for v in model[-1].coef_[0]]))
    ver = (db.one("SELECT COALESCE(MAX(version),0) v FROM models WHERE kind=?", (kind,))["v"]) + 1
    mid = f"{kind}-v{ver}"
    model_dir.mkdir(parents=True, exist_ok=True)
    path = model_dir / f"{mid}.pkl"
    blob = pickle.dumps(model)
    path.write_bytes(blob)
    from .db import jd
    db.x("INSERT INTO models(id,kind,version,epoch,train_end,path,sha,metrics,created) VALUES(?,?,?,?,?,?,?,?,?)",
         (mid, kind, ver, epoch, train_end, str(path), hashlib.sha256(blob).hexdigest(), jd(metrics), time.time()))
    return mid


def load(db, mid: str):
    row = db.one("SELECT * FROM models WHERE id=?", (mid,))
    if row is None:
        raise KeyError(mid)
    blob = Path(row["path"]).read_bytes()
    if hashlib.sha256(blob).hexdigest() != row["sha"]:
        raise IOError(f"model artifact {mid} does not match its recorded hash")
    return pickle.loads(blob), row


def write_scores(db, fs, mid: str, D: int):
    """Column ml:<id> = P(up) - 0.5 for every session; extends incrementally as sessions arrive."""
    key = "ml:" + mid
    have = fs[key].shape[1] if key in fs else 0
    done = getattr(fs, "_ml_done", {}).get(mid, 0)
    if done >= D and have >= D:
        return
    model, _ = load(db, mid)
    X = _matrix(fs, done, D)
    ok = np.isfinite(X).all(-1)
    out = np.full(X.shape[:3], np.nan)
    if ok.any():
        out[ok] = model.predict_proba(np.clip(X[ok], -8, 8))[:, 1] - 0.5
    full = np.full((X.shape[0], D, X.shape[2]), np.nan)
    if key in fs and done:
        full[:, :done] = fs[key][:, :done]
    full[:, done:] = out
    fs.set(key, full)
    if not hasattr(fs, "_ml_done"):
        fs._ml_done = {}
    fs._ml_done[mid] = D
