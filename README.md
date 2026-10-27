# Enver edge server

[Enver](https://enver.apinecka.com/about/) deploys and runs containers of many environments from one place. The edge server is its agent: a small Node.js service you install on your own machine (Linux or macOS), which keeps an outgoing connection to Enver and runs the services you configure there through Docker or Kubernetes.

The agent runs with access to your Docker daemon or cluster, so you should be able to read what it does. This repository holds its complete source, the packaging scripts, and the workflow that builds the published packages.

- **What it does and what it sends:** see [What the agent does and what it needs](https://enver.apinecka.com/about/docs/#edge) in the guide, and [Check what the agent sends](https://enver.apinecka.com/about/docs/#inspect-traffic) to verify it yourself with Wireshark.
- **Configuration, installation and internals:** [`apps/edge-server/README.md`](apps/edge-server/README.md).
- **Protocol:** every message between the agent and Enver is typed in [`libs/edge-protocol`](libs/edge-protocol/src/edge-protocol.types.ts).

## Layout

| Path | What |
|---|---|
| `apps/edge-server` | The agent (NestJS): connection, job processing, backups, metrics, self-update, and the launcher the service manager runs |
| `libs/domains/src/docker`, `libs/domains/src/kubernetes` | Docker (dockerode) and Kubernetes (server-side apply) drivers |
| `libs/edge-protocol` | Jobs, messages and settings exchanged with Enver |
| `scripts` | `.deb` and macOS packaging, bundling the official Node.js runtime |

## Build and test

Node.js and npm versions are in `.nvmrc` and `package.json` (`engines`).

```bash
npm ci
npm test
npm run build            # dist/apps/edge-server/{main,launcher}.js
npm run package:deb      # dist-deploy/enver-edge-server_<version>_<arch>.deb
npm run package:macos    # dist-deploy/enver-edge-server_<version>_macos.tar.gz
```

## Verify a release

Each release is built from its tag by [`.github/workflows/release.yml`](.github/workflows/release.yml), which attests where every package came from. To check that a package was built from this repository:

```bash
gh attestation verify enver-edge-server_<version>_amd64.deb --repo apinecka/enver-edge-server
```

The installers Enver serves are these packages, signed with the Enver release key (`enver-signing-key.gpg`, pinned by every installed agent): an agent installs a self-update only when its SHA-256 matches the release and its signature verifies against that key. To check what an installed agent runs, compare `/opt/enver/edge-server/VERSION` with a tag here.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

Apache License 2.0, see [LICENSE](LICENSE). The Enver service itself (the API, web app and billing) is not open source.
