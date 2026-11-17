#!/usr/bin/env bash
# ALPHA GENESIS - Linux/macOS/WSL startup (paper trading only).
set -euo pipefail
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && . .venv/bin/activate && pip install -q -r requirements.txt && pip install -q -e backend; }
. .venv/bin/activate
[ -f .env ] && set -a && . ./.env && set +a
export AG_DATA_DIR="${AG_DATA_DIR:-$PWD/data}"
echo "Open http://127.0.0.1:8000  (Ctrl+C to stop)"
cd backend && exec python -W ignore -m alpha_genesis.cli serve --host 127.0.0.1 --port 8000
