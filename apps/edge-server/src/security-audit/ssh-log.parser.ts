import { Injectable } from '@nestjs/common'

import { SecurityAuditTypes } from './security-audit.types'

/** Turns sshd's log lines (journal JSON or `/var/log/auth.log`) into login events, and sudo's into its
 *  failures. Only the messages OpenSSH has written the same way since 7.x are recognised; everything else
 *  is ignored. sudo's lines name the command run, which is never kept - only the user. */
@Injectable()
export class SshLogParser {
	private readonly identifiers = new Set<string>(SecurityAuditTypes.SSH_IDENTIFIERS)

	/** `journalctl -o json` output; a cut-off last line (output limit) is dropped. */
	parseJournal(stdout: string): { events: SecurityAuditTypes.SshEvent[]; sudo: SecurityAuditTypes.SudoEvent[]; cursor: string | null } {
		const events: SecurityAuditTypes.SshEvent[] = []
		const sudo: SecurityAuditTypes.SudoEvent[] = []
		let cursor: string | null = null
		for (const line of stdout.split('\n')) {
			if (!line.trim()) continue
			let entry: Record<string, unknown>
			try {
				entry = JSON.parse(line) as Record<string, unknown>
			} catch {
				continue
			}
			if (typeof entry.__CURSOR === 'string') cursor = entry.__CURSOR
			const identifier = typeof entry.SYSLOG_IDENTIFIER === 'string' ? entry.SYSLOG_IDENTIFIER : null
			const micros = typeof entry.__REALTIME_TIMESTAMP === 'string' ? Number(entry.__REALTIME_TIMESTAMP) : NaN
			const message = this.journalMessage(entry.MESSAGE)
			if (identifier === SecurityAuditTypes.SUDO_IDENTIFIER && message !== null) {
				sudo.push(...this.parseSudoMessage(message))
				continue
			}
			if (!identifier || !this.identifiers.has(identifier) || !Number.isFinite(micros) || message === null) continue
			const pid = typeof entry.SYSLOG_PID === 'string' ? entry.SYSLOG_PID : typeof entry._PID === 'string' ? entry._PID : '?'
			const boot = typeof entry._BOOT_ID === 'string' ? entry._BOOT_ID : ''
			events.push(...this.parseMessage(message, new Date(Math.floor(micros / 1000)), `${boot}:${identifier}:${pid}`))
		}
		return { events, sudo, cursor }
	}

	/** Lines of `/var/log/auth.log`, either RFC 3339 (rsyslog's default since Debian 12 / Ubuntu 24.04)
	 *  or the traditional `Nov  1 12:00:00`, which has no year and is in the host's time zone. */
	parseAuthLog(text: string, now: Date): SecurityAuditTypes.SshEvent[] {
		return this.parseAuthLogEvents(text, now).events
	}

	/** Like `parseAuthLog`, with sudo's failures; `since` drops older lines of both. */
	parseAuthLogEvents(text: string, now: Date, since = -Infinity): { events: SecurityAuditTypes.SshEvent[]; sudo: SecurityAuditTypes.SudoEvent[] } {
		const events: SecurityAuditTypes.SshEvent[] = []
		const sudo: SecurityAuditTypes.SudoEvent[] = []
		for (const line of text.split('\n')) {
			const parsed = this.parseSyslogLine(line, now)
			if (!parsed || parsed.at.getTime() < since) continue
			if (parsed.identifier === SecurityAuditTypes.SUDO_IDENTIFIER) sudo.push(...this.parseSudoMessage(parsed.message))
			else if (this.identifiers.has(parsed.identifier)) events.push(...this.parseMessage(parsed.message, parsed.at, `${parsed.identifier}:${parsed.pid}`))
		}
		return { events, sudo }
	}

