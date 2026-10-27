#!/usr/bin/env bash
# Shared config/helpers for the packaging scripts. Sourced, not executed directly.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Packages bundle this exact Node.js runtime, so target machines need no system nodejs.
NODE_VERSION="$(tr -d 'v[:space:]' <"$REPO_ROOT/.nvmrc")"
CACHE_DIR="${ENVER_CACHE_DIR:-$REPO_ROOT/.cache}"
DIST_DIR="$REPO_ROOT/dist-deploy"

APP_DIR="dist/apps/edge-server"
# The service manager runs the launcher, which runs main.js of the current version - the installed
# one or a self-updated one under versions/ (apps/edge-server/src/launcher).
SERVICE_ENTRYPOINT="$APP_DIR/launcher.js"
SERVICE_NAME="enver-edge-server"
SERVICE_USER="enver-edge-server"
# Pins the key every self-update must be signed with (apps/edge-server/src/self-update).
SIGNING_KEY_FILE="enver-signing-key.gpg"

log() { echo "[edge-server] $*" >&2; }

die() {
	echo "[edge-server] error: $*" >&2
	exit 1
}

# The release version the agent's self-update compares (semver). ENVER_EDGE_SERVER_VERSION overrides
# the VERSION file; without either the build is "dev", which never self-updates.
edge_server_version() {
	if [ -n "${ENVER_EDGE_SERVER_VERSION:-}" ]; then
		echo "$ENVER_EDGE_SERVER_VERSION"
	elif [ -f "$REPO_ROOT/VERSION" ]; then
		tr -d '[:space:]' <"$REPO_ROOT/VERSION"
	else
		echo dev
	fi
}

# Downloads (once, cached under $CACHE_DIR/node-runtime) the official Node.js release for
# <platform>-<arch> (e.g. linux-x64, darwin-arm64), checked against the release's SHASUMS256.txt,
# and sets NODE_BIN to its `node` binary.
ensure_node_dist() {
	local target="$1"
	local dist="node-v$NODE_VERSION-$target"
	local cache_dir="$CACHE_DIR/node-runtime"
	NODE_BIN="$cache_dir/$dist/bin/node"
	[ -f "$NODE_BIN" ] && return 0

	log "Downloading Node.js v$NODE_VERSION ($target)"
	mkdir -p "$cache_dir"
	local base="https://nodejs.org/dist/v$NODE_VERSION" tmp expected actual
	tmp="$(mktemp -d)"
	curl -fsSL "$base/$dist.tar.gz" -o "$tmp/$dist.tar.gz"
	expected="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$dist.tar.gz" '$2 == f { print $1 }')"
	actual="$(sha256sum "$tmp/$dist.tar.gz" | awk '{ print $1 }')"
	[ -n "$expected" ] && [ "$expected" = "$actual" ] || die "SHA-256 of $dist.tar.gz does not match SHASUMS256.txt"
	tar -xzf "$tmp/$dist.tar.gz" -C "$cache_dir"
	rm -rf "$tmp"
}

# Sets DEB_ARCH and NODE_BIN for the build machine's architecture: the .deb bundles that runtime.
ensure_node_runtime() {
	case "$(uname -m)" in
	x86_64) DEB_ARCH="amd64"; ensure_node_dist linux-x64 ;;
	aarch64 | arm64) DEB_ARCH="arm64"; ensure_node_dist linux-arm64 ;;
	*) die "unsupported build architecture: $(uname -m)" ;;
	esac
}

build() {
	local version="$1"
	log "Building edge-server $version"
	(cd "$REPO_ROOT" && ENVER_BUILD_VERSION="$version" npx nest build edge-server)
}

# Copies what an install needs into $1: the bundle, package.json/package-lock.json for the
# production node_modules, VERSION, and the pinned signing key when the repo has one.
stage_app() {
	local dest="$1" version="$2"
	mkdir -p "$dest/$(dirname "$APP_DIR")"
	cp -r "$REPO_ROOT/$APP_DIR" "$dest/$APP_DIR"
	cp "$REPO_ROOT/package.json" "$REPO_ROOT/package-lock.json" "$dest/"
	echo "$version" >"$dest/VERSION"
	if [ -f "$REPO_ROOT/$SIGNING_KEY_FILE" ]; then
		cp "$REPO_ROOT/$SIGNING_KEY_FILE" "$dest/$SIGNING_KEY_FILE"
	else
		log "warning: no $SIGNING_KEY_FILE - this package won't require signed self-updates"
	fi
}
