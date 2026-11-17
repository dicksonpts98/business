#!/usr/bin/env bash
# ALPHA GENESIS - Linux / WSL startup (paper trading only). macOS: use start-macos.command.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .venv/.installed ] || { python3 -m venv .venv && . .venv/bin/activate && pip install -q -r requirements.txt && pip install -q -e backend && touch .venv/.installed; }
echo "Dashboard: http://127.0.0.1:${AG_PORT:-8000}  (Ctrl+C to stop)"
exec ./scripts/run-service.sh
