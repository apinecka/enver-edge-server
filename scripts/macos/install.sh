#!/bin/sh
# Installs (or upgrades) the Enver edge server on macOS as a launchd daemon.
# Usage: sudo ./install.sh
#
# The daemon runs as the user who invoked sudo (override with ENVER_EDGE_SERVER_USER) rather
# than root: Docker Desktop / OrbStack / Colima sockets belong to that user, so this is what
# gives the edge server Docker access - the macOS counterpart of the .deb's docker group.
set -eu

label="com.enver.edge-server"
install_dir="/opt/enver/edge-server"
plist_path="/Library/LaunchDaemons/$label.plist"
env_file="/etc/enver/edge-server.env"
log_file="/var/log/enver-edge-server.log"

die() {
	echo "enver-edge-server: $*" >&2
	exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS - use the .deb package on Linux"
[ "$(id -u)" -eq 0 ] || die "run it with sudo: sudo $0"

case "$(uname -m)" in
arm64) arch="darwin-arm64" ;;
x86_64) arch="darwin-x64" ;;
*) die "unsupported architecture: $(uname -m)" ;;
esac

run_user="${ENVER_EDGE_SERVER_USER:-${SUDO_USER:-}}"
[ -n "$run_user" ] && [ "$run_user" != "root" ] ||
	die "run it via sudo from the account that runs Docker (or set ENVER_EDGE_SERVER_USER=<user>)"
id -u "$run_user" >/dev/null 2>&1 || die "user '$run_user' does not exist"

src_dir="$(cd "$(dirname "$0")" && pwd)"

launchctl bootout "system/$label" 2>/dev/null || true

rm -rf "$install_dir"
mkdir -p "$install_dir/node/bin"
cp -R "$src_dir/app/." "$install_dir/"
cp "$src_dir/node/$arch/bin/node" "$install_dir/node/bin/node"
cp "$src_dir/uninstall.sh" "$install_dir/uninstall.sh"
chown -R root:wheel "$install_dir"
chmod -R go-w "$install_dir"
xattr -dr com.apple.quarantine "$install_dir" 2>/dev/null || true

# The only place the agent may write: its self-update keeps new versions and their state here, so
# updating never needs root (the launcher in the root-owned install dir runs the current one).
mkdir -p "$install_dir/versions"
chown "$run_user" "$install_dir/versions"
chmod 755 "$install_dir/versions"

# The daemon (running as $run_user) reads the env file itself via node's --env-file, unlike
# systemd's EnvironmentFile which reads it as root - so the file must belong to $run_user.
mkdir -p /etc/enver
[ -f "$env_file" ] || printf 'EDGE_SERVER_TOKEN=\n' >"$env_file"
chown "$run_user" "$env_file"
chmod 600 "$env_file"

# Services' env files: root writes them, the agent only reads (see the guide, "Env file on the server").
if [ ! -d /etc/enver/env-files ]; then
	mkdir -p /etc/enver/env-files
	chown root:"$(id -gn "$run_user")" /etc/enver/env-files
	chmod 750 /etc/enver/env-files
fi

# The directories Enver suggests for volumes and backups; they apply only once they are set in the
# edge server's settings. Docker Desktop shares only some host paths: add /opt/enver there.
mkdir -p /opt/enver/volumes
if [ ! -d /opt/enver/backups ]; then
	mkdir -p /opt/enver/backups
	chown "$run_user" /opt/enver/backups
	chmod 750 /opt/enver/backups
fi

touch "$log_file"
chown "$run_user" "$log_file"

sed "s|@RUN_USER@|$run_user|" "$src_dir/$label.plist" >"$plist_path"
chown root:wheel "$plist_path"
chmod 644 "$plist_path"
launchctl bootstrap system "$plist_path"

echo "Enver edge server $(cat "$src_dir/VERSION" 2>/dev/null || echo '') installed ($arch), running as '$run_user'."
echo "  config:    $env_file"
echo "  logs:      tail -f $log_file"
echo "  restart:   sudo launchctl kickstart -k system/$label"
echo "  uninstall: sudo $install_dir/uninstall.sh"

user_home="$(dscl . -read "/Users/$run_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
if [ ! -S /var/run/docker.sock ]; then
	for sock in "$user_home/.docker/run/docker.sock" "$user_home/.orbstack/run/docker.sock" "$user_home/.colima/default/docker.sock"; do
		if [ -S "$sock" ]; then
			echo
			echo "Note: /var/run/docker.sock does not exist, but $sock does."
			echo "Set it as the Docker socket path on the edge server's detail page in Enver,"
			echo "or add DOCKER_SOCKET_PATH=$sock to $env_file."
			break
		fi
	done
fi
