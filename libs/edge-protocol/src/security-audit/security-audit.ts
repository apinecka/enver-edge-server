/** The host security audit an edge server runs on request (`security.audit` job) and reports back
 *  (`security.audit.response`). Only Linux hosts of a supported distribution family are audited; the
 *  agent stays unprivileged and reads only what its groups allow, so every section may be partial.
 *  IP addresses never leave the host: logins carry only whether their source is new or followed
 *  failures. The api treats the report as untrusted input and enforces `LIMITS` itself. */
export namespace SecurityAudit {
	/** A systemd journal cursor (`__CURSOR`). */
	export const JOURNAL_CURSOR_REGEX = /^s=[0-9a-f]{32};i=[0-9a-f]{1,16};b=[0-9a-f]{32};m=[0-9a-f]{1,16};t=[0-9a-f]{1,16};x=[0-9a-f]{1,16}$/
	/** A position in `/var/log/auth.log` (`auth-log:<inode>:<byte offset>`), for hosts without a readable journal. */
	export const AUTH_LOG_CURSOR_REGEX = /^auth-log:[0-9]{1,20}:[0-9]{1,20}$/
	export const CURSOR_MAX_LENGTH = 256

	/** Without a cursor (the first run, or one the agent can't use) the logins of this many hours are read. */
	export const INITIAL_WINDOW_HOURS = 24

	/** Groups the agent's user needs: `adm` reads `/var/log/auth.log`, `systemd-journal` the journal.
	 *  Never `docker`, although it would reach everything through a container: that would bypass the
	 *  rule that the agent touches only what it labelled as its own. */
	export const REQUIRED_GROUPS = ['adm', 'systemd-journal'] as const

	export const LIMITS = {
		logins: 500,
		topUsernames: 10,
		packages: 500,
		rebootPackages: 50,
		listItems: 50,
		ports: 16,
		listeningPorts: 256,
		accounts: 100,
		groupMembers: 100,
		persistenceFiles: 500,
		processes: 50,
		/** Installed packages in the `packages` section; a host with more sends the first ones by name. */
		installedPackages: 10_000,
		unreadableFiles: 20,
		errors: 20,
		shortString: 64,
		string: 256,
	} as const

	export function isValidCursor(cursor: unknown): cursor is string {
		return typeof cursor === 'string' && cursor.length <= CURSOR_MAX_LENGTH
			&& (JOURNAL_CURSOR_REGEX.test(cursor) || AUTH_LOG_CURSOR_REGEX.test(cursor))
	}

	export enum DistroFamily {
		debian = 'debian',
	}

	export enum RefusalReason {
		/** `securityAudit` isn't on in the edge server's settings (or the api didn't send it). */
		disabled = 'disabled',
		invalidCursor = 'invalid_cursor',
		/** Another audit still runs. */
		busy = 'busy',
	}

	export enum LoginMethod {
		key = 'key',
		password = 'password',
		other = 'other',
	}

	export enum LoginSource {
		journal = 'journal',
		authLog = 'auth-log',
	}

	export enum Section {
		os = 'os',
		ssh = 'ssh',
		logins = 'logins',
		updates = 'updates',
		ports = 'ports',
		accounts = 'accounts',
		persistence = 'persistence',
		processes = 'processes',
		sudo = 'sudo',
		firewall = 'firewall',
		packages = 'packages',
	}

	/** Groups whose members can become root: `sudo`/`admin`/`wheel` through sudo, `docker` through the
	 *  Docker socket. */
	export const PRIVILEGED_GROUPS = ['sudo', 'admin', 'wheel', 'docker'] as const

	/** Directories anyone may write to; a program started from one is a typical sign of a break-in. */
	export const TEMP_DIRS = ['/tmp', '/dev/shm', '/var/tmp'] as const

	/** HMAC-SHA256 in hex. */
	export const HASH_REGEX = /^[0-9a-f]{64}$/

	export interface JobPayload {
		queryId: string
		/** The `logins.cursor` of the previous report, `null` on the first run. */
		cursor: string | null
		/** The `packages.hash` of the list the api holds. The agent sends the list only when its own hash
		 *  differs; absent (an older api) or null asks for it. */
		packagesHash?: string | null
	}

