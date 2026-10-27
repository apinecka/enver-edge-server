# Edge Server

A lightweight NestJS agent that runs on bare-metal or VM hardware and executes container workloads on behalf of the Enver API. It connects to the API over WebSocket, receives deployment jobs, and drives Docker or Kubernetes locally.

---

## How it works

```
Enver hub ◀──(HTTPS: where is my instance?)── Edge Server
Enver instance ◀──(HTTPS + WebSocket)──▶ Edge Server ──▶ Docker / Kubernetes
                                              │
                                              └── /health (HTTP, local)
```

1. On startup the service authenticates with the API using its `EDGE_SERVER_TOKEN` and downloads its settings from `GET /v1/edge-servers/settings` — this includes the Docker socket path and Kubernetes connection details configured in the Enver UI, so no local config file is needed beyond the token.
2. It opens a persistent WebSocket to `/edge-servers/websocket` on the API.
3. The instance pushes `EdgeServerJob` messages (`libs/edge-protocol`) over the socket; the agent acknowledges each one.
4. The service routes each job to the appropriate backend — **Dockerode** (`deploymentType: docker`) or **@kubernetes/client-node** (`deploymentType: kubernetes`).
5. It reconnects automatically every 5 seconds if the connection drops, and re-checks settings every 60 seconds so changes made in the UI (Docker socket, Kubernetes connection, ingress class, cert issuer) take effect without a restart. This check is conditional (`ETag`/`If-None-Match`) - the API responds `304 Not Modified` with no body until something actually changes, so the recurring poll is cheap.
6. `GET /health` returns `{ status: 'ok' }` for external health-checks.
7. It updates itself: the service runs `launcher.js`, which runs the current version (the installed one or a newer one the agent downloaded into `versions/<v>/`) and rolls back a new version that doesn't come up.

---

## Docker / Kubernetes control

Both client libraries are already declared as monorepo dependencies and domain-level service wrappers exist at `libs/domains/src/docker/` and `libs/domains/src/kubernetes/`.

### Docker (`dockerode`)

