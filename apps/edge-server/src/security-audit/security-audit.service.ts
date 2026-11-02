import { EdgeProtocol, SecurityAudit } from '@enver/edge-protocol'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { constants } from 'fs'
import { access } from 'fs/promises'
import { join } from 'path'

import { config } from '../app.config'
import { HostFs } from './host-fs'
import { KnownSources } from './known-sources'
import { OsReleaseParser } from './os-release.parser'
import { SecurityAuditTypes } from './security-audit.types'

/** Answers `security.audit` jobs with the host's security state (see `SecurityAudit`). Refuses them
 *  unless the api turned the audit on, and runs one at a time. */
@Injectable()
export class SecurityAuditService {
	private readonly logger = new Logger(SecurityAuditService.name)
	private enabled = false
	private running = false

	constructor(
		private readonly fs: HostFs,
		private readonly osRelease: OsReleaseParser,
		@Inject(SecurityAuditTypes.COLLECTORS) private readonly collectors: SecurityAuditTypes.Collector[],
	) {}

	configure(settings: Pick<EdgeProtocol.Settings, 'securityAudit'>): void {
		this.enabled = settings.securityAudit === true
	}

	async run(payload: SecurityAudit.JobPayload, now = new Date()): Promise<SecurityAudit.Result> {
		if (!this.enabled) return { status: 'refused', reason: SecurityAudit.RefusalReason.disabled }
		if (payload.cursor !== null && !SecurityAudit.isValidCursor(payload.cursor)) return { status: 'refused', reason: SecurityAudit.RefusalReason.invalidCursor }
		if (this.running) return { status: 'refused', reason: SecurityAudit.RefusalReason.busy }
		this.running = true
		try {
			const packagesHash = typeof payload.packagesHash === 'string' && SecurityAudit.HASH_REGEX.test(payload.packagesHash) ? payload.packagesHash : null
			return await this.audit(payload.cursor, packagesHash, now)
		} finally {
			this.running = false
		}
	}

	private async audit(cursor: string | null, packagesHash: string | null, now: Date): Promise<SecurityAudit.Result> {
		const release = await this.readOsRelease()
		const collector = process.platform === 'linux' && release ? this.collectors.find((c) => c.supports(release)) : undefined
		if (!collector || !release) {
			return { status: 'unsupported', platform: process.platform, osId: this.clip(release?.id ?? null, SecurityAudit.LIMITS.shortString), osVersionId: this.clip(release?.versionId ?? null, SecurityAudit.LIMITS.shortString) }
		}

		const stateDir = await this.writableStateDir()
		const sources = await KnownSources.open(stateDir)
		const authLogExists = (await this.fs.statIfPossible(SecurityAuditTypes.AUTH_LOG)) !== null
		const context: SecurityAuditTypes.CollectContext = {
			os: release,
			cursor,
			now,
			sources,
			journalReadable: await this.journalReadable(),
			authLogReadable: authLogExists ? await this.fs.canRead(SecurityAuditTypes.AUTH_LOG) : null,
			packagesHash,
		}
		const collected = await collector.collect(context)
		await sources.save(now).catch((err: unknown) => this.logger.warn({ err }, 'Could not save the security audit state'))

		const permissions: SecurityAudit.PermissionsSection = {
			missingGroups: await this.missingGroups(),
			readable: { journal: context.journalReadable, authLog: context.authLogReadable, sshdConfig: collected.sshdConfigReadable },
			unreadableFiles: collected.unreadableFiles,
			stateDirectory: stateDir !== null,
		}
		const report: SecurityAudit.Report = {
			family: collector.family,
			collectedAt: now.toISOString(),
			os: collected.os,
			ssh: collected.ssh,
			logins: collected.logins,
			updates: collected.updates,
			ports: collected.ports,
			accounts: collected.accounts,
			persistence: collected.persistence,
			processes: collected.processes,
			sudo: collected.sudo,
			firewall: collected.firewall,
			packages: collected.packages,
			permissions,
			errors: collected.errors,
		}
		const partial = report.errors.length > 0 || permissions.missingGroups.length > 0 || permissions.unreadableFiles.length > 0 || !permissions.stateDirectory
		return { status: partial ? 'partial' : 'ok', report: this.limit(report) }
	}

	private async readOsRelease(): Promise<SecurityAuditTypes.OsRelease | null> {
		for (const path of SecurityAuditTypes.OS_RELEASE) {
			const text = await this.fs.readIfReadable(path)
			if (text !== null) return this.osRelease.parse(text)
		}
		return null
	}

	/** systemd's `StateDirectory=` (`$STATE_DIRECTORY`); a unit from an older package has none. */
	private async writableStateDir(): Promise<string | null> {
		const dir = config.securityAudit.stateDir
		if (!dir) return null
		try {
			await access(dir, constants.W_OK | constants.R_OK | constants.X_OK)
			return dir
		} catch {
			return null
		}
	}

	/** journalctl shows a user without access only their own entries, without failing, so the
	 *  system journal file itself is checked. */
	private async journalReadable(): Promise<boolean> {
		if (process.getuid?.() === 0) return true
		for (const dir of SecurityAuditTypes.JOURNAL_DIRS) {
			for (const machine of await this.fs.list(dir)) {
				if (await this.fs.canRead(join(dir, machine, 'system.journal'))) return true
			}
		}
		return false
	}

