#!/usr/bin/env bash
# Builds the macOS bundle: a universal (Apple Silicon + Intel) .tar.gz containing the compiled app,
# production node_modules, both darwin Node.js runtimes and an install.sh that registers it as a
# launchd daemon (com.enver.edge-server). Cross-built on Linux - no macOS tooling needed.
# Usage: package-macos.sh [--skip-build]
#
# Why a tarball and not a .pkg: building a .pkg needs macOS-only tooling, and an unsigned .pkg
# opened from a browser download is blocked by Gatekeeper anyway. The official Node.js binaries
# bundled here are already signed and notarized by the Node.js project, and install.sh strips the
# quarantine attribute from the install dir, so a browser-downloaded bundle runs too.
#
# node_modules is installed with --os=darwin --ignore-scripts: every native addon in the
# dependency tree (ssh2's sshcrypto, cpu-features - optional deps of dockerode's SSH transport,
# which the agent never uses) has a pure-JS fallback, so the bundle holds no Linux binaries.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

version="$(edge_server_version)"
[ "${1:-}" = "--skip-build" ] || build "$version"

bundle_name="enver-edge-server"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
stage="$work_dir/$bundle_name"
mkdir -p "$stage/app"

log "Staging the app (macOS)"
stage_app "$stage/app" "$version"

log "Installing production darwin dependencies (npm ci --omit=dev --os=darwin --ignore-scripts)"
npm ci --omit=dev --os=darwin --ignore-scripts --prefix "$stage/app" --silent

native_addons="$(find "$stage/app/node_modules" -name '*.node' -type f)"
[ -z "$native_addons" ] || die "unexpected native addons in the macOS bundle (built for the wrong OS):
$native_addons"

for arch in arm64 x64; do
	log "Bundling Node.js v$NODE_VERSION (darwin-$arch)"
	ensure_node_dist "darwin-$arch"
	mkdir -p "$stage/node/darwin-$arch/bin"
	cp "$NODE_BIN" "$stage/node/darwin-$arch/bin/node"
done

cp "$SCRIPT_DIR/macos/install.sh" "$SCRIPT_DIR/macos/uninstall.sh" "$stage/"
sed "s|@ENTRYPOINT@|$SERVICE_ENTRYPOINT|" "$SCRIPT_DIR/macos/com.enver.edge-server.plist" >"$stage/com.enver.edge-server.plist"
chmod 755 "$stage/install.sh" "$stage/uninstall.sh"
echo "$version" >"$stage/VERSION"

mkdir -p "$DIST_DIR"
tar_path="$DIST_DIR/${bundle_name}_${version}_macos.tar.gz"
tar -czf "$tar_path" --owner=0 --group=0 -C "$work_dir" "$bundle_name"
log "Package ready: $tar_path"
