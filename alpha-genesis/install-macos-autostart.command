#!/bin/bash
# Keeps ALPHA GENESIS running on macOS: starts at login and is restarted automatically if it stops (launchd KeepAlive).
# Run start-macos.command once first so the installation exists.
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
if [ ! -f .venv/.installed ]; then echo "Run start-macos.command once first."; read -r -p "Press Return to close." _; exit 1; fi
./stop-macos.command >/dev/null 2>&1
PLIST="$HOME/Library/LaunchAgents/com.alphagenesis.service.plist"
mkdir -p "$HOME/Library/LaunchAgents" logs
cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.alphagenesis.service</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/scripts/run-service.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/alpha-genesis.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/alpha-genesis.log</string>
</dict>
</plist>
PLIST_END
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST" && echo "Installed. ALPHA GENESIS now starts at login and restarts itself if it stops."
echo "Dashboard: http://127.0.0.1:${AG_PORT:-8000}    Log: $ROOT/logs/alpha-genesis.log"
echo "The Mac must be awake for research and paper trading to run (System Settings > Battery/Energy: prevent sleep while plugged in)."
