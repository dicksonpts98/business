# Operating ALPHA GENESIS

## 1. Start

Requirements: Python ≥ 3.11, Node ≥ 20 (to build the dashboard once). Works on Linux, macOS and
Windows via WSL2 (developed and tested on Linux only).

```bash
pip install -r requirements.txt && pip install -e backend
(cd frontend && npm ci && npm run build)
python -m alpha_genesis.cli serve                 # API + dashboard + worker on 127.0.0.1:8000
```

| Command (`python -m alpha_genesis.cli …`) | Purpose |
| --- | --- |
| `serve [--host H --port P]` | API, dashboard and the background worker |
| `init` | initialise data, features, models, first epoch; exit |
| `advance N` | ingest N sessions synchronously, including any research they trigger |
| `cycle` | run one research cycle now |
| `ablation` | run the engine-contribution study |
| `status` / `verify` | summary / verify dataset checksums, audit chain, active deployment |
| `backup` / `restore <dir>` | snapshot / restore database, bars and models (stop the server to restore) |

State lives in `data/` (override with `AG_DATA_DIR`). Delete it to start again from nothing.
Do not run `advance`/`cycle` from the CLI while `serve` is running against the same data directory:
both would act as the worker.

## 2. Configuration files

| File | Owner | Contents |
| --- | --- | --- |
| `config/alpha.toml` | operations | universe, data provider, execution-cost assumptions, research budgets, schedules |
| `config/risk.toml` | Risk Guardian | CAD 10,000 capital, CAD 50 risk/trade, CAD 200 daily loss, 20 entries/day, exposure, leverage |
| `config/validation_policy.toml` | Research Skeptic | every approval threshold and the holdout budget |

Changes take effect on restart. The hash of the risk and policy files is stamped on every promotion
and Skeptic report, so you can always tell which rules a decision was made under.

## 3. Market data

**Offline (default).** `provider = "synthetic"` generates a labelled synthetic market; 560 sessions are
available to research and the remaining 196 are released one at a time by a simulated feed. Set
`synthetic_plant_orb = 0` for a null market.

**Your own history (CSV or Parquet) — tested.** One file per symbol, `<SYMBOL>.csv` or `.parquet`, with
columns `timestamp, open, high, low, close, volume`; 5-minute bars labelled by bar-open time (1-minute
bars are aggregated automatically). Optional `corporate_actions.csv` (`symbol, ex_date, kind, value`
with kind `split` or `dividend`) and `fx_usdcad.csv` (`date, rate`).

```toml
[data]
provider = "csv"                 # or "parquet"
path = "/absolute/path/to/files"
timezone = "America/New_York"    # required only if timestamps carry no UTC offset
```

Delete `data/` and start again. At least 200 sessions are required. Rows that fail validation are
dropped (never repaired), a suspected unadjusted split quarantines that symbol-session, and everything
is listed under Learning Monitor → data issues. Without `fx_usdcad.csv` there is no USD/CAD rate and
the system will research but will not size or place any paper trade.

**Alpaca (5-minute history) — built and tested against a simulated server; live authentication not yet
achieved.** Set `APCA_API_KEY_ID` and `APCA_API_SECRET_KEY` in the environment (or `.env`, or the systemd
`EnvironmentFile`). Then:

```bash
python -m alpha_genesis.cli fetch-history --start 2023-01-03    # probe, then incremental download + USD/CAD
```

It first requests one known session as a probe, then downloads month by month into
`data/raw/alpaca/<SYMBOL>/<YYYY-MM>.parquet` with a manifest (row counts, checksums, feed used,
duplicates removed, splits, and any refusal message verbatim). Re-running fetches only what is missing
and refreshes the current month. SIP is tried first; if the plan refuses it the refusal is recorded and
IEX is used. USD/CAD comes from the Bank of Canada (official, free, verified live). To research on it,
set `provider = "alpaca"` in `config/alpha.toml` and start with an empty data directory; set
`replay_reserve_days` to hold back recent sessions and replay them one at a time.

On this cloud build environment the two Alpaca headers must be saved as network secrets for
`data.alpaca.markets`; a username/password secret is rejected by Alpaca with 401.

To run permanently on your own machine: `deploy/alpha-genesis.service` (systemd) or
`docker compose up -d`. Set the session feed cadence (Settings, or `sim_session_interval_seconds`) to
e.g. 600: each tick is a no-op until a new completed session exists, then the full daily pipeline runs.

**Alpha Vantage MCP server — live connection verified, 5-minute bars need a paid plan.** The platform
is itself an MCP client (`mcp_client.py`) of the official server at `https://mcp.alphavantage.co/mcp`.
Get a free key at alphavantage.co/support/#api-key and export `ALPHAVANTAGE_API_KEY` (sent as a bearer
header, never in the URL).

```bash
python -m alpha_genesis.cli fetch-real real_data --daily        # free plan: daily bars + USD/CAD
python -m alpha_genesis.cli fetch-real real_data --months 14    # paid plan: 5-minute history, importable
```

