#!/usr/bin/env bash
# TrusMeet Public Mobile Tunnel Launcher
# Exposes the local TrusMeet conference server to mobile networks & remote lab members.

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
CLOUDFLARED="$HOME/.local/bin/cloudflared"
URL_FILE="$DIR/current-tunnel-url.txt"
LOG_FILE="$DIR/tunnel.log"

echo "=================================================================="
echo "🛡️  TrusMeet Public Mobile Tunnel Manager"
echo "=================================================================="

# Check if already running
RUNNING_PID=$(pgrep -f "cloudflared tunnel --url" || true)

if [ -n "$RUNNING_PID" ]; then
    echo "⚠️  An active tunnel process (PID: $RUNNING_PID) is already running!"
    if [ -f "$URL_FILE" ]; then
        EXISTING_URL=$(cat "$URL_FILE")
        echo "🔗 Your current active public URL is:"
        echo "👉 $EXISTING_URL"
        echo ""
    fi
    read -p "Do you want to stop the existing tunnel and restart a new one? (y/N): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Stopping existing tunnel (PID: $RUNNING_PID)..."
        kill -9 $RUNNING_PID 2>/dev/null || true
        sleep 2
    else
        echo "Keeping existing tunnel running."
        exit 0
    fi
fi

# Ensure cloudflared is installed
if [ ! -f "$CLOUDFLARED" ]; then
    echo "Downloading cloudflared binary..."
    mkdir -p "$HOME/.local/bin"
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CLOUDFLARED"
    chmod +x "$CLOUDFLARED"
fi

echo "Connecting to Cloudflare network for port 8080..."
rm -f "$LOG_FILE"

# Start in background to capture output URL
"$CLOUDFLARED" tunnel --url http://localhost:8080 > "$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "Waiting for public HTTPS link to be assigned..."
FOUND_URL=""
for i in {1..20}; do
    if grep -q "trycloudflare.com" "$LOG_FILE" 2>/dev/null; then
        FOUND_URL=$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' "$LOG_FILE" | grep -v 'api\.trycloudflare\.com' | head -n 1)
        if [ -n "$FOUND_URL" ]; then
            break
        fi
    fi
    # Check if process died
    if ! kill -0 $NEW_PID 2>/dev/null; then
        echo "❌ Tunnel process exited with error:"
        cat "$LOG_FILE"
        exit 1
    fi
    sleep 1
done

if [ -n "$FOUND_URL" ]; then
    echo "$FOUND_URL" > "$URL_FILE"
    echo "$NEW_PID" > "$DIR/tunnel.pid"
    echo "=================================================================="
    echo "✅ Public Tunnel is LIVE!"
    echo "🔗 Share this link with lab members on mobile / cellular data:"
    echo "👉 $FOUND_URL/?room=LAB-DECIPHERED-SYNC"
    echo "=================================================================="
    
    if [[ "$1" == "--daemon" || "$1" == "-d" ]]; then
        echo "🚀 Tunnel running as persistent background daemon (PID: $NEW_PID)."
        echo "To stop later: pkill -f cloudflared"
        exit 0
    else
        echo "Keep this terminal open to keep the tunnel active, or press Ctrl+C to stop."
        wait $NEW_PID
    fi
else
    echo "❌ Timed out waiting for public URL. Check $LOG_FILE for details."
    kill -9 $NEW_PID 2>/dev/null || true
    exit 1
fi