	/** A wrong password (one PAM line per attempt) or a user sudo doesn't allow. */
	parseSudoMessage(message: string): SecurityAuditTypes.SudoEvent[] {
		const repeated = /^message repeated (\d+) times: \[ ?(.*?) ?\]$/.exec(message)
		if (repeated) {
			const [event] = this.parseSudoMessage(repeated[2])
			return event ? Array.from({ length: Math.min(Number(repeated[1]), 1000) }, () => ({ ...event })) : []
		}
		const auth = /^pam_unix\(sudo(?:-i)?:auth\): authentication failure;(.*)$/.exec(message)
		if (auth) {
			const user = /\suser=(\S+)/.exec(auth[1]) ?? /\slogname=(\S+)/.exec(auth[1])
			return [{ kind: SecurityAuditTypes.SudoEventKind.authFailure, username: user?.[1] ?? null }]
		}
		const denied = /^\s*(\S+) : (?:user NOT in sudoers|user NOT authorized on host)\b/.exec(message)
		if (denied) return [{ kind: SecurityAuditTypes.SudoEventKind.notInSudoers, username: denied[1] }]
		return []
	}

	/** rsyslog folds repeated lines into `message repeated N times: [ ... ]`, which counts N times. */
	parseMessage(message: string, at: Date, connection: string): SecurityAuditTypes.SshEvent[] {
		const repeated = /^message repeated (\d+) times: \[ ?(.*?) ?\]$/.exec(message)
		if (repeated) {
			const event = this.parseSingle(repeated[2], at, connection)
			return event ? Array.from({ length: Math.min(Number(repeated[1]), 1000) }, () => ({ ...event })) : []
		}
		const event = this.parseSingle(message, at, connection)
		return event ? [event] : []
	}

	private parseSingle(message: string, at: Date, connection: string): SecurityAuditTypes.SshEvent | null {
		const base = { at, connection }
		let m = /^Accepted (\S+) for (.+?) from (\S+) port \d+/.exec(message)
		if (m) return { ...base, kind: SecurityAuditTypes.SshEventKind.accepted, method: m[1], username: m[2], invalidUser: false, address: m[3] }

		m = /^Failed (\S+) for (invalid user )?(.*?) from (\S+) port \d+/.exec(message)
		if (m) {
			if (m[1] === 'none') return null
			return { ...base, kind: SecurityAuditTypes.SshEventKind.failed, method: m[1], username: m[3], invalidUser: !!m[2], address: m[4] }
		}

		m = /^Invalid user (.*?) from (\S+)(?: port \d+)?\s*$/.exec(message)
		if (m) return { ...base, kind: SecurityAuditTypes.SshEventKind.invalidUser, method: null, username: m[1], invalidUser: true, address: m[2] }

		m = /^(?:Connection closed by|Disconnected from|Connection reset by) (invalid|authenticating) user (.*?) (\S+) port \d+.*\[preauth\]\s*$/.exec(message)
		if (m) return { ...base, kind: SecurityAuditTypes.SshEventKind.preauthClosed, method: null, username: m[2], invalidUser: m[1] === 'invalid', address: m[3] }

		return null
	}

	private parseSyslogLine(line: string, now: Date): { at: Date; identifier: string; pid: string; message: string } | null {
		const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+\S+\s+([^\s[:]+)(?:\[(\d+)\])?:\s(.*)$/.exec(line)
		if (iso) {
			const at = new Date(iso[1])
			return Number.isNaN(at.getTime()) ? null : { at, identifier: iso[2], pid: iso[3] ?? '?', message: iso[4] }
		}
		const classic = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})\s+\S+\s+([^\s[:]+)(?:\[(\d+)\])?:\s(.*)$/.exec(line)
		if (!classic) return null
		const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(classic[1])
		if (month === -1) return null
		const [day, hours, minutes, seconds] = [classic[2], classic[3], classic[4], classic[5]].map(Number)
		let at = new Date(now.getFullYear(), month, day, hours, minutes, seconds)
		if (at.getTime() > now.getTime() + 86_400_000) at = new Date(now.getFullYear() - 1, month, day, hours, minutes, seconds)
		return { at, identifier: classic[6], pid: classic[7] ?? '?', message: classic[8] }
	}

	/** The journal stores a message that isn't valid UTF-8 as an array of bytes. */
	private journalMessage(value: unknown): string | null {
		if (typeof value === 'string') return value
		if (Array.isArray(value) && value.every((b) => typeof b === 'number')) return Buffer.from(value).toString('utf8')
		return null
	}
}
