import { SecurityAudit } from '@enver/edge-protocol'

import type { KnownSources } from './known-sources'

export namespace SecurityAuditTypes {
	/** Every command the audit may run: fixed read-only programs, started without a shell. */
	export enum Program {
		aptGet = 'apt-get',
		dpkgQuery = 'dpkg-query',
		journalctl = 'journalctl',
		systemctl = 'systemctl',
	}

	/** Absolute paths only, never `PATH`; `/bin` for a Debian 11 without merged `/usr`. */
	export const PROGRAM_DIRS = ['/usr/bin', '/bin']

	export interface CommandOptions {
		timeoutMs: number
		maxBytes: number
	}

	export interface CommandResult {
		stdout: string
		exitCode: number | null
		/** The output hit `maxBytes`; `stdout` holds what came before. */
		truncated: boolean
	}

	export const COMMAND_DEFAULTS: CommandOptions = { timeoutMs: 30_000, maxBytes: 1024 * 1024 }
	export const JOURNAL_COMMAND: CommandOptions = { timeoutMs: 60_000, maxBytes: 16 * 1024 * 1024 }
	export const APT_COMMAND: CommandOptions = { timeoutMs: 120_000, maxBytes: 4 * 1024 * 1024 }
	/** Every installed package: about 100 bytes each, `SecurityAudit.LIMITS.installedPackages` of them fit. */
	export const DPKG_LIST_COMMAND: CommandOptions = { timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024 }
	/** Of `/var/log/auth.log`, read per run. */
	export const AUTH_LOG_MAX_BYTES = 16 * 1024 * 1024
	export const MAX_FILE_BYTES = 1024 * 1024

	export const SSH_IDENTIFIERS = ['sshd', 'sshd-session', 'sshd-auth'] as const
	export const SSHD_CONFIG = '/etc/ssh/sshd_config'
	export const SSHD_INCLUDE_DEPTH = 16
	export const SSH_SOCKET_DROP_INS = ['/run/systemd/generator/ssh.socket.d/addresses.conf', '/etc/systemd/system/ssh.socket.d']
	export const SSH_SOCKET_UNITS = ['/etc/systemd/system/ssh.socket', '/usr/lib/systemd/system/ssh.socket', '/lib/systemd/system/ssh.socket']
	export const OS_RELEASE = ['/etc/os-release', '/usr/lib/os-release']
	export const AUTH_LOG = '/var/log/auth.log'
	export const JOURNAL_DIRS = ['/var/log/journal', '/run/log/journal']
	export const REBOOT_REQUIRED = '/var/run/reboot-required'
	export const REBOOT_REQUIRED_PKGS = '/var/run/reboot-required.pkgs'
	export const APT_CONF_DIR = '/etc/apt/apt.conf.d'
	export const APT_UPDATE_STAMP = '/var/lib/apt/periodic/update-success-stamp'
	export const APT_LISTS = '/var/lib/apt/lists'
	export const BOOT_DIR = '/boot'
	export const GROUP_FILE = '/etc/group'
	export const PASSWD_FILE = '/etc/passwd'
	/** A shell that doesn't let the account log in. */
	export const NO_LOGIN_SHELL = /(^|\/)(nologin|false|sync|halt|shutdown)$/
	export const PROC_DIR = '/proc'
	export const PROC_NET_TCP = ['/proc/net/tcp', '/proc/net/tcp6'] as const
	export const PROC_NET_MAX_BYTES = 4 * 1024 * 1024
	/** `st` of a listening socket in `/proc/net/tcp`. */
	export const TCP_LISTEN = '0A'
	export const CMDLINE_MAX_BYTES = 4096
	/** Processes looked at per run; a host with more is cut, not refused. */
	export const MAX_PROCESSES = 10_000
	export const UFW_CONF = '/etc/ufw/ufw.conf'
	export const LD_SO_PRELOAD = '/etc/ld.so.preload'
	/** The key of the persistence hashes: stable per host, never sent. */
	export const MACHINE_ID = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const
	export const PERSISTENCE_FILES = ['/etc/crontab', '/etc/rc.local'] as const
	/** Directories whose files (with one of the suffixes, when given) are listed; not recursively. */
	export const PERSISTENCE_DIRS: readonly { dir: string; suffixes: readonly string[] | null }[] = [
		{ dir: '/etc/cron.d', suffixes: null },
		{ dir: '/etc/cron.hourly', suffixes: null },
		{ dir: '/etc/cron.daily', suffixes: null },
		{ dir: '/etc/cron.weekly', suffixes: null },
		{ dir: '/etc/cron.monthly', suffixes: null },
		{ dir: '/etc/cron.yearly', suffixes: null },
		{ dir: '/etc/systemd/system', suffixes: ['.service', '.timer'] },
	]

	/** A known cryptocurrency miner. `names` match a process's `comm` or the file name of its first
	 *  argument exactly; `cmdline` the whole command line, which never leaves the host. */
	export interface MinerSignature {
		id: string
		names?: readonly string[]
		cmdline?: RegExp
	}

