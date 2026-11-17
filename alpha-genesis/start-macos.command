#!/bin/bash
# ALPHA GENESIS for macOS (Intel and Apple Silicon). Double-click to install on first run and start.
# Paper trading only. Dashboard: http://127.0.0.1:8000
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
PORT="${AG_PORT:-8000}"
URL="http://127.0.0.1:$PORT"
mkdir -p logs
say_() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }

# --- already running? -----------------------------------------------------------------------
if curl -fs "$URL/api/health" >/dev/null 2>&1; then
  say_ "ALPHA GENESIS is already running: $URL"
  open "$URL" 2>/dev/null
  exit 0
fi

# --- Python 3.11+ ----------------------------------------------------------------------------
PY=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  say_ "Python 3.11 or newer is required."
  echo "Install it from https://www.python.org/downloads/macos/ (universal installer, works on Apple Silicon)"
  echo "or with Homebrew:  brew install python@3.12"
  echo "Then double-click start-macos.command again."
  read -r -p "Press Return to close." _
  exit 1
fi

# --- first-run installation ------------------------------------------------------------------
if [ ! -x .venv/bin/python ] || [ ! -f .venv/.installed ]; then
  say_ "First run: installing into $ROOT/.venv (a few minutes)…"
  "$PY" -m venv .venv || { echo "Could not create the virtual environment."; read -r -p "Press Return to close." _; exit 1; }
  . .venv/bin/activate
  python -m pip install --quiet --upgrade pip
  grep -v -i '^lightgbm' requirements.txt > .venv/requirements-core.txt
  pip install --quiet -r .venv/requirements-core.txt || { echo "Dependency installation failed; see the messages above."; read -r -p "Press Return to close." _; exit 1; }
  # LightGBM is optional: it needs the OpenMP runtime (brew install libomp). Without it scikit-learn's gradient boosting is used.
  pip install --quiet lightgbm >/dev/null 2>&1 && python -c 'import lightgbm' >/dev/null 2>&1 || { pip uninstall --quiet -y lightgbm >/dev/null 2>&1; echo "Note: LightGBM not available (optional). Using scikit-learn instead."; }
  pip install --quiet -e backend || { echo "Could not install the application package."; read -r -p "Press Return to close." _; exit 1; }
  touch .venv/.installed
fi

# --- local credentials (git-ignored, readable only by you) -----------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  say_ "Created $ROOT/.env for your Alpaca PAPER keys."
  echo "It is opening in TextEdit. Paste your paper Key ID and Secret after the = signs, save, close,"
  echo "then double-click start-macos.command again. To try the offline demo first, just close it unchanged."
  open -e .env 2>/dev/null
fi
chmod 600 .env 2>/dev/null

# --- start in the background -------------------------------------------------------------------
say_ "Starting ALPHA GENESIS…"
nohup ./scripts/run-service.sh >> logs/alpha-genesis.log 2>&1 &
echo $! > logs/alpha-genesis.pid
echo "Log file: $ROOT/logs/alpha-genesis.log"
echo "The first start with Alpaca keys downloads price history and builds the research state (several minutes)."
for i in $(seq 1 360); do
  if curl -fs "$URL/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$(cat logs/alpha-genesis.pid)" 2>/dev/null; then
    say_ "The service stopped during start-up. Last log lines:"
    tail -n 25 logs/alpha-genesis.log
    read -r -p "Press Return to close." _
    exit 1
  fi
  [ $((i % 6)) -eq 0 ] && echo "  …still starting ($((i * 5))s). $(tail -n 1 logs/alpha-genesis.log | cut -c1-110)"
  sleep 5
done
if curl -fs "$URL/api/health" >/dev/null 2>&1; then
  say_ "ALPHA GENESIS is running: $URL"
  echo "Stop it with stop-macos.command. Keep it running across restarts with install-macos-autostart.command."
  open "$URL" 2>/dev/null
else
  say_ "Still starting after 30 minutes. Check $ROOT/logs/alpha-genesis.log"
fi
