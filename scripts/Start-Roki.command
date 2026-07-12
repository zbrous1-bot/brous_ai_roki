#!/bin/bash

# Serve the app from deploy/ (this script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../deploy" && pwd)"

echo "========================================"
echo " ROKI LAUNCHER"
echo "========================================"
echo ""
echo "Script location: $SCRIPT_DIR"
echo "Serving app from: $APP_DIR"
echo ""
echo "Files in app directory:"
ls -1 "$APP_DIR"
echo ""

# Kill any previous server on port 8000
echo "Stopping any old Roki server..."
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 1

# Start the server on the deploy/ app root
echo "Starting server from: $APP_DIR"
python3 -m http.server 8000 --directory "$APP_DIR" > /dev/null 2>&1 &

sleep 2

# Get local IP
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "COULD-NOT-DETECT")

URL="http://$IP:8000"

echo ""
echo "========================================"
echo " ROKI IS NOW RUNNING"
echo "========================================"
echo ""
echo "On your iPhone, open Safari and go to:"
echo ""
echo "   $URL"
echo ""
echo "If you see a list of files, look for 'index.html' and tap it."
echo ""
echo "Close this window when done to stop the server."
echo "========================================"

# Show dialog with diagnostics
osascript -e "
display dialog \"Roki server is running from:

$APP_DIR

On your iPhone go to:

$URL

If you see a file list instead of the app, tap 'index.html'.

(Phone must be on same Wi-Fi)\" 
buttons {\"OK\"} 
default button \"OK\" 
with title \"Roki\" 
with icon note
"

wait
