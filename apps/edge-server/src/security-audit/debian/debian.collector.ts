import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { createHash } from 'crypto'
import * as os from 'os'

import { AccountsReader } from '../accounts.reader'
import { CommandRunner } from '../command-runner'
import { HostFs } from '../host-fs'
import { LoginsReader } from '../logins-reader'
import { NetworkReader } from '../network.reader'
import { PersistenceReader } from '../persistence.reader'
import { ProcessesReader } from '../processes.reader'
import { SecurityAuditTypes } from '../security-audit.types'
import { SshdConfigParser } from '../sshd-config.parser'
import { AptParser } from './apt.parser'
import { DebianTypes } from './debian.types'

/** Debian 11-13 and Ubuntu 20.04+: dpkg, apt and `/var/log/auth.log`. */
@Injectable()
export class DebianCollector implements SecurityAuditTypes.Collector {
	readonly family = SecurityAudit.DistroFamily.debian

	constructor(
		private readonly fs: HostFs,
		private readonly runner: CommandRunner,
		private readonly sshdConfig: SshdConfigParser,
		private readonly apt: AptParser,
		private readonly logins: LoginsReader,
		private readonly network: NetworkReader,
		private readonly accounts: AccountsReader,
		private readonly persistence: PersistenceReader,
		private readonly processes: ProcessesReader,
	) {}

	supports(release: SecurityAuditTypes.OsRelease): boolean {
		if (release.id === 'debian') return DebianTypes.SUPPORTED_DEBIAN.includes(release.versionId ?? '')
		if (release.id !== 'ubuntu') return false
		const [major, minor] = (release.versionId ?? '').split('.').map(Number)
		const [minMajor, minMinor] = DebianTypes.MIN_UBUNTU
		return major > minMajor || (major === minMajor && minor >= minMinor)
	}

	async collect(context: SecurityAuditTypes.CollectContext): Promise<SecurityAuditTypes.Collected> {
		const errors: SecurityAudit.Report['errors'] = []
		const section = async <T>(name: SecurityAudit.Section, fn: () => Promise<T>): Promise<T | null> => {
			try {
				return await fn()
			} catch (err) {
				errors.push({ section: name, message: err instanceof Error ? err.message : 'Unknown error' })
				return null
			}
		}

		const packages = await this.packages().catch(() => new Map<string, DebianTypes.InstalledPackage>())
		const sshdConfig = await this.sshdConfig.read(this.fs)
		const [osSection, ssh, auth, updates, ports, accounts, persistence, processes, firewall, installed] = await Promise.all([
			section(SecurityAudit.Section.os, () => this.os(context.os, packages)),
			section(SecurityAudit.Section.ssh, () => this.ssh(packages, sshdConfig)),
			section(SecurityAudit.Section.logins, () => this.logins.read(context, SecurityAuditTypes.AUTH_LOG)),
			section(SecurityAudit.Section.updates, () => this.updates()),
			section(SecurityAudit.Section.ports, () => this.network.ports()),
			section(SecurityAudit.Section.accounts, () => this.accounts.read()),
			section(SecurityAudit.Section.persistence, () => this.persistence.read()),
			section(SecurityAudit.Section.processes, () => this.processes.read()),
			section(SecurityAudit.Section.firewall, () => this.network.firewall()),
			section(SecurityAudit.Section.packages, () => this.installedPackages(context.packagesHash)),
		])
		// sudo's failures come from the same read as the logins
		const loginsError = errors.find((e) => e.section === SecurityAudit.Section.logins)
		if (loginsError) errors.push({ section: SecurityAudit.Section.sudo, message: loginsError.message })
		return {
			os: osSection,
			ssh,
			logins: auth?.logins ?? null,
			updates,
			ports,
			accounts,
			persistence,
			processes,
			sudo: auth?.sudo ?? null,
			firewall,
			packages: installed,
			errors,
			sshdConfigReadable: sshdConfig.readFiles.includes(SecurityAuditTypes.SSHD_CONFIG),
			unreadableFiles: sshdConfig.unreadableFiles,
		}
	}

