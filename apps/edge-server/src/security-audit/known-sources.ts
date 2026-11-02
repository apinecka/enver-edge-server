import { SecurityAudit } from '@enver/edge-protocol'
import { createHash, randomBytes } from 'crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { SecurityAuditTypes } from './security-audit.types'

/** Which login sources this host has seen, kept only in the agent's state directory as SHA-256 of a
 *  random local salt and the address, so the addresses never leave the host and the file alone
 *  doesn't reveal them. Without a state directory it lives in memory for one run and can't tell new
 *  sources apart. */
export class KnownSources {
	private constructor(
		private readonly state: SecurityAuditTypes.KnownSourcesState,
		private readonly file: string | null,
		/** The first run with a state directory: it only learns which sources are known. */
		readonly learning: boolean,
	) {}

	static async open(stateDir: string | null): Promise<KnownSources> {
		if (!stateDir) return new KnownSources(KnownSources.empty(), null, true)
		const file = join(stateDir, SecurityAuditTypes.KNOWN_SOURCES_FILE)
		try {
			const state = KnownSources.validate(JSON.parse(await readFile(file, 'utf8')))
			if (state) return new KnownSources(state, file, false)
		} catch { /* missing or unreadable: start over */ }
		return new KnownSources(KnownSources.empty(), file, true)
	}

	get persistent(): boolean {
		return this.file !== null
	}

	/** Null when it can't be told: no state directory, the learning run, or no address. */
	isNew(address: string | null): boolean | null {
		if (!this.persistent || this.learning || !address) return null
		return !(this.hash(address) in this.state.known)
	}

	recentFailures(address: string | null, at: Date): number {
		if (!address) return 0
		const since = at.getTime() - SecurityAudit.AFTER_FAILURES_WINDOW_HOURS * 3_600_000
		return (this.state.failures[this.hash(address)] ?? []).filter((t) => t >= since && t <= at.getTime()).length
	}

	recordFailure(address: string | null, at: Date): void {
		if (!address) return
		const key = this.hash(address)
		const times = [...this.state.failures[key] ?? [], at.getTime()].sort((a, b) => a - b)
		delete this.state.failures[key]
		this.state.failures[key] = times.slice(-SecurityAudit.AFTER_FAILURES_THRESHOLD)
	}

	recordSuccess(address: string | null, at: Date): void {
		if (!address) return
		const key = this.hash(address)
		this.state.known[key] = Math.max(this.state.known[key] ?? 0, at.getTime())
		delete this.state.failures[key]
	}

	/** Drops what is older than its window and writes the file (mode 600) atomically. */
	async save(now: Date): Promise<void> {
		if (!this.file) return
		const knownSince = now.getTime() - SecurityAudit.KNOWN_SOURCE_DAYS * 86_400_000
		const failuresSince = now.getTime() - SecurityAudit.AFTER_FAILURES_WINDOW_HOURS * 3_600_000
		for (const [key, at] of Object.entries(this.state.known)) if (at < knownSince) delete this.state.known[key]
		const failing = Object.entries(this.state.failures)
			.map(([key, times]) => [key, times.filter((t) => t >= failuresSince)] as const)
			.filter(([, times]) => times.length > 0)
			.sort(([, a], [, b]) => a[a.length - 1] - b[b.length - 1])
			.slice(-SecurityAuditTypes.MAX_FAILING_SOURCES)
		this.state.failures = Object.fromEntries(failing)

		await mkdir(join(this.file, '..'), { recursive: true })
		const tmp = `${this.file}.tmp`
		await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 })
		await chmod(tmp, 0o600)
		await rename(tmp, this.file)
	}

	private hash(address: string): string {
		return createHash('sha256').update(this.state.salt).update(address.toLowerCase()).digest('hex').slice(0, 32)
	}

	private static empty(): SecurityAuditTypes.KnownSourcesState {
		return { version: 1, salt: randomBytes(32).toString('hex'), known: {}, failures: {} }
	}

	private static validate(value: unknown): SecurityAuditTypes.KnownSourcesState | null {
		if (!value || typeof value !== 'object') return null
		const v = value as Partial<SecurityAuditTypes.KnownSourcesState>
		if (v.version !== 1 || typeof v.salt !== 'string' || v.salt.length < 32 || !v.known || typeof v.known !== 'object' || !v.failures || typeof v.failures !== 'object') return null
		return { version: 1, salt: v.salt, known: v.known, failures: v.failures }
	}
}
