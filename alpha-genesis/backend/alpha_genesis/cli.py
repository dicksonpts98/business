"""Command line: python -m alpha_genesis.cli <command>

  serve      start the API, dashboard and background worker (default port 8000)
  init       initialise data, features, models and the first epoch, then exit
  advance N  ingest N sessions synchronously, running whatever research they trigger
  cycle      run one research cycle now
  ablation   run the engine-contribution ablation study
  status     print a short status summary
  backup     snapshot the database, bars and models
  restore P  restore a snapshot directory created by `backup` (server must be stopped)
  verify     verify dataset checksums, the audit chain and the active deployment artifact
  fetch-real DIR [--months N] [--daily]
             download real data through the Alpha Vantage MCP server into DIR (needs ALPHAVANTAGE_API_KEY).
             Default: N months of 5-minute bars (paid Alpha Vantage plan). --daily: daily bars (free plan).
"""
from __future__ import annotations
import argparse, json, logging, shutil, sys, time


def main(argv=None):
    ap = argparse.ArgumentParser(prog="alpha-genesis", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["serve", "init", "advance", "cycle", "ablation", "status", "backup", "restore", "verify", "fetch-real", "fetch-history"])
    ap.add_argument("--start", default=None)
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--daily", action="store_true")
    ap.add_argument("arg", nargs="?")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}')
    log = logging.getLogger("alpha_genesis")
    from .config import Config
    cfg = Config()
    if a.command == "fetch-real":
        from datetime import date
        from .providers import AlphaVantageMcpProvider
        t = date.today()
        months = [f"{(t.year * 12 + t.month - 1 - k) // 12}-{(t.year * 12 + t.month - 1 - k) % 12 + 1:02d}" for k in range(a.months, 0, -1)]
        rep = AlphaVantageMcpProvider(cfg.secret("ALPHAVANTAGE_API_KEY")).download(cfg.symbols, a.arg or "real_data", months, daily_only=a.daily)
        print(json.dumps(rep, indent=1, default=str))
        sys.exit(1 if rep["failed"] and not rep["saved"] else 0)
    if a.command == "fetch-history":
        # Alpaca 5-minute history into data/raw/alpaca (incremental). Prints a verification summary; never prints credentials.
        from datetime import date
        from .core import Ctx
        from . import learning
        from .alpaca import AlpacaError
        ctx0 = Ctx(cfg)
        src = learning.alpaca_history(ctx0)
        start = date.fromisoformat(a.start or cfg.alpha["data"].get("history_start", "2023-01-03"))
        try:
            probe = src.client.bars(cfg.symbols[0], *__import__("alpha_genesis.mcal", fromlist=["x"]).session(date(2024, 3, 12)), feed=src.feeds[0])
            log.info("probe ok: %s 2024-03-12 feed=%s -> %d bars", cfg.symbols[0], src.feeds[0], len(probe))
            rep = src.update(cfg.symbols, start, log=log.info)
            if src.fx is not None:
                rep["fx_rows_fetched"] = src.fx.try_update(start, log.warning)
                rep["fx_cached"] = {"rows": int(len(src.fx.df)), "first": str(src.fx.df["date"].min()), "last": str(src.fx.df["date"].max())}
            print(json.dumps(rep, indent=1, default=str))
        except AlpacaError as e:
            print(json.dumps({"status": "failed", "error_type": type(e).__name__, "error": str(e), "auth_mode": src.client.auth_mode,
                              "restrictions": src.manifest["restrictions"]}, indent=1))
            sys.exit(2)
        return
    if a.command == "restore":
        from pathlib import Path
        src = Path(a.arg)
        if not (src / "alpha_genesis.sqlite").exists():
            sys.exit("not a backup directory")
        for name in ("bars", "models"):
            if (src / name).exists():
                shutil.rmtree(cfg.data_dir / name, ignore_errors=True)
                shutil.copytree(src / name, cfg.data_dir / name)
        for ext in ("", "-wal", "-shm"):
            (cfg.data_dir / f"alpha_genesis.sqlite{ext}").unlink(missing_ok=True)
        shutil.copy(src / "alpha_genesis.sqlite", cfg.db_path)
        (cfg.data_dir / "dop_cache.npz").unlink(missing_ok=True)
        print(f"restored {src} -> {cfg.data_dir}")
        return
    from .runtime import Runtime
    rt = Runtime(cfg, log=log.info)
    ctx = rt.ctx
    for note in rt.recovery:
        log.warning("recovery: %s", note)
    if a.command == "init":
        print(f"initialised: {ctx.market.D} sessions of {ctx.market.kind.upper()} data, epoch {ctx.epoch.id}")
    elif a.command == "advance":
        for r in rt.advance(int(a.arg or 1)):
            p = r.get("paper", {})
            print(json.dumps({"day": r.get("day"), "status": r["status"], "strategy": p.get("strategy"), "pnl_cad": round(p.get("pnl_cad", 0.0), 2),
                              "decisions": r.get("decisions"), "research_cycle": r.get("research_cycle")}))
    elif a.command == "cycle":
        from . import learning
        print(json.dumps(learning.run_cycle(ctx, learning.start_cycle(ctx, "cli request")), indent=1, default=str))
    elif a.command == "ablation":
        from . import learning
        r = learning.ablation(ctx)
        print(json.dumps({k: v for k, v in r.items() if k != "arms"}, indent=1))
        for k, v in r["arms"].items():
            print(k, v["name"], "| net", round(v["net_cad"]), "| trades", v["trades"], "|", v["selected"])
    elif a.command == "status":
        from . import registry
        ch = registry.champion(ctx.db)
        print(json.dumps({"data": ctx.market.kind, "sessions": ctx.market.D, "last_day": str(ctx.market.days[-1]), "epoch": ctx.epoch.id,
                          "champion": ch["id"] if ch else None, "strategies": {r["status"]: r["n"] for r in ctx.db.q("SELECT status, COUNT(*) n FROM strategies GROUP BY status")},
                          "halt": rt.engine.guardian.halted(), "audit_chain": ctx.db.verify_audit()}, indent=1))
    elif a.command == "backup":
        from .api import make_backup
        print(make_backup(ctx))
    elif a.command == "verify":
        from . import registry
        from .market import Market
        Market.load(ctx.bars_dir, verify=True)
        ok, n = ctx.db.verify_audit()
        dep = registry.active_deployment(ctx.db)
        print(json.dumps({"dataset_checksum": "ok", "audit_chain_ok": ok, "audit_entries": n, "active_deployment": dep["strategy_id"] if dep else None}))
        if not ok:
            sys.exit(1)
    elif a.command == "serve":
        import uvicorn
        from .api import create_app
        rt.start()
        uvicorn.run(create_app(rt), host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