	private async packages(): Promise<Map<string, DebianTypes.InstalledPackage>> {
		const { stdout } = await this.runner.run(SecurityAuditTypes.Program.dpkgQuery, ['-W', '--showformat=${Package}\t${db:Status-Abbrev}\t${Version}\n', ...DebianTypes.PACKAGES])
		return this.apt.parsePackages(stdout)
	}

	/** Names and versions of every installed package; the list itself only when the api's hash differs. */
	private async installedPackages(knownHash: string | null): Promise<SecurityAudit.PackagesSection> {
		const result = await this.runner.run(
			SecurityAuditTypes.Program.dpkgQuery,
			['-W', '--showformat=${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}\t${Source}\n'],
			SecurityAuditTypes.DPKG_LIST_COMMAND,
		)
		if (result.exitCode !== 0) throw new SecurityAuditTypes.SectionUnavailableError(`dpkg-query ${result.truncated ? 'printed too much' : `exited with ${result.exitCode}`}`)
		const all = this.apt.parseInstalled(result.stdout)
		const list = all.slice(0, SecurityAudit.LIMITS.installedPackages)
		const hash = createHash('sha256')
			.update(list.map((p) => [p.name, p.version, p.arch, p.source ?? '', p.sourceVersion ?? ''].join('\t')).join('\n'))
			.digest('hex')
		return { hash, count: all.length, list: hash === knownHash ? null : list }
	}

	private async os(release: SecurityAuditTypes.OsRelease, packages: Map<string, DebianTypes.InstalledPackage>): Promise<SecurityAudit.OsSection> {
		const running = os.release()
		const newestInstalled = this.newestKernel(await this.fs.list(SecurityAuditTypes.BOOT_DIR))
		const rebootRequired = await this.fs.statIfPossible(SecurityAuditTypes.REBOOT_REQUIRED)
		const rebootPackages = rebootRequired ? await this.fs.readIfReadable(SecurityAuditTypes.REBOOT_REQUIRED_PKGS) : null
		const aptConf = await Promise.all((await this.fs.list(SecurityAuditTypes.APT_CONF_DIR))
			.map((name) => this.fs.readIfReadable(`${SecurityAuditTypes.APT_CONF_DIR}/${name}`)))
		const confTexts = aptConf.filter((text): text is string => text !== null)
		return {
			id: release.id ?? '',
			versionId: release.versionId,
			prettyName: release.prettyName,
			codename: release.codename,
			kernel: {
				running,
				newestInstalled,
				rebootNeeded: newestInstalled ? this.compareVersions(newestInstalled, running) > 0 : null,
			},
			rebootRequired: {
				required: rebootRequired !== null,
				since: rebootRequired?.mtime.toISOString() ?? null,
				packages: [...new Set<string>((rebootPackages ?? '').split('\n').map((l) => l.trim()).filter(Boolean))],
			},
			unattendedUpgrades: {
				installed: packages.get('unattended-upgrades')?.installed ?? false,
				enabled: this.apt.periodic(confTexts, 'Unattended-Upgrade'),
				updatePackageLists: this.apt.periodic(confTexts, 'Update-Package-Lists'),
			},
		}
	}

	private async ssh(packages: Map<string, DebianTypes.InstalledPackage>, config: SecurityAuditTypes.SshdConfig): Promise<SecurityAudit.SshSection> {
		const server = packages.get('openssh-server')
		const units = await this.unitStates()
		const presence = (pkg: string, unit: string): SecurityAudit.ServicePresence => ({
			installed: packages.get(pkg)?.installed ?? false,
			active: units ? units.active.get(unit) === 'active' : null,
		})
		const base = { fail2ban: presence('fail2ban', 'fail2ban.service'), crowdsec: presence('crowdsec', 'crowdsec.service') }
		if (!server?.installed) return { installed: false, version: null, config: null, socketActivated: null, ...base }

		const socketActivated = units ? units.active.get('ssh.socket') === 'active' || units.sshSocketEnabled : null
		const socketPorts = socketActivated ? this.sshdConfig.socketPorts(await this.socketUnits()) : []
		return {
			installed: true,
			version: server.version,
			config: config.readFiles.length ? this.sshdConfig.effective(config, socketPorts.length ? socketPorts : this.sshdConfig.ports(config)) : null,
			socketActivated,
			...base,
		}
	}

