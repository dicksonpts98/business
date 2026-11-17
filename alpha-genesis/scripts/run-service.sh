#!/bin/bash
# Runs ALPHA GENESIS in the foreground: API + dashboard + research worker + scheduler + live paper loop.
# Used by start-macos.command, start.sh and the launchd / systemd service definitions.
# Credentials are read from the git-ignored .env file next to this project; nothing is hard-coded.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if [ -n "${APCA_API_KEY_ID:-}" ] && [ -n "${APCA_API_SECRET_KEY:-}" ]; then
  # Real mode: Alpaca history + live data, Alpaca PAPER account, daily learning pipeline every 10 minutes.
  export AG_PROVIDER="${AG_PROVIDER:-alpaca}"
  export AG_DATA_DIR="${AG_DATA_DIR:-$ROOT/data/alpaca}"
  export AG_SESSION_INTERVAL="${AG_SESSION_INTERVAL:-600}"
else
  # No credentials yet: offline demonstration on clearly labelled synthetic data.
  export AG_PROVIDER="${AG_PROVIDER:-synthetic}"
  export AG_DATA_DIR="${AG_DATA_DIR:-$ROOT/data/synthetic}"
fi
mkdir -p "$AG_DATA_DIR" "$ROOT/logs"
. "$ROOT/.venv/bin/activate"
cd "$ROOT/backend" || exit 1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] starting ALPHA GENESIS (provider=$AG_PROVIDER, data=$AG_DATA_DIR)"
exec python -u -W ignore -m alpha_genesis.cli serve --host 127.0.0.1 --port "${AG_PORT:-8000}"