`DockerModule` / `DockerService` communicate with the Docker daemon over a Unix socket — `/var/run/docker.sock` by default, overridable per edge server in the Enver UI ("Docker & Kubernetes settings" on the edge server's detail page).

The socket path must be readable by the OS user that runs the service. The `.deb` package's postinst does this automatically for its `enver-edge-server` system user; to grant it manually (e.g. outside the package):

```bash
sudo usermod -aG docker enver-edge-server
```

### Kubernetes (`@kubernetes/client-node`)

`KubernetesModule` / `KubernetesService` reach the cluster's API server directly using the URL and ServiceAccount bearer token configured in the Enver UI — the edge server downloads these at startup and re-downloads them every 60 seconds, so no kubeconfig file needs to be placed on the host. See the "Kubernetes cluster setup" copyable snippet on the edge server's detail page for the `kubectl` commands that create a ServiceAccount with the right permissions and print its token. What it creates in the cluster (one namespace per environment, Pod Security, NetworkPolicies, Deployments, Services, Ingresses, claims) is in `libs/domains/src/kubernetes/kubernetes.service.ts`.

For local development or air-gapped installs, a local kubeconfig file or in-cluster credentials can be used instead — see `KUBECONFIG_PATH` below.

---

## Configuration

The service reads configuration from an env-style file at:

```
/etc/enver/edge-server.env
```

The file uses standard `KEY=VALUE` syntax — no `export`, no quotes required for simple values.

### Full reference

```ini
# /etc/enver/edge-server.env

# ── Required ──────────────────────────────────────────────────
# Authentication token issued by Enver for this edge server: <edgeServerGuid>.<secret>.
EDGE_SERVER_TOKEN=<token>

# ── Optional ──────────────────────────────────────────────────
# URL of the Enver hub (default: https://hub.enver.apinecka.com). On every start
# the agent asks it for the instance its account lives on and connects there
# (HTTPS + WebSocket); the answer is kept in memory only. An URL of an instance
# (agents installed before the hub) is used directly.
API_URL=https://hub.example.com

# Port the local HTTP server listens on (default: 80).
EDGE_SERVER_PORT=80

# Directory the services' env files are read from (default: /etc/enver/env-files).
# A service set to an env file gets its values from <dir>/<file> on this host,
# so they never pass through Enver; nothing outside this directory is readable.
# ENV_FILES_DIR=/etc/enver/env-files

# Writes the agent's TLS session keys (NSS key log format) to this file, so
# Wireshark can decrypt its traffic to Enver. Only for an inspection: whoever
# reads the file can decrypt the captured traffic. Applies through the launcher.
# SSLKEYLOGFILE=/var/lib/enver-keys/edge-server.keys

# Host address Docker publishes the services' ports on (e.g. a private
# interface's). Unset: all interfaces, which bypasses a host firewall like ufw.
# DOCKER_PORTS_HOST_IP=10.0.0.5

# ── Dev/air-gapped overrides ───────────────────────────────────
# Everything below is normally configured in the Enver UI (edge server
# detail page) and downloaded automatically. Set these only to override
# that for local development or an air-gapped install.
# DOCKER_SOCKET_PATH=/var/run/docker.sock
# KUBECONFIG_PATH=/etc/enver/kubeconfig
```

The systemd unit passes this file via `EnvironmentFile=`, so systemd (as root) reads it before the process starts. It holds the token, so the package creates it as `root:root` with mode `0600` and resets those on every install. On macOS the agent reads it itself, so it belongs to the user the daemon runs as, also `0600`.

`API_URL` and the instance the hub names must be `https://`; plain `http://` is accepted only for `localhost` (development).

---

## Building & packaging

The app bundles with Webpack via the NestJS CLI (`apps/edge-server/webpack.config.mjs` produces `main.js` and `launcher.js`, unminified). The packaging scripts in `scripts/` bundle the official Node.js runtime (checked against its published SHA-256), so the target machine needs no Node.js:

```bash
npm ci
npm run build          # dist/apps/edge-server/

npm run package:deb    # dist-deploy/enver-edge-server_<version>_<amd64|arm64>.deb (architecture of the build machine)
npm run package:macos  # dist-deploy/enver-edge-server_<version>_macos.tar.gz (universal, cross-built on Linux)
```

The version comes from the `VERSION` file. Releases are built by `.github/workflows/release.yml` from the tagged commit, with a build provenance attestation; the root `README.md` shows how to check a downloaded package against it.

Installing the package:

- installs the app to `/opt/enver/edge-server/`, owned by root; the agent's user may write only `versions/`, where it updates itself (removed again by every package install), so it can't replace its own launcher
- creates `/etc/enver/edge-server.env` (`0600`, root) and the suggested `/opt/enver/volumes` and `/opt/enver/backups` (see Host directories)
- creates a system user `enver-edge-server` and adds it to the `docker` group (so the Docker socket is usable out of the box)
- registers and starts a systemd service `enver-edge-server.service`, sandboxed with `NoNewPrivileges`, `ProtectSystem=full` (`/usr`, `/boot`, `/etc` read-only), `ProtectHome` and `PrivateTmp`

The macOS bundle installs as a launchd daemon instead. Enver serves both at `GET /v1/edge-servers/installer` and `GET /v1/edge-servers/installer/macos`, with detached GPG signatures next to them. A release build carries the release key (`enver-signing-key.gpg`, baked into the bundle), and every self-update must be signed by it.

---

## Installation

```bash
# Install the package
sudo dpkg -i enver-edge-server_<version>_<amd64|arm64>.deb

# The package created the config (root only) - set the token in it
sudo nano /etc/enver/edge-server.env
# EDGE_SERVER_TOKEN=<copy it from the edge server's detail page in the Enver UI>

# Restart after config change
sudo systemctl restart enver-edge-server

# Check status / logs
sudo systemctl status enver-edge-server
sudo journalctl -u enver-edge-server -f
```

Docker socket path, Kubernetes cluster connection, ingress class and cert-manager issuer are configured afterwards in the Enver UI on the edge server's detail page, and picked up automatically within 60 seconds — no restart needed.

### macOS

Run from the account that runs Docker Desktop / OrbStack / Colima — the daemon runs as that user so it can reach its Docker socket:

```bash
curl -fsSL "https://api.example.com/v1/edge-servers/installer/macos" | tar -xzf - -C /tmp \
  && sudo /tmp/enver-edge-server/install.sh && rm -rf /tmp/enver-edge-server

# The installer creates /etc/enver/edge-server.env owned by you - fill in the token
sudo nano /etc/enver/edge-server.env

# Restart after config change / check logs
sudo launchctl kickstart -k system/com.enver.edge-server
tail -f /var/log/enver-edge-server.log

# Uninstall (keeps the env file)
sudo /opt/enver/edge-server/uninstall.sh
```

If `/var/run/docker.sock` doesn't exist (Docker Desktop: Settings → Advanced → "Allow the default Docker socket to be used"), the installer prints the user socket it found (e.g. `/Users/<you>/.docker/run/docker.sock`) — set that as the Docker socket path in the Enver UI. Swap metrics are reported as 0 on macOS (there is no `/proc/meminfo`).

---

## Kubernetes access on bare metal

Without a CA certificate in the settings, the API server's certificate is checked against the system CAs. A cluster with a self-signed certificate needs its CA certificate there; **Skip TLS verification** exists for test clusters only, since the ServiceAccount token then goes to whoever answers at the API server's address.

Configure the cluster's API URL and ServiceAccount token in the Enver UI (edge server detail page → "Docker & Kubernetes settings") — the page includes a copyable `kubectl` snippet that creates a ServiceAccount with the right permissions and prints its token. The edge server downloads and applies this automatically; no kubeconfig file needs to exist on the host.

For local development or an air-gapped install, point at a local kubeconfig instead via `KUBECONFIG_PATH` in `/etc/enver/edge-server.env` (takes precedence over the UI-configured connection):

```bash
sudo cp /etc/rancher/k3s/k3s.yaml /etc/enver/kubeconfig
sudo chown enver-edge-server:enver-edge-server /etc/enver/kubeconfig
sudo chmod 600 /etc/enver/kubeconfig
```

```ini
# /etc/enver/edge-server.env
KUBECONFIG_PATH=/etc/enver/kubeconfig
```

---

## Host directories

Docker volumes and database backups are confined to the directories listed per edge server in the Enver UI (edge server detail → settings): **Volumes directories** and **Backups directories**. Nothing else on the host is reachable; with empty lists services with volumes don't start and no backup runs, with an error naming the setting.

- A volume's host path (a file or a directory) and a service's backup directory are relative to the first directory of their list, or an absolute path anywhere inside one of them. The lists may overlap.
- The agent follows symbolic links and refuses a path whose real location is outside the directory, or that runs through a broken link (Docker would create its target). It resolves the volumes again right before it creates the container and hands Docker the real path, since an image pull can take long.
- Volumes may not nest: they may share a path, but one may not lie inside another (of any service, or of the same one), a backup directory may not lie inside a volume, and a whole volumes directory is never a volume. Otherwise a container holding the outer directory could swap the inner one for a symbolic link, which Docker follows whenever it mounts the volume again, e.g. after a reboot. The agent checks the real paths against the bind sources of every container it manages, stopped ones too, under a lock, so two starts can't pass the check together. The API refuses such a save, naming the other service, and the edge server's settings list the conflicts already saved.

Whatever lies in these directories is open to the containers and to whoever may edit services. The lists are the only restriction - no path is refused for being a system one - so list dedicated directories. The UI suggests `/opt/enver/volumes` and `/opt/enver/backups`, which the installers create (the backups one writable by the agent's user); another backups directory must be writable by that user too.

Backups are only the agent's own `backup-<timestamp>.dump` files: listing, pruning, deleting and restoring never touch anything else in the directory, and a dump is opened without following symbolic links.

The agent acts only on containers it created (label `io.enver.managed`, or an `enver-<environmentGuid>` network for containers from before the label): a service named like another container on the host fails with an error instead of stopping, reading or exec-ing into it.

---

## Docker access on bare metal

No extra config needed if the Docker socket is at `/var/run/docker.sock` and the `enver-edge-server` user is in the `docker` group (the package's postinst does this automatically). To use a non-standard socket path, set it in the Enver UI on the edge server's detail page, or override locally via `DOCKER_SOCKET_PATH` in `/etc/enver/edge-server.env`.

---

## Job payload reference

Jobs arrive over WebSocket as `EdgeServerJob` messages. The `service.action` type drives container lifecycle:

```json
{
  "type": "service.action",
  "edgeServerGuid": "...",
  "payload": {
    "environmentServiceGuid": "...",
    "action": "start | stop | restart",
    "deploymentType": "docker | kubernetes",
    "serviceName": "my-service",
    "image": "registry.example.com/my-app:1.2.3",
    "containerName": "my-service",
    "port": 3000,
    "replicas": 2,
    "subdomain": "my-service",
    "ingressHost": "my-service.example.com",
    "env": [
      { "name": "NODE_ENV", "value": "production" }
    ]
  }
}
```

The edge server routes the job to `DockerService` or `KubernetesService` based on `deploymentType`.
