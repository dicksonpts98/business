#!/bin/bash
# Stops ALPHA GENESIS on macOS. State is kept on disk; the next start resumes where it stopped.
cd "$(dirname "$0")" || exit 1
PLIST="$HOME/Library/LaunchAgents/com.alphagenesis.service.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null && echo "Auto-start service unloaded (it will load again at next login; remove it with uninstall-macos-autostart.command)."
fi
if [ -f logs/alpha-genesis.pid ]; then
  PID="$(cat logs/alpha-genesis.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null
    for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
  fi
  rm -f logs/alpha-genesis.pid
fi
pkill -f "alpha_genesis.cli serve" 2>/dev/null
echo "ALPHA GENESIS stopped."
echo "Note: stopping the app does not close open experimental paper positions at Alpaca."
echo "Turn the experimental switch off and use 'Close all experimental positions' first if any are open."