What was observed with a free key: handshake, authentication, tool discovery, `TIME_SERIES_DAILY` and
`FX_DAILY` work (25 calls/day, about 1/second); `TIME_SERIES_INTRADAY` is refused as a premium
endpoint, in every parameter combination tried. So on the free plan you get a real `fx_usdcad.csv`
(usable with any CSV import) and daily bars (not usable by the intraday engines). With a paid key,
`fetch-real` writes per-symbol 5-minute CSVs; point `[data] provider = "csv"` at that folder to
initialise, then set `provider = "alphavantage_mcp"` for new sessions. That intraday path is tested only
against a simulated server.

Credentials are read only from the environment or `.env`; they are never written to config, logs or
the database.

## 4. Scheduling the learning loop

The worker thread inside `serve` runs a persistent job queue. A `session_feed` schedule enqueues the
post-session pipeline; set its cadence in Settings or `sim_session_interval_seconds` (0 = manual).
With a live provider, set it to a few hundred seconds: the pipeline is a no-op until the next
completed session exists. Each pipeline run:

1. ingest and validate the session, version the dataset
2. extend features, detect pattern events, update similarity predictions and model scores
3. paper-trade the session through the Risk Guardian
4. score earlier predictions, compute drift, test champion health
5. re-run the Arena and apply the promotion policy
6. open a research cycle if one is due (`evolve_every_sessions`), if ≥ 3 features have drifted, or if
   the champion was quarantined. When ≥ `min_holdout_days` never-searched sessions exist, a new epoch is
   locked first and the models are retrained.

To keep it running across reboots use `docker compose up -d` (`restart: unless-stopped`) or a
systemd unit that runs the `serve` command. On start-up the worker re-queues interrupted jobs, the
paper engine resumes a half-finished session from its last committed bar, and anything it had to
repair is listed in the recovery log.

## 5. Inspecting research

| Question | Where |
| --- | --- |
| What is it doing now? | Command Center; Darwin Lab → queue |
| Why was a strategy rejected? | Research Skeptic → report (every check with its numbers) |
| What has been tried? | Darwin Lab → cycles, candidates, hypotheses, lessons; `GET /api/export/trials.csv` |
| Is the champion still working? | Learning Monitor → champion health; Alpha Arena → forward |
| Does each engine earn its place? | Research Skeptic → Run ablation study |
| What exactly was known at an event? | Trap Detector → event replay |
| How many times was the holdout used? | Research Skeptic → holdout ledger |

## 6. Operating the paper environment

- **Kill switch** (Command Center): blocks all entries and flattens open paper positions at the next
  bar. Release it from the same place. Both actions are audited.
- **Reconciliation halt**: if internal and broker positions disagree, entries stop until an operator
  clears it (`POST /api/control/clear-halt`).
- **Rollback**: `POST /api/control/rollback` restores the previous champion from its frozen artifact,
  or stops trading if there is none.
- **Operator token**: set `AG_OPERATOR_TOKEN` to require an `X-Operator-Token` header on every control
  endpoint. Without it, anyone who can reach the port can use the controls — keep the default
  loopback binding.
- **Backups**: Settings → Create backup, or `cli backup`. Restore with `cli restore`.

## 7. Paper-trading modes, the Alpaca paper account, and Windows

**Two modes**, chosen by the operator in `config/risk.toml` (`paper_mode`):

| Mode | What trades | Limits |
| --- | --- | --- |
| `validated` (default) | only a promoted champion | full Risk Guardian limits |
| `experimental` | with no champion, the best Skeptic-approved strategy still in its shadow period | reduced: 25% risk per trade, ≤ 5 entries/day, ≤ CAD 50 daily loss |

In both modes nothing trades unless a strategy has passed the Research Skeptic. Orders are never forced.

**Alpaca paper account.** The app talks to `https://paper-api.alpaca.markets` only (the URL is fixed in
code). Provide the paper account's key pair as `APCA_PAPER_KEY_ID` / `APCA_PAPER_SECRET_KEY` (or reuse
`APCA_API_KEY_ID` / `APCA_API_SECRET_KEY`) in `.env`. Then Paper Trading → *Alpaca paper account* shows
account status, positions, recent orders and whether the broker's positions match the internal book.
*Run diagnostic paper order…* asks for confirmation, then sends one buy-1-share limit order at $1.00
(cannot fill), reads it back and cancels it. To mirror the app's approved paper orders to Alpaca on live
sessions, add to `config/alpha.toml`:

```toml
[broker]
mirror = "alpaca_paper"
```

Status: tested against a simulated Alpaca paper API. Not verified against the real one from the build
environment (the host was not reachable there).

**Windows.** Install Python 3.11+ (tick "Add to PATH"), unzip the release, double-click `start.bat`, open
http://127.0.0.1:8000. Put credentials in a `.env` file next to `start.bat` (copy `.env.example`). To keep
it running across logons: `powershell -ExecutionPolicy Bypass -File install-windows-task.ps1`.
These scripts were written for Windows but have not been run on a Windows machine.

**Fees.** `[execution] fee_model = "alpaca"` models commission-free trading plus regulatory fees; the rates
under `[fees.alpaca]` were not checked against a published schedule — confirm them and set
`verified = true`. `fee_model = "legacy"` restores the pre-v3 per-share commission for comparison.

## 8. Before any thought of real money

Not supported, and not a configuration change. It would need, at minimum: real quote data to replace
modelled spreads, months of forward paper results on real data, a verified broker integration with
its own reconciliation tests, and an independent review. The system is built to say "no edge found";
expect that to be the usual answer.
