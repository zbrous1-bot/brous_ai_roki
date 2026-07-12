#!/bin/bash

echo "Stopping Roki background service..."

launchctl unload ~/Library/LaunchAgents/com.user.roki.plist 2>/dev/null

echo "Roki background service stopped."

osascript -e "
display dialog \"Roki background service has been stopped.\" 
buttons {\"OK\"} 
default button \"OK\" 
with title \"Roki\" 
with icon note
"