	export interface OsSection {
		/** `ID` and `VERSION_ID` from `/etc/os-release`. */
		id: string
		versionId: string | null
		prettyName: string | null
		codename: string | null
		kernel: {
			running: string
			/** The newest kernel in `/boot`; a newer one than `running` needs a reboot. */
			newestInstalled: string | null
			rebootNeeded: boolean | null
		}
		/** `/var/run/reboot-required` (Ubuntu, and Debian with `needrestart`/`unattended-upgrades`). */
		rebootRequired: {
			required: boolean
			/** Its mtime. */
			since: string | null
			packages: string[]
		}
		unattendedUpgrades: {
			installed: boolean
			/** `APT::Periodic::Unattended-Upgrade` (`/etc/apt/apt.conf.d`, `20auto-upgrades`); null when unset. */
			enabled: boolean | null
			updatePackageLists: boolean | null
		}
	}

	export interface ServicePresence {
		installed: boolean
		active: boolean | null
	}

	export interface SshSection {
		/** `openssh-server` per dpkg; the rest is null without it. */
		installed: boolean
		version: string | null
		/** Effective values: what the config sets (first occurrence wins, as in sshd), or OpenSSH's
		 *  default. Values are lower-case as sshd matches them. */
		config: {
			permitRootLogin: string
			passwordAuthentication: string
			kbdInteractiveAuthentication: string
			pubkeyAuthentication: string
			permitEmptyPasswords: string
			maxAuthTries: number
			x11Forwarding: string
			allowUsers: string[]
			allowGroups: string[]
			/** From `ssh.socket` when socket activation is on, from `Port` otherwise. */
			ports: number[]
			/** Weak algorithms the config explicitly enables in `Ciphers`, `KexAlgorithms` or `MACs`. */
			weakAlgorithms: string[]
			/** `Match` blocks may override the values above for some connections; they are not evaluated. */
			hasMatchBlocks: boolean
		} | null
		/** `ssh.socket` is enabled or active: systemd listens and starts sshd per connection. */
		socketActivated: boolean | null
		fail2ban: ServicePresence
		crowdsec: ServicePresence
	}

	export interface Login {
		at: string
		username: string
		method: LoginMethod
		/** The source never logged in successfully before (90 days); null when the agent can't tell
		 *  (no state directory, or the first run, which only learns). */
		newSource: boolean | null
		/** The source failed at least `AFTER_FAILURES_THRESHOLD` times in the 24 h before. */
		afterFailures: boolean
	}

	export interface LoginsSection {
		source: LoginSource | null
		/** Where the next run continues; pass it back in the next job. */
		cursor: string | null
		/** Set when the run read a window by time (no usable cursor): the start of that window. */
		windowStart: string | null
		/** The oldest entry the journal still holds, and whether it survives a reboot. A volatile journal
		 *  after a restart means the logins before that time are unknown, not absent. */
		journal: { persistent: boolean; firstEntryAt: string | null } | null
		successful: Login[]
		successfulTotal: number
		failures: {
			total: number
			existingUsers: number
			nonExistingUsers: number
			/** Number of distinct source addresses; the addresses themselves stay on the host. */
			distinctSources: number
			topUsernames: { username: string; count: number }[]
		}
		/** The run hit the output limit; the cursor continues where it stopped. */
		truncated: boolean
	}

	export interface PackageUpdate {
		name: string
		installedVersion: string | null
		candidateVersion: string
	}

	export interface UpdatesSection {
		/** From a `*-security` suite. */
		security: PackageUpdate[]
		/** Ubuntu Pro: `esm-infra` and `esm-apps`. */
		esmInfra: PackageUpdate[]
		esmApps: PackageUpdate[]
		regular: PackageUpdate[]
		/** Before `LIMITS.packages` cut the lists. */
		counts: { security: number; esmInfra: number; esmApps: number; regular: number }
		/** When the package lists were last refreshed. */
		cacheUpdatedAt: string | null
	}

	export interface PermissionsSection {
		/** Of `REQUIRED_GROUPS`, the ones the agent's process doesn't have (a group added later
		 *  applies after the service restarts). */
		missingGroups: string[]
		readable: {
			journal: boolean
			/** null: the host has no `/var/log/auth.log`. */
			authLog: boolean | null
			sshdConfig: boolean
		}
		/** sshd config files that couldn't be read (e.g. a root-only `50-cloud-init.conf`). */
		unreadableFiles: string[]
		/** `StateDirectory=` of the systemd unit; without it (a unit from an older package) new sources can't be told. */
		stateDirectory: boolean
	}

	/** TCP sockets listening on every address (`0.0.0.0` or `::`) per `/proc/net/tcp` and `tcp6`. Sockets
	 *  bound to one address, loopback included, aren't reported. */
	export interface PortsSection {
		/** Sorted, each once. */
		listening: number[]
	}

