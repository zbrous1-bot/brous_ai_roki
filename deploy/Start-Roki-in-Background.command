#!/bin/bash

echo "Starting Roki as a background service (no terminal window needed)..."

# Load the launch agent
launchctl load ~/Library/LaunchAgents/com.user.roki.plist 2>/dev/null || launchctl unload ~/Library/LaunchAgents/com.user.roki.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.user.roki.plist

sleep 1

# Get IP
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "IP-NOT-FOUND")

echo ""
echo "========================================"
echo " ROKI IS NOW RUNNING IN THE BACKGROUND"
echo "========================================"
echo ""
echo "On your iPhone, open Safari and go to:"
echo ""
echo "   http://$IP:8000"
echo ""
echo "The server will keep running even after you close this window."
echo ""
echo "To stop it later, double-click Stop-Roki-Background.command"
echo "========================================"

osascript -e "
display dialog \"Roki is now running in the background (no terminal needed).

On your iPhone go to:

http://$IP:8000

You can close this window.\" 
buttons {\"OK\"} 
default button \"OK\" 
with title \"Roki\" 
with icon note
"