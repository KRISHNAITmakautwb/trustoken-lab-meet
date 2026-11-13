#!/usr/bin/env bash
# Runs a TURN relay on this computer for meetings whose browsers can't reach
# each other directly (campus Wi-Fi blocking traffic between devices).
# It relays only to this computer's own addresses, so it can't be used to reach
# other machines on the network. Passwords are made per login by server.js.
#
# Usage: ./start-turn.sh            (then restart server.js once, so it picks up the relay)
# Port:  TURN_PORT=3479 by default (UDP and TCP). Relay ports 50000-50999 (UDP).
set -euo pipefail

cd "$(dirname "$0")"
DATA_DIR="${TRUSTOKEN_DATA_DIR:-$PWD/data}"
PORT="${TURN_PORT:-3479}"
mkdir -p "$DATA_DIR"
umask 077

command -v turnserver >/dev/null || { echo "coturn is not installed: sudo apt install -y coturn" >&2; exit 1; }

LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[ -n "$LAN_IP" ] || { echo "Could not find this computer's network address." >&2; exit 1; }
TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"

SECRET_FILE="$DATA_DIR/turn-secret"
[ -s "$SECRET_FILE" ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE"
SECRET="$(cat "$SECRET_FILE")"

URLS="\"turn:$LAN_IP:$PORT?transport=udp\", \"turn:$LAN_IP:$PORT?transport=tcp\""
[ -n "$TS_IP" ] && URLS="$URLS, \"turn:$TS_IP:$PORT?transport=udp\", \"turn:$TS_IP:$PORT?transport=tcp\""
printf '{ "urls": [%s], "secret": "%s" }\n' "$URLS" "$SECRET" > "$DATA_DIR/turn.json"

CONF="$DATA_DIR/turnserver.conf"
{
  echo "listening-port=$PORT"
  echo "listening-ip=$LAN_IP"
  [ -n "$TS_IP" ] && echo "listening-ip=$TS_IP"
  echo "relay-ip=$LAN_IP"
  echo "min-port=50000"
  echo "max-port=50999"
  echo "realm=trusmeet"
  echo "use-auth-secret"
  echo "static-auth-secret=$SECRET"
  echo "fingerprint"
  echo "no-tls"
  echo "no-dtls"
  echo "no-cli"
  echo "no-multicast-peers"
  echo "total-quota=100"
  echo "user-quota=12"
  echo "denied-peer-ip=0.0.0.0-255.255.255.255"
  echo "denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
  echo "allowed-peer-ip=$LAN_IP"
  [ -n "$TS_IP" ] && echo "allowed-peer-ip=$TS_IP"
  echo "userdb=$DATA_DIR/turndb"
  echo "pidfile=$DATA_DIR/turnserver.pid"
  echo "log-file=stdout"
  echo "simple-log"
} > "$CONF"

echo "TURN relay on $LAN_IP${TS_IP:+ and $TS_IP}, port $PORT (Ctrl+C to stop)."
echo "If server.js was already running, restart it once so it uses the relay."
exec turnserver -c "$CONF"
