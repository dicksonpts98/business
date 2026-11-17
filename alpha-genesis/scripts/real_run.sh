#!/usr/bin/env bash
# Real-data research on Alpaca history. Credentials must already be available (environment variables or a
# secrets proxy); this script never reads or prints them.
#   ./scripts/real_run.sh init|cycle|advance N|ablation|status|serve ...
# The last AG_REPLAY_RESERVE_DAYS real sessions are held back and replayed one at a time (sequential test).
set -euo pipefail
cd "$(dirname "$0")/../backend"
export AG_DATA_DIR="${AG_DATA_DIR:-../data_alpaca}" AG_PROVIDER=alpaca AG_HISTORY_START="${AG_HISTORY_START:-2023-01-03}" AG_REPLAY_RESERVE_DAYS="${AG_REPLAY_RESERVE_DAYS:-120}"
exec python -u -W ignore -m alpha_genesis.cli "$@"