	/** `systemctl is-active` prints one state per unit, in order, and exits non-zero unless all are active. */
	private async unitStates(): Promise<{ active: Map<string, string>; sshSocketEnabled: boolean } | null> {
		const unitNames = ['ssh.socket', 'fail2ban.service', 'crowdsec.service']
		try {
			const active = await this.runner.run(SecurityAuditTypes.Program.systemctl, ['is-active', ...unitNames])
			const states = active.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
			if (states.length !== unitNames.length) return null
			const enabled = await this.runner.run(SecurityAuditTypes.Program.systemctl, ['is-enabled', 'ssh.socket'])
			return { active: new Map(unitNames.map((u, i) => [u, states[i]])), sshSocketEnabled: enabled.stdout.trim() === 'enabled' }
		} catch {
			return null
		}
	}

	/** The packaged unit, then its drop-ins; Ubuntu 24.04's generator writes the ports of `sshd_config` into one. */
	private async socketUnits(): Promise<string[]> {
		const texts: string[] = []
		for (const unit of SecurityAuditTypes.SSH_SOCKET_UNITS) {
			const text = await this.fs.readIfReadable(unit)
			if (text !== null) {
				texts.push(text)
				break
			}
		}
		for (const dropIn of SecurityAuditTypes.SSH_SOCKET_DROP_INS) {
			const stats = await this.fs.statIfPossible(dropIn)
			if (!stats) continue
			const files = stats.isDirectory() ? (await this.fs.list(dropIn)).filter((f) => f.endsWith('.conf')).map((f) => `${dropIn}/${f}`) : [dropIn]
			for (const file of files) {
				const text = await this.fs.readIfReadable(file)
				if (text !== null) texts.push(text)
			}
		}
		return texts
	}

	/** Simulated as the agent's user, which takes no lock and changes nothing. */
	private async updates(): Promise<SecurityAudit.UpdatesSection> {
		const result = await this.runner.run(SecurityAuditTypes.Program.aptGet, ['-s', '-o', 'Debug::NoLocking=true', 'dist-upgrade'], SecurityAuditTypes.APT_COMMAND)
		if (result.exitCode !== 0) throw new SecurityAuditTypes.SectionUnavailableError(`apt-get -s dist-upgrade ${result.truncated ? 'printed too much' : `exited with ${result.exitCode}`}`)
		const upgrades = this.apt.parseSimulation(result.stdout)
		const stamp = await this.fs.statIfPossible(SecurityAuditTypes.APT_UPDATE_STAMP) ?? await this.fs.statIfPossible(SecurityAuditTypes.APT_LISTS)
		return {
			...upgrades,
			counts: {
				security: upgrades.security.length,
				esmInfra: upgrades.esmInfra.length,
				esmApps: upgrades.esmApps.length,
				regular: upgrades.regular.length,
			},
			cacheUpdatedAt: stamp?.mtime.toISOString() ?? null,
		}
	}

	/** `/boot/vmlinuz-<release>`, as `uname -r` names them. */
	private newestKernel(bootFiles: string[]): string | null {
		const kernels = bootFiles.filter((f) => f.startsWith('vmlinuz-')).map((f) => f.slice('vmlinuz-'.length))
		return kernels.sort((a, b) => this.compareVersions(a, b)).at(-1) ?? null
	}

	/** Numeric runs compare as numbers, the rest as text: `6.1.0-28-amd64` > `6.1.0-9-amd64`. */
	private compareVersions(a: string, b: string): number {
		const pa = a.match(/\d+|\D+/g) ?? []
		const pb = b.match(/\d+|\D+/g) ?? []
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const x = pa[i] ?? ''
			const y = pb[i] ?? ''
			if (x === y) continue
			const nx = /^\d+$/.test(x) ? Number(x) : NaN
			const ny = /^\d+$/.test(y) ? Number(y) : NaN
			if (!Number.isNaN(nx) && !Number.isNaN(ny)) return nx - ny
			return x < y ? -1 : 1
		}
		return 0
	}
}
