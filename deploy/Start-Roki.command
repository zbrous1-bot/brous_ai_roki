#!/bin/bash

# Get the absolute path to the directory containing this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "========================================"
echo " ROKI LAUNCHER"
echo "========================================"
echo ""
echo "Script location: $SCRIPT_DIR"
echo "Changing to that directory..."
cd "$SCRIPT_DIR"

echo ""
echo "Current working directory:"
pwd
echo ""
echo "Files in this directory:"
ls -1
echo ""

# Kill any previous server on port 8000
echo "Stopping any old Roki server..."
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
sleep 1

# Start the server, explicitly serving this directory
echo "Starting server from: $SCRIPT_DIR"
python3 -m http.server 8000 --directory "$SCRIPT_DIR" > /dev/null 2>&1 &

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

$SCRIPT_DIR

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
