#!/usr/bin/env bash
# Builds the Linux .deb: the agent with its own Node.js runtime under /opt/enver/edge-server and a
# systemd unit (enver-edge-server.service) that gets enabled and (re)started on install. The
# package is for the build machine's architecture (amd64/arm64).
# Usage: package-deb.sh [--skip-build]
#
# Config is not part of the package: the unit reads /etc/enver/edge-server.env, which holds the
# agent's token (see apps/edge-server/README.md).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

version="$(edge_server_version)"
[ "${1:-}" = "--skip-build" ] || build "$version"
ensure_node_runtime

pkg_name="enver-edge-server"
install_dir="opt/enver/edge-server"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
stage="$work_dir/$pkg_name"
mkdir -p "$stage/$install_dir" "$stage/DEBIAN" "$stage/etc/systemd/system"

log "Staging the app"
stage_app "$stage/$install_dir" "$version"

log "Installing production dependencies (npm ci --omit=dev)"
npm ci --omit=dev --ignore-scripts --prefix "$stage/$install_dir" --silent

log "Bundling Node.js v$NODE_VERSION ($DEB_ARCH)"
mkdir -p "$stage/$install_dir/node/bin"
cp "$NODE_BIN" "$stage/$install_dir/node/bin/node"

cat >"$stage/DEBIAN/control" <<EOF
Package: $pkg_name
Version: $version
Section: admin
Priority: optional
Architecture: $DEB_ARCH
Maintainer: Enver <tomcupak@gmail.com>
Homepage: https://enver.apinecka.com/about/
Description: Enver edge server agent, installed as a systemd service ($SERVICE_NAME.service).
 Runs the containers Enver deploys on this machine through Docker or Kubernetes.
 Bundles its own Node.js v$NODE_VERSION runtime - no system nodejs required.
EOF

# Root owns the agent, so the agent's user can't replace its launcher; it may write only versions/,
# where self-updates go. Installing a package means running that package: old versions are dropped.
# The env file holds the token: systemd reads it as root (EnvironmentFile), nobody else may.
# The agent drives the local Docker daemon over /var/run/docker.sock, hence the docker group.
# Services' env files live in /etc/enver/env-files: root writes them, the agent only reads.
# /opt/enver/volumes and /opt/enver/backups are the directories Enver suggests; they apply only once
# they are set in the edge server's settings.
cat >"$stage/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e
id -u $SERVICE_USER >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin $SERVICE_USER
install -d -m 755 /etc/enver
[ -f /etc/enver/edge-server.env ] || printf 'EDGE_SERVER_TOKEN=\\n' >/etc/enver/edge-server.env
chown root:root /etc/enver/edge-server.env
chmod 600 /etc/enver/edge-server.env
rm -rf /$install_dir/versions
chown -R root:root /$install_dir
chmod -R go-w /$install_dir
install -d -m 755 -o $SERVICE_USER -g $SERVICE_USER /$install_dir/versions
getent group docker >/dev/null 2>&1 && usermod -aG docker $SERVICE_USER || true
[ -d /etc/enver/env-files ] || install -d -m 750 -o root -g $SERVICE_USER /etc/enver/env-files
[ -d /opt/enver/volumes ] || install -d -m 755 /opt/enver/volumes
[ -d /opt/enver/backups ] || install -d -m 750 -o $SERVICE_USER -g $SERVICE_USER /opt/enver/backups
systemctl daemon-reload
systemctl enable $SERVICE_NAME.service
systemctl restart $SERVICE_NAME.service
EOF
chmod 755 "$stage/DEBIAN/postinst"

cat >"$stage/DEBIAN/postrm" <<EOF
#!/bin/sh
set -e
if [ "\$1" = remove ] || [ "\$1" = purge ]; then
	systemctl stop $SERVICE_NAME.service 2>/dev/null || true
	systemctl disable $SERVICE_NAME.service 2>/dev/null || true
	systemctl daemon-reload || true
	rm -rf /$install_dir/versions
fi
EOF
chmod 755 "$stage/DEBIAN/postrm"

cat >"$stage/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Enver edge server
After=network.target

[Service]
Type=simple
WorkingDirectory=/$install_dir
ExecStart=/$install_dir/node/bin/node /$install_dir/$SERVICE_ENTRYPOINT
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=-/etc/enver/edge-server.env
User=$SERVICE_USER
# /usr, /boot and /etc stay read-only and /home hidden; the agent writes only versions/ (self-update),
# its backups directory and a key log, whose location the operator picks.
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

[Install]
WantedBy=multi-user.target
EOF

mkdir -p "$DIST_DIR"
deb_path="$DIST_DIR/${pkg_name}_${version}_${DEB_ARCH}.deb"
dpkg-deb --build --root-owner-group "$stage" "$deb_path"
log "Package ready: $deb_path"