	export interface Account {
		name: string
		uid: number
		/** Its shell lets it log in (not `nologin`, `false` and the like). */
		loginShell: boolean
	}

	/** From `/etc/passwd` and `/etc/group`, only the accounts that can matter - never the whole list of
	 *  system accounts. */
	export interface AccountsSection {
		/** Accounts with UID 0, a login shell or a membership in a privileged group. */
		accounts: Account[]
		/** The `PRIVILEGED_GROUPS` the host has, with their members (primary group included). */
		groups: { name: string; members: string[] }[]
	}

	export interface PersistenceFile {
		path: string
		/** HMAC-SHA256 of the content keyed with the host's machine id, so it shows a change but can't be
		 *  matched against guessed contents; null when the file can't be read or the host has no machine id. */
		hash: string | null
	}

	/** Places a program can make itself start from again: names and hashes only, never the contents. */
	export interface PersistenceSection {
		/** `/etc/ld.so.preload` exists and isn't empty: every program then loads the libraries it names. */
		ldSoPreload: boolean
		/** `/etc/crontab`, `/etc/cron.d/*`, `/etc/cron.{hourly,daily,weekly,monthly,yearly}/*`,
		 *  `/etc/systemd/system/*.service|*.timer` and `/etc/rc.local`, sorted by path. */
		files: PersistenceFile[]
	}

	export interface SuspiciousProcess {
		/** Its `comm` (at most 15 characters). The command line is matched on the host only, since it can
		 *  hold passwords. */
		name: string
		/** The id of the known miner it matched, if any. */
		signature: string | null
		/** Of `TEMP_DIRS`, the one it was started from, if any. */
		location: string | null
	}

	export interface ProcessesSection {
		scanned: number
		/** Processes of other users, whose executable the agent may not resolve; their name and command
		 *  line were still checked. */
		exeUnreadable: number
		suspicious: SuspiciousProcess[]
	}

	/** sudo's failures since the previous run, from the same journal or auth log as the logins. */
	export interface SudoSection {
		/** Wrong passwords (`pam_unix(sudo:auth): authentication failure`). */
		authFailures: number
		/** Attempts by users who may not use sudo. */
		notInSudoers: number
		topUsernames: { username: string; count: number }[]
	}

	export interface FirewallSection {
		/** `ENABLED` of `/etc/ufw/ufw.conf`; `installed` false without the file, `enabled` null when unreadable. */
		ufw: { installed: boolean; enabled: boolean | null }
	}

	/** An installed package as dpkg knows it - names and versions only, nothing about the host's users. */
	export interface InstalledPackage {
		name: string
		version: string
		arch: string
		/** The source package it was built from, when it differs from `name`/`version`; vulnerability
		 *  databases track source packages. */
		source: string | null
		sourceVersion: string | null
	}

	/** The installed packages, which the api's workers scan for known vulnerabilities. The list is sent
	 *  only when it changed (`JobPayload.packagesHash`). */
	export interface PackagesSection {
		/** SHA-256 (hex) of the list, sorted by name and architecture and cut to `LIMITS.installedPackages`. */
		hash: string
		/** Installed packages before the cut. */
		count: number
		/** Null when the api already holds the list with this hash. */
		list: InstalledPackage[] | null
	}

	export interface Report {
		family: DistroFamily
		collectedAt: string
		/** Null when the section failed; its error is in `errors`. */
		os: OsSection | null
		ssh: SshSection | null
		logins: LoginsSection | null
		updates: UpdatesSection | null
		/** Sections added in later agents are optional: an older agent leaves them out, which means "not
		 *  collected" (and gives the api no baseline), while null means the section failed. */
		ports?: PortsSection | null
		accounts?: AccountsSection | null
		persistence?: PersistenceSection | null
		processes?: ProcessesSection | null
		sudo?: SudoSection | null
		firewall?: FirewallSection | null
		packages?: PackagesSection | null
		permissions: PermissionsSection
		errors: { section: Section; message: string }[]
	}

	export type Result =
		| { status: 'ok' | 'partial'; report: Report }
		| { status: 'unsupported'; platform: string; osId: string | null; osVersionId: string | null }
		| { status: 'refused'; reason: RefusalReason }

	export const AFTER_FAILURES_THRESHOLD = 5
	export const AFTER_FAILURES_WINDOW_HOURS = 24
	export const KNOWN_SOURCE_DAYS = 90
}
