#!/usr/bin/env python3
"""
TrusToken local presence helper.

Run this on each participant's own computer. A browser cannot see USB devices,
so the meeting page asks this helper whether a C-DAC TrusToken is plugged in.

It only reports whether a device with the TrusToken USB ID is on the USB bus.
That proves presence of a matching device, not identity: it does not talk to
the token's chip, ask for a PIN, or sign anything. Linux only (reads sysfs).
"""

import argparse
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

TOKEN_VENDOR_ID = "288d"
TOKEN_PRODUCT_ID = "0040"
DEFAULT_PORT = 8765
DEFAULT_SYSFS_ROOT = "/sys/bus/usb/devices"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost"}

# Hosts the meeting page is normally served from: this machine, a campus/LAN or
# Tailscale address, or a Cloudflare quick tunnel. Add others with --allow-origin.
ALLOWED_ORIGIN_HOST = re.compile(
    r"^(localhost|127\.0\.0\.1"
    r"|10\.\d+\.\d+\.\d+"
    r"|192\.168\.\d+\.\d+"
    r"|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+"
    r"|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+"
    r"|[a-z0-9-]+\.trycloudflare\.com)$"
)


def read_id(device_dir, name):
    try:
        with open(os.path.join(device_dir, name), encoding="ascii") as f:
            return f.read().strip().lower()
    except OSError:
        return None


def token_present(sysfs_root):
    try:
        entries = os.listdir(sysfs_root)
    except OSError:
        return False
    for entry in entries:
        device_dir = os.path.join(sysfs_root, entry)
        if (read_id(device_dir, "idVendor") == TOKEN_VENDOR_ID
                and read_id(device_dir, "idProduct") == TOKEN_PRODUCT_ID):
            return True
    return False


def origin_allowed(origin, extra_origins):
    if origin in extra_origins:
        return True
    parts = urlsplit(origin)
    return parts.scheme in ("http", "https") and bool(
        ALLOWED_ORIGIN_HOST.match(parts.hostname or "")
    )


def make_handler(sysfs_root, extra_origins):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, body=None):
            data = json.dumps(body).encode() if body is not None else b""
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin and origin_allowed(origin, extra_origins):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                # Lets a page on a public tunnel reach this loopback address.
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _request_allowed(self):
            # The Host check blocks DNS rebinding; the Origin check limits which
            # sites may read the answer. Requests without Origin (curl) are fine.
            host = urlsplit("//" + self.headers.get("Host", "")).hostname
            origin = self.headers.get("Origin")
            return host in LOOPBACK_HOSTS and (
                not origin or origin_allowed(origin, extra_origins)
            )

        def do_OPTIONS(self):
            self._send(204 if self._request_allowed() else 403)

        def do_GET(self):
            if not self._request_allowed():
                self._send(403, {"error": "origin not allowed"})
            elif urlsplit(self.path).path != "/status":
                self._send(404, {"error": "not found"})
            else:
                self._send(200, {"present": token_present(sysfs_root)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--sysfs-root", default=DEFAULT_SYSFS_ROOT,
                        help="USB device directory (override for tests)")
    parser.add_argument("--allow-origin", action="append", default=[], metavar="ORIGIN",
                        help="extra meeting page origin, e.g. https://meet.example.org")
    args = parser.parse_args()

    if not os.path.isdir(args.sysfs_root):
        sys.exit(f"Cannot read USB devices from {args.sysfs_root}. This helper supports Linux only.")

    server = ThreadingHTTPServer(
        ("127.0.0.1", args.port),
        make_handler(args.sysfs_root, set(args.allow_origin)),
    )
    state = "plugged in" if token_present(args.sysfs_root) else "NOT plugged in"
    print(f"TrusToken helper running on http://127.0.0.1:{args.port} (token {state}). "
          "Keep this open during the meeting.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
