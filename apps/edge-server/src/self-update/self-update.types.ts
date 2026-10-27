/** Shared by the launcher and the agent, so it must stay free of Nest and of the domain libs: the
 *  launcher bundle runs from the installed base and should load nothing but Node.js built-ins. */
export namespace SelfUpdateTypes {
	/** The agent exits with this after switching versions; the launcher then starts the new current one. */
	export const RESTART_EXIT_CODE = 75

	export const ENV_HOME = 'ENVER_EDGE_SERVER_HOME'
	export const ENV_LAUNCHER = 'ENVER_EDGE_SERVER_LAUNCHER'
	/** The usual name browsers and curl read; Node.js only honours `--tls-keylog`, so the launcher passes it on. */
	export const ENV_TLS_KEYLOG = 'SSLKEYLOGFILE'

	export const VERSIONS_DIR = 'versions'
	export const STATE_FILE = 'state.json'
	export const STAGING_DIR = '.staging'
	export const ENTRYPOINT = 'dist/apps/edge-server/main.js'
	export const NODE_BIN = 'node/bin/node'
	export const VERSION_FILE = 'VERSION'
	/** Binary (`gpg --export`) public key the installer pins; updates must then carry a valid signature. */
	export const SIGNING_KEY_FILE = 'enver-signing-key.gpg'

	/** A new version must keep its api connection up for `CONFIRM_AFTER_MS` within this time, or the launcher rolls back. */
	export const TRIAL_TIMEOUT_MS = 10 * 60_000
	export const CONFIRM_AFTER_MS = 30_000
	/** Starts of an unconfirmed version (crash, reboot) before the launcher gives up on it. */
	export const MAX_TRIAL_STARTS = 3
	export const MAX_FAILED_VERSIONS = 10
	export const KILL_GRACE_MS = 15_000

	export const FIRST_CHECK_DELAY_MIN_MS = 5 * 60_000
	export const FIRST_CHECK_DELAY_MAX_MS = 20 * 60_000
	export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
	export const CHECK_JITTER_MS = 60 * 60_000

	export interface PendingVersion {
		version: string
		starts: number
		since: string
	}

	/** `versions/state.json`. A null `current` (or `previous`) means the installed base itself. */
	export interface State {
		current: string | null
		previous: string | null
		/** Switched to, but not yet confirmed by the version itself. */
		pending: PendingVersion | null
		/** Versions that failed to come up; auto-update skips them. */
		failed: string[]
	}

	export const EMPTY_STATE: State = { current: null, previous: null, pending: null, failed: [] }

	export interface StartPlan {
		/** Null runs the installed base. */
		version: string | null
		trial: boolean
		state: State
	}

	export interface ExitDecision {
		action: 'restart' | 'exit'
		state: State
	}

	export type StateFs = {
		readFile(path: string, encoding: 'utf8'): Promise<string>
		writeFile(path: string, data: string): Promise<void>
		rename(from: string, to: string): Promise<void>
	}

	export enum Support {
		supported = 'supported',
		noLauncher = 'no-launcher',
		notWritable = 'not-writable',
	}

	export enum UpdateState {
		idle = 'idle',
		checking = 'checking',
		downloading = 'downloading',
		restarting = 'restarting',
	}

	export interface Options {
		version: string
		/** The instance the hub pointed the agent to - releases are downloaded from it. */
		apiUrl: string
		autoUpdate: boolean
		/** Install root the launcher passed in `ENVER_EDGE_SERVER_HOME`; null when not started by it. */
		homeDir: string | null
		/** Root of the version this process runs from: the install root or `versions/<v>`. */
		ownDir: string
		/** The release key baked into the build; a build without one falls back to `SIGNING_KEY_FILE`. */
		signingKey: Uint8Array | null
		platform: NodeJS.Platform
		arch: string
	}

	export const OPTIONS = Symbol('SelfUpdateOptions')

	export class VerificationError extends Error { public code = 'verification_failed' }
	export class PackageError extends Error { public code = 'invalid_package' }
	export class NoPackageError extends Error { public code = 'no_package' }
}
