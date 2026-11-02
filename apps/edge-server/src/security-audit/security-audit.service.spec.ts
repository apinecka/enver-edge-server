import { SecurityAudit } from '@enver/edge-protocol'
import { existsSync, readFileSync } from 'fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { config as mockConfig } from '../app.config'
import { AccountsReader } from './accounts.reader'
import { AptParser } from './debian/apt.parser'
import { DebianCollector } from './debian/debian.collector'
import { HostFs } from './host-fs'
import { LoginAnalyzer } from './login-analyzer'
import { LoginsReader } from './logins-reader'
import { NetworkReader } from './network.reader'
import { OsReleaseParser } from './os-release.parser'
import { PersistenceReader } from './persistence.reader'
import { ProcessesReader } from './processes.reader'
import { SecurityAuditService } from './security-audit.service'
import { SecurityAuditTypes } from './security-audit.types'
import { SshLogParser } from './ssh-log.parser'
import { SshdConfigParser } from './sshd-config.parser'

jest.mock('../app.config', () => ({ config: { securityAudit: { stateDir: null } } }))

const FIXTURES = join(__dirname, 'fixtures')
const NOW = new Date('2026-10-31T12:00:00Z')
const LIST_BOOTS = 'IDX BOOT ID                          FIRST ENTRY                  LAST ENTRY\n -1 0a1b2c3d4e5f60718293a4b5c6d7e8f9 Sat 2026-10-24 08:00:00 UTC Sat 2026-10-31 11:59:00 UTC\n'

type Responses = Partial<Record<'dpkg' | 'installed' | 'active' | 'enabled' | 'journal' | 'tail' | 'boots' | 'apt', SecurityAuditTypes.CommandResult>>

const ok = (stdout: string): SecurityAuditTypes.CommandResult => ({ stdout, exitCode: 0, truncated: false })

function makeRunner(distro: string, responses: Responses = {}) {
	const fixture = (file: string) => readFileSync(join(FIXTURES, distro, file), 'utf8')
	const defaults: Required<Responses> = {
		dpkg: ok('openssh-server\tii \t1:9.2p1-2+deb12u7\nunattended-upgrades\tii \t2.9.1+nmu3\nfail2ban\tii \t1.0.2-2\n'),
		active: { stdout: 'inactive\nactive\ninactive\n', exitCode: 3, truncated: false },
		enabled: { stdout: 'disabled\n', exitCode: 1, truncated: false },
		journal: ok(fixture('journal.json')),
		tail: ok(''),
		boots: ok(LIST_BOOTS),
		apt: ok(fixture('apt-get-s-dist-upgrade.txt')),
		installed: ok(existsSync(join(FIXTURES, distro, 'dpkg-query-installed.txt')) ? fixture('dpkg-query-installed.txt') : ''),
	}
	const r = { ...defaults, ...responses }
	return {
		exists: jest.fn().mockResolvedValue(true),
		run: jest.fn((program: SecurityAuditTypes.Program, args: string[]) => {
			if (program === SecurityAuditTypes.Program.dpkgQuery) return Promise.resolve(args.some((arg) => arg.includes('${Source}')) ? r.installed : r.dpkg)
			if (program === SecurityAuditTypes.Program.aptGet) return Promise.resolve(r.apt)
			if (program === SecurityAuditTypes.Program.systemctl) return Promise.resolve(args[0] === 'is-active' ? r.active : r.enabled)
			if (args.includes('--list-boots')) return Promise.resolve(r.boots)
			if (args.includes('--lines=1')) return Promise.resolve(r.tail)
			return Promise.resolve(r.journal)
		}),
	}
}

