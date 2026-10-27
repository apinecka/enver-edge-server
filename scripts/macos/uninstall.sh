#!/bin/sh
# Removes the Enver edge server launchd daemon and its files. Keeps /etc/enver/edge-server.env.
# Usage: sudo /opt/enver/edge-server/uninstall.sh
set -eu

label="com.enver.edge-server"

[ "$(id -u)" -eq 0 ] || { echo "run it with sudo: sudo $0" >&2; exit 1; }

launchctl bootout "system/$label" 2>/dev/null || true
rm -f "/Library/LaunchDaemons/$label.plist"
rm -rf /opt/enver/edge-server
rmdir /opt/enver 2>/dev/null || true

echo "Enver edge server removed. Config left in place: /etc/enver/edge-server.env"
