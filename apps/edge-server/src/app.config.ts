import { resolve } from 'path'

import { SelfUpdateTypes } from './self-update/self-update.types'

try { process.loadEnvFile() } catch {}

export const config = {
	/** Baked in by webpack's DefinePlugin from the release build (`VERSION`); "dev" otherwise, which never self-updates. */
	version: process.env.ENVER_BUILD_VERSION || 'dev',
	/** Root of the running version, three levels above the bundled dist/apps/edge-server/main.js. */
	ownDir: resolve(__dirname, '../../..'),
	/** Set only when the installer's launcher started this process (see src/launcher). */
	homeDir: process.env[SelfUpdateTypes.ENV_LAUNCHER] === '1' ? process.env[SelfUpdateTypes.ENV_HOME] || null : null,
	/** The release key (binary, base64) baked in by webpack from `enver-signing-key.gpg`; every
	 *  self-update must be signed by it. Empty in a build without that file. */
	signingKey: process.env.ENVER_PINNED_SIGNING_KEY ? Buffer.from(process.env.ENVER_PINNED_SIGNING_KEY, 'base64') : null,
	port: Number(process.env.EDGE_SERVER_PORT || 80),
	token: process.env.EDGE_SERVER_TOKEN || '',
	/** `API_URL` is the hub, which tells the agent its instance (see instance-locator.ts). */
	hubUrl: process.env.API_URL || 'https://hub.enver.apinecka.com',

	/** Dev/air-gapped escape hatches - take precedence over the docker/kubernetes settings fetched
	 *  from the enver API (see edge-server-options.ts). Leave unset in normal deployments; the
	 *  fetched settings are the source of truth and are configured in the enver UI. */
	overrides: {
		dockerSocketPath: process.env.DOCKER_SOCKET_PATH,
		kubeconfigPath: process.env.KUBECONFIG_PATH,
	},

	logs: {
		maxLines: 250,
	},

	docker: {
		/** Host address Docker publishes the services' ports on, e.g. a private interface's; all
		 *  interfaces when unset, which bypasses a host firewall like ufw. */
		portsHostIp: process.env.DOCKER_PORTS_HOST_IP || undefined,
	},

	/** A service's env file is read from here only, so the server's operator decides which files
	 *  Enver may hand to a container (see env-files.service.ts). */
	envFiles: {
		dir: process.env.ENV_FILES_DIR || '/etc/enver/env-files',
		maxBytes: 1024 * 1024,
	},
}