describe('SecurityAuditService', () => {
	let root: string

	/** A copy of the distribution's fixture with a readable system journal and an /etc/group. */
	async function host(distro: string, { journal = true, groups = 'adm:x:64001:\nsystemd-journal:x:64002:\nsudo:x:27:deploy\ndocker:x:996:\n' } = {}): Promise<HostFs> {
		await cp(join(FIXTURES, distro), root, { recursive: true })
		if (journal) {
			await mkdir(join(root, 'var/log/journal/0123456789abcdef0123456789abcdef'), { recursive: true })
			await writeFile(join(root, 'var/log/journal/0123456789abcdef0123456789abcdef/system.journal'), '')
		}
		await writeFile(join(root, 'etc/group'), groups)
		return new HostFs(root)
	}

	function makeService(fs: HostFs, runner: ReturnType<typeof makeRunner>): SecurityAuditService {
		const logins = new LoginsReader(fs, runner as never, new SshLogParser(), new LoginAnalyzer())
		const debian = new DebianCollector(
			fs, runner as never, new SshdConfigParser(), new AptParser(), logins,
			new NetworkReader(fs), new AccountsReader(fs), new PersistenceReader(fs), new ProcessesReader(fs),
		)
		const service = new SecurityAuditService(fs, new OsReleaseParser(), [debian])
		service.configure({ securityAudit: true })
		return service
	}

	const reportOf = (result: SecurityAudit.Result): SecurityAudit.Report => {
		if (result.status !== 'ok' && result.status !== 'partial') throw new Error(`no report: ${JSON.stringify(result)}`)
		return result.report
	}

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'enver-audit-'))
		mockConfig.securityAudit.stateDir = null
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	describe('refusals', () => {
		it.each([[{}], [{ securityAudit: false }]])('refuses while the settings %j don\'t turn it on', async (settings) => {
			const runner = makeRunner('debian-12')
			const service = makeService(await host('debian-12'), runner)
			service.configure(settings)

			await expect(service.run({ queryId: 'q', cursor: null }, NOW)).resolves.toEqual({ status: 'refused', reason: SecurityAudit.RefusalReason.disabled })
			expect(runner.run).not.toHaveBeenCalled()
		})

		it.each(['$(reboot)', 's=1;i=2', `auth-log:1:${'9'.repeat(30)}`])('refuses the cursor %s', async (cursor) => {
			const service = makeService(await host('debian-12'), makeRunner('debian-12'))
			await expect(service.run({ queryId: 'q', cursor }, NOW)).resolves.toEqual({ status: 'refused', reason: SecurityAudit.RefusalReason.invalidCursor })
		})

		it('runs one audit at a time', async () => {
			const service = makeService(await host('debian-12'), makeRunner('debian-12'))
			const [first, second] = await Promise.all([service.run({ queryId: 'a', cursor: null }, NOW), service.run({ queryId: 'b', cursor: null }, NOW)])
			expect(first.status).toBe('partial')
			expect(second).toEqual({ status: 'refused', reason: SecurityAudit.RefusalReason.busy })
		})
	})

	describe('unsupported hosts', () => {
		it('names the distribution it doesn\'t support', async () => {
			await mkdir(join(root, 'etc'), { recursive: true })
			await writeFile(join(root, 'etc/os-release'), 'NAME="Rocky Linux"\nID="rocky"\nVERSION_ID="9.4"\n')
			const runner = makeRunner('debian-12')
			const service = makeService(new HostFs(root), runner)

			await expect(service.run({ queryId: 'q', cursor: null }, NOW)).resolves.toEqual({ status: 'unsupported', platform: process.platform, osId: 'rocky', osVersionId: '9.4' })
			expect(runner.run).not.toHaveBeenCalled()
		})

		it('Debian 10 is too old', async () => {
			await mkdir(join(root, 'etc'), { recursive: true })
			await writeFile(join(root, 'etc/os-release'), 'ID=debian\nVERSION_ID="10"\n')
			const result = await makeService(new HostFs(root), makeRunner('debian-12')).run({ queryId: 'q', cursor: null }, NOW)
			expect(result).toEqual(expect.objectContaining({ status: 'unsupported', osId: 'debian', osVersionId: '10' }))
		})

		it('macOS', async () => {
			const platform = Object.getOwnPropertyDescriptor(process, 'platform')
			Object.defineProperty(process, 'platform', { value: 'darwin' })
			try {
				const result = await makeService(await host('debian-12'), makeRunner('debian-12')).run({ queryId: 'q', cursor: null }, NOW)
				expect(result).toEqual(expect.objectContaining({ status: 'unsupported', platform: 'darwin' }))
			} finally {
				if (platform) Object.defineProperty(process, 'platform', platform)
			}
		})
	})

	describe('Debian 12', () => {
		it('reports every section and the missing groups', async () => {
			const runner = makeRunner('debian-12')
			const result = await makeService(await host('debian-12'), runner).run({ queryId: 'q', cursor: null }, NOW)

			expect(result.status).toBe('partial')
			const report = reportOf(result)
			expect(report.family).toBe(SecurityAudit.DistroFamily.debian)
			expect(report.errors).toEqual([])
			expect(report.os).toEqual(expect.objectContaining({
				id: 'debian',
				versionId: '12',
				codename: 'bookworm',
				rebootRequired: { required: false, since: null, packages: [] },
				unattendedUpgrades: { installed: true, enabled: null, updatePackageLists: null },
			}))
			expect(report.ssh).toEqual(expect.objectContaining({
				installed: true,
				version: '1:9.2p1-2+deb12u7',
				socketActivated: false,
				fail2ban: { installed: true, active: true },
				crowdsec: { installed: false, active: false },
			}))
			expect(report.ssh?.config).toEqual(expect.objectContaining({ passwordAuthentication: 'no', ports: [22], weakAlgorithms: ['aes128-cbc', '3des-cbc', 'hmac-md5'] }))
			expect(report.logins).toEqual(expect.objectContaining({
				source: SecurityAudit.LoginSource.journal,
				windowStart: '2026-10-30T12:00:00.000Z',
				journal: { persistent: true, firstEntryAt: '2026-10-24T08:00:00.000Z' },
				successfulTotal: 2,
				truncated: false,
			}))
			expect(report.logins?.cursor).toMatch(SecurityAudit.JOURNAL_CURSOR_REGEX)
			expect(report.updates?.counts).toEqual({ security: 3, esmInfra: 0, esmApps: 0, regular: 1 })
			expect(report.ports).toEqual({ listening: [22, 80, 6379] })
			expect(report.accounts).toEqual({
				accounts: [
					{ name: 'root', uid: 0, loginShell: true },
					{ name: 'deploy', uid: 1000, loginShell: true },
					{ name: 'alice', uid: 1001, loginShell: true },
					{ name: 'postgres', uid: 105, loginShell: true },
				],
				groups: [{ name: 'sudo', members: ['deploy'] }, { name: 'docker', members: [] }],
			})
			expect(report.persistence?.ldSoPreload).toBe(false)
			expect(report.persistence?.files).toHaveLength(6)
			expect(report.persistence?.files.every((f) => f.hash && SecurityAudit.HASH_REGEX.test(f.hash))).toBe(true)
			expect(report.processes).toEqual({ scanned: 1, exeUnreadable: 1, suspicious: [] })
			expect(report.sudo).toEqual({ authFailures: 3, notInSudoers: 1, topUsernames: [{ username: 'alice', count: 3 }, { username: 'mallory', count: 1 }] })
			expect(report.firewall).toEqual({ ufw: { installed: false, enabled: null } })
			expect(report.permissions).toEqual({
				missingGroups: ['adm', 'systemd-journal'],
				readable: { journal: true, authLog: null, sshdConfig: true },
				unreadableFiles: [],
				stateDirectory: false,
			})
			expect(runner.run).toHaveBeenCalledWith(SecurityAuditTypes.Program.journalctl, expect.arrayContaining(['--since', '2026-10-30 12:00:00', 'SYSLOG_IDENTIFIER=sshd', 'SYSLOG_IDENTIFIER=sshd-session', 'SYSLOG_IDENTIFIER=sudo']), SecurityAuditTypes.JOURNAL_COMMAND)
			expect(runner.run).toHaveBeenCalledWith(SecurityAuditTypes.Program.aptGet, ['-s', '-o', 'Debug::NoLocking=true', 'dist-upgrade'], SecurityAuditTypes.APT_COMMAND)
		})

		it('is ok with the groups and a state directory, and tells new sources from the second run on', async () => {
			const gids = process.getgroups?.() ?? []
			const fs = await host('debian-12', { groups: `adm:x:${gids[0]}:\nsystemd-journal:x:${gids[0]}:\n` })
			mockConfig.securityAudit.stateDir = join(root, 'state')
			await mkdir(mockConfig.securityAudit.stateDir)
			const runner = makeRunner('debian-12')
			const service = makeService(fs, runner)

			const first = reportOf(await service.run({ queryId: 'q', cursor: null }, NOW))
			expect(first.permissions).toEqual(expect.objectContaining({ missingGroups: [], stateDirectory: true }))
			expect(first.logins?.successful.map((l) => l.newSource)).toEqual([null, null])

			const cursor = first.logins?.cursor ?? null
			const second = await service.run({ queryId: 'q', cursor }, NOW)
			expect(second.status).toBe('ok')
			expect(reportOf(second).logins?.successful.map((l) => l.newSource)).toEqual([false, false])
			expect(reportOf(second).logins?.windowStart).toBeNull()
			expect(runner.run).toHaveBeenCalledWith(SecurityAuditTypes.Program.journalctl, expect.arrayContaining(['--after-cursor', cursor]), SecurityAuditTypes.JOURNAL_COMMAND)
		})

		it('keeps the other sections when one fails', async () => {
			const runner = makeRunner('debian-12', { apt: { stdout: '', exitCode: 100, truncated: false } })
			const report = reportOf(await makeService(await host('debian-12'), runner).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.updates).toBeNull()
			expect(report.errors).toEqual([{ section: SecurityAudit.Section.updates, message: 'apt-get -s dist-upgrade exited with 100' }])
			expect(report.ssh).not.toBeNull()
		})

		it('cuts the report to the protocol limits', async () => {
			const long = 'u'.repeat(200)
			const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({
				__CURSOR: `s=4f1c0e8f9b2a4d6e8c0b1a2f3e4d5c6b;i=${i.toString(16)};b=fe9b92823e0b1b17c9799c8835c75d6f;m=1;t=1;x=1`,
				__REALTIME_TIMESTAMP: String((NOW.getTime() - 3_600_000 + i * 1000) * 1000),
				SYSLOG_IDENTIFIER: 'sshd',
				SYSLOG_PID: String(i),
				MESSAGE: `Accepted publickey for ${long} from 192.0.2.${i % 250} port 1 ssh2`,
			}))
			const runner = makeRunner('debian-12', { journal: ok(lines.join('\n')) })
			const logins = reportOf(await makeService(await host('debian-12'), runner).run({ queryId: 'q', cursor: null }, NOW)).logins

			expect(logins?.successfulTotal).toBe(600)
			expect(logins?.successful).toHaveLength(SecurityAudit.LIMITS.logins)
			expect(logins?.successful[0].username).toHaveLength(SecurityAudit.LIMITS.shortString)
		})

		it('marks a run that hit the output limit as truncated, continuing from its last whole entry', async () => {
			const stdout = readFileSync(join(FIXTURES, 'debian-12', 'journal.json'), 'utf8')
			const cut = stdout.slice(0, stdout.lastIndexOf('\n', stdout.length - 2) + 40)
			const runner = makeRunner('debian-12', { journal: { stdout: cut, exitCode: null, truncated: true } })
			const logins = reportOf(await makeService(await host('debian-12'), runner).run({ queryId: 'q', cursor: null }, NOW)).logins

			const lines = stdout.trim().split('\n')
			expect(logins?.truncated).toBe(true)
			expect(logins?.cursor).toBe((JSON.parse(lines[lines.length - 2]) as { __CURSOR: string }).__CURSOR)
		})
	})

	describe('Debian 11 without access to the journal', () => {
		it('reads /var/log/auth.log', async () => {
			const fs = await host('debian-11', { journal: false })
			const report = reportOf(await makeService(fs, makeRunner('debian-11')).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.logins).toEqual(expect.objectContaining({ source: SecurityAudit.LoginSource.authLog, journal: null, successfulTotal: 2 }))
			expect(report.logins?.cursor).toMatch(SecurityAudit.AUTH_LOG_CURSOR_REGEX)
			expect(report.permissions.readable).toEqual({ journal: false, authLog: true, sshdConfig: true })
			expect(report.ssh?.config).toEqual(expect.objectContaining({ ports: [2222], permitRootLogin: 'yes', hasMatchBlocks: true }))
		})

		it('reports the logins and sudo sections as unavailable when neither is readable', async () => {
			const fs = await host('debian-12', { journal: false })
			const report = reportOf(await makeService(fs, makeRunner('debian-12')).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.logins).toBeNull()
			expect(report.sudo).toBeNull()
			expect(report.errors).toEqual([expect.objectContaining({ section: SecurityAudit.Section.logins }), expect.objectContaining({ section: SecurityAudit.Section.sudo })])
		})

		it('reads sudo\'s failures from the auth log too, and reports missing /proc files as errors of their sections', async () => {
			const report = reportOf(await makeService(await host('debian-11', { journal: false }), makeRunner('debian-11')).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.sudo).toEqual(expect.objectContaining({ authFailures: 3, notInSudoers: 1 }))
			expect(report.ports).toBeNull()
			expect(report.processes).toBeNull()
			expect(report.errors.map((e) => e.section)).toEqual([SecurityAudit.Section.ports, SecurityAudit.Section.processes])
			expect(report.persistence).toEqual({ ldSoPreload: false, files: [] })
		})
	})

	describe('Ubuntu 24.04 with socket activation', () => {
		it('takes the ports from ssh.socket', async () => {
			const runner = makeRunner('ubuntu-24.04', { active: { stdout: 'active\ninactive\ninactive\n', exitCode: 3, truncated: false }, enabled: ok('enabled\n') })
			const report = reportOf(await makeService(await host('ubuntu-24.04'), runner).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.ssh).toEqual(expect.objectContaining({ socketActivated: true }))
			expect(report.ssh?.config).toEqual(expect.objectContaining({ ports: [2222], permitEmptyPasswords: 'yes' }))
			expect(report.updates?.counts).toEqual({ security: 1, esmInfra: 0, esmApps: 0, regular: 1 })
			expect(report.ports).toEqual({ listening: [443, 2222, 2375] })
			expect(report.firewall).toEqual({ ufw: { installed: true, enabled: true } })
			expect(report.persistence?.files).toEqual([])
		})
	})

	describe('installed packages', () => {
		it('sends the list with its hash while the api holds another one', async () => {
			const report = reportOf(await makeService(await host('debian-12'), makeRunner('debian-12')).run({ queryId: 'q', cursor: null }, NOW))

			expect(report.packages?.hash).toMatch(SecurityAudit.HASH_REGEX)
			expect(report.packages?.count).toBe(12)
			expect(report.packages?.list?.map((p) => `${p.name}:${p.arch}`)).toEqual([
				'adduser:all', 'base-files:amd64', 'libc6:amd64', 'libgcc-s1:amd64', 'libgcc-s1:i386', 'libpam-modules:amd64', 'libssl3:amd64',
				'linux-image-6.1.0-40-amd64:amd64', 'openssh-server:amd64', 'openssl:amd64', 'tzdata:all', 'zlib1g:amd64',
			])
			expect(report.packages?.list).toContainEqual({ name: 'linux-image-6.1.0-40-amd64', version: '6.1.153-1', arch: 'amd64', source: 'linux-signed-amd64', sourceVersion: '6.1.153+1' })
			expect(report.packages?.list).toContainEqual({ name: 'openssl', version: '3.0.17-1~deb12u2', arch: 'amd64', source: null, sourceVersion: null })
		})

		it('leaves the list out when the api already holds it, and sends it for a hash it can\'t use', async () => {
			const service = makeService(await host('debian-12'), makeRunner('debian-12'))
			const first = reportOf(await service.run({ queryId: 'a', cursor: null }, NOW)).packages
			const hash = first?.hash ?? ''

			const same = reportOf(await service.run({ queryId: 'b', cursor: null, packagesHash: hash }, NOW)).packages
			expect(same).toEqual({ hash, count: 12, list: null })

			const other = reportOf(await service.run({ queryId: 'c', cursor: null, packagesHash: '$(reboot)' }, NOW)).packages
			expect(other?.list).toHaveLength(12)
		})

		it('a failing dpkg-query fails only its section', async () => {
			const runner = makeRunner('debian-12', { installed: { stdout: '', exitCode: 2, truncated: false } })
			const report = reportOf(await makeService(await host('debian-12'), runner).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.packages).toBeNull()
			expect(report.errors).toEqual([{ section: SecurityAudit.Section.packages, message: 'dpkg-query exited with 2' }])
		})
	})

	describe('Ubuntu 22.04', () => {
		it('lists esm-apps apart and reads a pending reboot', async () => {
			const fs = await host('ubuntu-22.04')
			await mkdir(join(root, 'var/run'), { recursive: true })
			await writeFile(join(root, 'var/run/reboot-required'), '*** System restart required ***\n')
			await writeFile(join(root, 'var/run/reboot-required.pkgs'), 'linux-image-5.15.0-130-generic\nlibc6\nlibc6\n')
			await mkdir(join(root, 'boot'))
			await writeFile(join(root, 'boot/vmlinuz-0.0.1-1-generic'), '')
			await writeFile(join(root, 'boot/vmlinuz-999.0.0-1-generic'), '')
			await mkdir(join(root, 'etc/apt/apt.conf.d'), { recursive: true })
			await writeFile(join(root, 'etc/apt/apt.conf.d/20auto-upgrades'), 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n')

			const report = reportOf(await makeService(fs, makeRunner('ubuntu-22.04')).run({ queryId: 'q', cursor: null }, NOW))
			expect(report.updates?.counts).toEqual({ security: 2, esmInfra: 0, esmApps: 2, regular: 1 })
			expect(report.os?.rebootRequired).toEqual(expect.objectContaining({ required: true, packages: ['linux-image-5.15.0-130-generic', 'libc6'] }))
			expect(report.os?.kernel).toEqual(expect.objectContaining({ newestInstalled: '999.0.0-1-generic', rebootNeeded: true }))
			expect(report.os?.unattendedUpgrades).toEqual({ installed: true, enabled: true, updatePackageLists: true })
		})
	})
})
