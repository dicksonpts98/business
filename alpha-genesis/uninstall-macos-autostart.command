#!/bin/bash
# Removes the macOS auto-start service. The application and its data are left untouched.
PLIST="$HOME/Library/LaunchAgents/com.alphagenesis.service.plist"
launchctl unload "$PLIST" 2>/dev/null
[ -f "$PLIST" ] && mv "$PLIST" "$PLIST.removed" && echo "Auto-start removed (definition kept as $PLIST.removed)."
echo "Done."
