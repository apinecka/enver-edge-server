import { join } from 'path'

import { SelfUpdateTypes } from './self-update.types'

/** Reads and writes `versions/state.json` and decides every version switch. The launcher and the
 *  agent share it, so both always agree on which version is current, pending or failed. */
export class UpdateStateStore {
	readonly versionsDir: string
	private statePath: string

	constructor(homeDir: string, private fs: SelfUpdateTypes.StateFs, private now: () => Date = () => new Date()) {
		this.versionsDir = join(homeDir, SelfUpdateTypes.VERSIONS_DIR)
		this.statePath = join(this.versionsDir, SelfUpdateTypes.STATE_FILE)
	}

	versionDir(version: string): string {
		return join(this.versionsDir, version)
	}

	/** A missing or damaged file means "run the installed base". */
	async read(): Promise<SelfUpdateTypes.State> {
		let raw: string
		try {
			raw = await this.fs.readFile(this.statePath, 'utf8')
		} catch {
			return { ...SelfUpdateTypes.EMPTY_STATE }
		}
		try {
			return this.normalize(JSON.parse(raw))
		} catch {
			return { ...SelfUpdateTypes.EMPTY_STATE }
		}
	}

	/** Write to a temp file and rename it over, so a crash mid-write never leaves half a state. */
	async write(state: SelfUpdateTypes.State): Promise<void> {
		const tmp = `${this.statePath}.tmp`
		await this.fs.writeFile(tmp, JSON.stringify(state, null, '\t'))
		await this.fs.rename(tmp, this.statePath)
	}

	/** Which version the launcher starts now. A pending version counts one more start and is
	 *  rolled back once it has used up its starts; a missing version directory falls back. */
	planStart(state: SelfUpdateTypes.State, isInstalled: (version: string) => boolean): SelfUpdateTypes.StartPlan {
		let next = state
		if (next.current && !isInstalled(next.current)) next = { ...next, current: null, pending: null }
		if (next.pending) {
			if (next.pending.version !== next.current) next = { ...next, pending: null }
			else if (next.pending.starts >= SelfUpdateTypes.MAX_TRIAL_STARTS) next = this.rollback(next)
			else next = { ...next, pending: { ...next.pending, starts: next.pending.starts + 1 } }
		}
		if (next.current && !isInstalled(next.current)) next = { ...next, current: null }
		return { version: next.current, trial: next.pending !== null, state: next }
	}

	/** After the child exits: a restart request switches to whatever is current now, a pending
	 *  version that dies is rolled back, anything else ends the launcher for the service manager. */
	afterExit(state: SelfUpdateTypes.State, plan: SelfUpdateTypes.StartPlan, exitCode: number | null): SelfUpdateTypes.ExitDecision {
		if (exitCode === SelfUpdateTypes.RESTART_EXIT_CODE) return { action: 'restart', state }
		if (plan.trial && plan.version !== null && state.pending?.version === plan.version) return { action: 'restart', state: this.rollback(state) }
		return { action: 'exit', state }
	}

	rollback(state: SelfUpdateTypes.State): SelfUpdateTypes.State {
		const failedVersion = state.pending?.version ?? state.current
		const failed = failedVersion ? [...state.failed.filter((v) => v !== failedVersion), failedVersion] : state.failed
		return {
			current: state.previous,
			previous: null,
			pending: null,
			failed: failed.slice(-SelfUpdateTypes.MAX_FAILED_VERSIONS),
		}
	}

	/** `running` is the version directory the switching process runs from (null for the base). */
	beginTrial(state: SelfUpdateTypes.State, version: string, running: string | null): SelfUpdateTypes.State {
		return {
			current: version,
			previous: running,
			pending: { version, starts: 0, since: this.now().toISOString() },
			failed: state.failed.filter((v) => v !== version),
		}
	}

	confirm(state: SelfUpdateTypes.State, version: string): SelfUpdateTypes.State {
		if (state.pending?.version !== version) return state
		return { ...state, pending: null }
	}

	/** Version directories still needed: everything else in `versions/` may be deleted. */
	keep(state: SelfUpdateTypes.State): Set<string> {
		return new Set([state.current, state.previous, state.pending?.version].filter((v): v is string => !!v))
	}

	private normalize(value: unknown): SelfUpdateTypes.State {
		const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
		const version = (v: unknown) => typeof v === 'string' && this.isVersionName(v) ? v : null
		const pendingRaw = raw['pending'] as Record<string, unknown> | null | undefined
		const pendingVersion = pendingRaw ? version(pendingRaw['version']) : null
		return {
			current: version(raw['current']),
			previous: version(raw['previous']),
			pending: pendingRaw && pendingVersion
				? {
					version: pendingVersion,
					starts: typeof pendingRaw['starts'] === 'number' ? pendingRaw['starts'] : 0,
					since: typeof pendingRaw['since'] === 'string' ? pendingRaw['since'] : this.now().toISOString(),
				}
				: null,
			failed: Array.isArray(raw['failed']) ? raw['failed'].map(version).filter((v): v is string => v !== null) : [],
		}
	}

	/** Version names become directory names, so nothing but a plain semver may pass. */
	isVersionName(value: string): boolean {
		return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(value) && !value.includes('..')
	}
}