	export const MINER_SIGNATURES: readonly MinerSignature[] = [
		{ id: 'xmrig', names: ['xmrig', 'xmrig-notls', 'xmrig-cuda', 'xmrig-proxy'] },
		{ id: 'kinsing', names: ['kinsing'] },
		{ id: 'kdevtmpfsi', names: ['kdevtmpfsi'] },
		{ id: 'xmr-stak', names: ['xmr-stak', 'xmr-stak-rx', 'xmr-stak-cpu'] },
		{ id: 'cpuminer', names: ['minerd', 'cpuminer', 'cpuminer-multi', 'cpuminer-opt', 'cpuminer-gr'] },
		{ id: 'gpu-miner', names: ['ethminer', 'nbminer', 'lolminer', 't-rex', 'phoenixminer', 'nanominer', 'srbminer-multi', 'teamredminer', 'gminer'] },
		/** Miners named like kernel threads or system daemons (Kinsing, WatchDog, TeamTNT). */
		{ id: 'disguised', names: ['kthreaddi', 'kthreaddk', 'kworkerds', 'sysupdate', 'dbused', 'sysguard', 'networkservice', 'khugepageds'] },
		{ id: 'stratum', cmdline: /stratum\+(tcp|ssl|tls):\/\//i },
		{ id: 'mining-pool', cmdline: /\b(supportxmr|moneroocean|c3pool|nanopool|hashvault|minexmr|xmrpool|herominers|2miners)\.(com|net|org|pro|stream)\b/i },
		{ id: 'miner-options', cmdline: /\s--(donate-level|randomx-mode|cpu-max-threads-hint|coin=monero)\b/i },
	]

	export const SUDO_IDENTIFIER = 'sudo'

	export enum SudoEventKind {
		authFailure = 'auth-failure',
		notInSudoers = 'not-in-sudoers',
	}

	export interface SudoEvent {
		kind: SudoEventKind
		username: string | null
	}

	/** What one read of the journal or the auth log gives: sshd's logins and sudo's failures. */
	export interface AuthEvents {
		logins: SecurityAudit.LoginsSection
		sudo: SecurityAudit.SudoSection
	}
	export const KNOWN_SOURCES_FILE = 'security-audit-sources.json'
	/** Sources that only failed are kept for the after-failures window; beyond this many the oldest go. */
	export const MAX_FAILING_SOURCES = 20_000

	/** OpenSSH's built-in values for the keywords the report carries. */
	export const SSHD_DEFAULTS = {
		permitrootlogin: 'prohibit-password',
		passwordauthentication: 'yes',
		kbdinteractiveauthentication: 'yes',
		pubkeyauthentication: 'yes',
		permitemptypasswords: 'no',
		maxauthtries: '6',
		x11forwarding: 'no',
	} as const

	/** Keywords sshd accumulates over every occurrence instead of keeping the first. */
	export const SSHD_ACCUMULATING = ['port', 'allowusers', 'allowgroups'] as const

	export const WEAK_ALGORITHMS: Record<'ciphers' | 'kexalgorithms' | 'macs', RegExp> = {
		ciphers: /(-cbc$|^arcfour|^3des|^blowfish|^cast128|^rijndael-cbc)/,
		kexalgorithms: /^(diffie-hellman-group1-sha1|diffie-hellman-group14-sha1|diffie-hellman-group-exchange-sha1|gss-.*-sha1-.*)$/,
		macs: /^(hmac-md5|hmac-sha1-96|hmac-md5-96|umac-64|hmac-ripemd160)/,
	}

	export interface OsRelease {
		id: string | null
		idLike: string[]
		versionId: string | null
		prettyName: string | null
		codename: string | null
	}

	export interface SshdConfig {
		/** Lower-case keyword -> raw values of the effective occurrence(s). */
		values: Map<string, string[]>
		hasMatchBlocks: boolean
		readFiles: string[]
		unreadableFiles: string[]
	}

	export enum SshEventKind {
		accepted = 'accepted',
		failed = 'failed',
		/** `Invalid user x from ...`: a connection for an account that doesn't exist. */
		invalidUser = 'invalid-user',
		/** A connection that ended before authenticating, without a `Failed` line of its own. */
		preauthClosed = 'preauth-closed',
	}

	export interface SshEvent {
		at: Date
		kind: SshEventKind
		/** Groups the lines of one connection (identifier and pid). */
		connection: string
		username: string | null
		invalidUser: boolean
		method: string | null
		/** Only in memory, never reported. */
		address: string | null
	}

	export interface LogBatch {
		events: SshEvent[]
		cursor: string | null
		truncated: boolean
	}

	/** Persisted in the state directory. Sources are salted SHA-256 hashes, never addresses. */
	export interface KnownSourcesState {
		version: 1
		salt: string
		/** Hash -> last successful login (epoch ms). */
		known: Record<string, number>
		/** Hash -> the latest failures (epoch ms), at most `AFTER_FAILURES_THRESHOLD`. */
		failures: Record<string, number[]>
	}

	/** What every distribution family shares: the journal or the auth log, and the known sources. */
	export interface CollectContext {
		os: OsRelease
		cursor: string | null
		now: Date
		sources: KnownSources
		journalReadable: boolean
		/** Null: the file doesn't exist. */
		authLogReadable: boolean | null
		/** The hash of the package list the api holds; the list is sent only when it differs. */
		packagesHash: string | null
	}

	export interface Collected {
		os: SecurityAudit.OsSection | null
		ssh: SecurityAudit.SshSection | null
		logins: SecurityAudit.LoginsSection | null
		updates: SecurityAudit.UpdatesSection | null
		ports: SecurityAudit.PortsSection | null
		accounts: SecurityAudit.AccountsSection | null
		persistence: SecurityAudit.PersistenceSection | null
		processes: SecurityAudit.ProcessesSection | null
		sudo: SecurityAudit.SudoSection | null
		firewall: SecurityAudit.FirewallSection | null
		packages: SecurityAudit.PackagesSection | null
		errors: SecurityAudit.Report['errors']
		sshdConfigReadable: boolean
		unreadableFiles: string[]
	}

	/** One per distribution family; RHEL and its kin get their own next to `DebianCollector`. */
	export interface Collector {
		family: SecurityAudit.DistroFamily
		supports(os: OsRelease): boolean
		collect(context: CollectContext): Promise<Collected>
	}

	export const COLLECTORS = Symbol('SecurityAuditCollectors')

	export class SectionUnavailableError extends Error { public code = 'section_unavailable' }
}