	/** Of the required groups that exist on the host, those the process doesn't run with. */
	private async missingGroups(): Promise<string[]> {
		if (process.getuid?.() === 0) return []
		const own = new Set(process.getgroups?.() ?? [])
		const groupFile = await this.fs.readIfReadable(SecurityAuditTypes.GROUP_FILE) ?? ''
		const gids = new Map<string, number>(groupFile.split('\n').map((line) => line.split(':')).filter((f) => f.length >= 3).map((f): [string, number] => [f[0], Number(f[2])]))
		return SecurityAudit.REQUIRED_GROUPS.filter((group) => {
			const gid = gids.get(group)
			return gid !== undefined && !own.has(gid)
		})
	}

	/** The api enforces the same limits; cutting here keeps a report from being rejected whole. */
	private limit(report: SecurityAudit.Report): SecurityAudit.Report {
		const { LIMITS } = SecurityAudit
		const s = (value: string) => this.clip(value, LIMITS.string) ?? ''
		const short = (value: string) => this.clip(value, LIMITS.shortString) ?? ''
		const sn = (value: string | null) => this.clip(value, LIMITS.string)
		const list = (values: string[], max: number = LIMITS.listItems) => values.slice(0, max).map(short)
		const packages = (values: SecurityAudit.PackageUpdate[]) => values.slice(0, LIMITS.packages).map((p) => ({
			name: s(p.name), installedVersion: sn(p.installedVersion), candidateVersion: s(p.candidateVersion),
		}))
		const { os, ssh, logins, updates, ports, accounts, persistence, processes, sudo, packages: installed, permissions } = report
		const topUsernames = (values: { username: string; count: number }[]) => values.slice(0, LIMITS.topUsernames).map((u) => ({ ...u, username: short(u.username) }))
		return {
			...report,
			os: os && {
				id: short(os.id),
				versionId: this.clip(os.versionId, LIMITS.shortString),
				prettyName: sn(os.prettyName),
				codename: this.clip(os.codename, LIMITS.shortString),
				kernel: { running: s(os.kernel.running), newestInstalled: sn(os.kernel.newestInstalled), rebootNeeded: os.kernel.rebootNeeded },
				rebootRequired: { ...os.rebootRequired, packages: list(os.rebootRequired.packages, LIMITS.rebootPackages) },
				unattendedUpgrades: os.unattendedUpgrades,
			},
			ssh: ssh && {
				...ssh,
				version: sn(ssh.version),
				config: ssh.config && {
					...ssh.config,
					permitRootLogin: short(ssh.config.permitRootLogin),
					passwordAuthentication: short(ssh.config.passwordAuthentication),
					kbdInteractiveAuthentication: short(ssh.config.kbdInteractiveAuthentication),
					pubkeyAuthentication: short(ssh.config.pubkeyAuthentication),
					permitEmptyPasswords: short(ssh.config.permitEmptyPasswords),
					x11Forwarding: short(ssh.config.x11Forwarding),
					allowUsers: list(ssh.config.allowUsers),
					allowGroups: list(ssh.config.allowGroups),
					ports: ssh.config.ports.slice(0, LIMITS.ports),
					weakAlgorithms: list(ssh.config.weakAlgorithms),
				},
			},
			logins: logins && {
				...logins,
				successful: logins.successful.slice(-LIMITS.logins).map((l) => ({ ...l, username: short(l.username) })),
				failures: {
					...logins.failures,
					topUsernames: logins.failures.topUsernames.slice(0, LIMITS.topUsernames).map((u) => ({ ...u, username: short(u.username) })),
				},
			},
			updates: updates && {
				...updates,
				security: packages(updates.security),
				esmInfra: packages(updates.esmInfra),
				esmApps: packages(updates.esmApps),
				regular: packages(updates.regular),
			},
			ports: ports && { listening: ports.listening.slice(0, LIMITS.listeningPorts) },
			accounts: accounts && {
				accounts: accounts.accounts.slice(0, LIMITS.accounts).map((a) => ({ ...a, name: short(a.name) })),
				groups: accounts.groups.map((g) => ({ name: short(g.name), members: list(g.members, LIMITS.groupMembers) })),
			},
			persistence: persistence && { ...persistence, files: persistence.files.slice(0, LIMITS.persistenceFiles).map((f) => ({ ...f, path: s(f.path) })) },
			processes: processes && {
				...processes,
				suspicious: processes.suspicious.slice(0, LIMITS.processes).map((p) => ({ ...p, name: short(p.name) })),
			},
			sudo: sudo && { ...sudo, topUsernames: topUsernames(sudo.topUsernames) },
			packages: installed && {
				...installed,
				list: installed.list && installed.list.slice(0, LIMITS.installedPackages).map((p) => ({
					name: s(p.name), version: s(p.version), arch: short(p.arch), source: sn(p.source), sourceVersion: sn(p.sourceVersion),
				})),
			},
			permissions: { ...permissions, unreadableFiles: permissions.unreadableFiles.slice(0, LIMITS.unreadableFiles).map(s) },
			errors: report.errors.slice(0, LIMITS.errors).map((e) => ({ section: e.section, message: s(e.message) })),
		}
	}

	private clip(value: string | null, max: number): string | null {
		if (value === null) return null
		return value.length > max ? value.slice(0, max) : value
	}
}
