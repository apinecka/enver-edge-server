import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'

import { CommandRunner } from './command-runner'
import { HostFs } from './host-fs'
import { LoginAnalyzer } from './login-analyzer'
import { SecurityAuditTypes } from './security-audit.types'
import { SshLogParser } from './ssh-log.parser'

/** Reads sshd's logins and sudo's failures since the previous run's cursor: from the journal when the
 *  agent may read it, otherwise from the distribution's auth log (`/var/log/auth.log` on Debian). */
@Injectable()
export class LoginsReader {
	constructor(
		private readonly fs: HostFs,
		private readonly runner: CommandRunner,
		private readonly parser: SshLogParser,
		private readonly analyzer: LoginAnalyzer,
	) {}

	async read(context: SecurityAuditTypes.CollectContext, authLogPath: string): Promise<SecurityAuditTypes.AuthEvents> {
		if (context.journalReadable && await this.runner.exists(SecurityAuditTypes.Program.journalctl)) return this.fromJournal(context)
		if (context.authLogReadable) return this.fromAuthLog(context, authLogPath)
		throw new SecurityAuditTypes.SectionUnavailableError('Neither the journal nor the auth log is readable by the agent')
	}

	private async fromJournal(context: SecurityAuditTypes.CollectContext): Promise<SecurityAuditTypes.AuthEvents> {
		const cursor = context.cursor && SecurityAudit.JOURNAL_CURSOR_REGEX.test(context.cursor) ? context.cursor : null
		let windowStart = cursor ? null : this.initialWindowStart(context.now)
		let result = await this.journal(cursor ? ['--after-cursor', cursor] : ['--since', this.journalTime(this.initialWindowStart(context.now))])
		if (cursor && result.exitCode !== 0 && !result.stdout.trim()) {
			windowStart = this.initialWindowStart(context.now)
			result = await this.journal(['--since', this.journalTime(windowStart)])
		}
		if (result.exitCode !== 0 && !result.truncated && !result.stdout.trim()) {
			throw new SecurityAuditTypes.SectionUnavailableError(`journalctl exited with ${result.exitCode}`)
		}

		const { events, sudo, cursor: last } = this.parser.parseJournal(result.stdout)
		const next = last ?? (windowStart ? await this.tailCursor() : cursor)
		return {
			logins: {
				source: SecurityAudit.LoginSource.journal,
				cursor: next,
				windowStart: windowStart?.toISOString() ?? null,
				journal: await this.journalInfo(),
				...this.analyzer.analyze(events, context.sources),
				truncated: result.truncated,
			},
			sudo: this.sudoSection(sudo),
		}
	}

	private journal(position: string[]): Promise<SecurityAuditTypes.CommandResult> {
		return this.runner.run(SecurityAuditTypes.Program.journalctl, [
			'--quiet', '--no-pager', '--output=json', '--output-fields=MESSAGE,SYSLOG_IDENTIFIER,SYSLOG_PID,_PID',
			...position,
			...[...SecurityAuditTypes.SSH_IDENTIFIERS, SecurityAuditTypes.SUDO_IDENTIFIER].map((id) => `SYSLOG_IDENTIFIER=${id}`),
		], SecurityAuditTypes.JOURNAL_COMMAND)
	}

	/** The journal's newest entry, so a run that found no sshd lines doesn't read the same window again. */
	private async tailCursor(): Promise<string | null> {
		const result = await this.runner.run(SecurityAuditTypes.Program.journalctl, ['--quiet', '--no-pager', '--output=json', '--output-fields=MESSAGE', '--lines=1'])
		const cursor = this.parser.parseJournal(result.stdout).cursor
		return cursor && SecurityAudit.JOURNAL_CURSOR_REGEX.test(cursor) ? cursor : null
	}

	private async journalInfo(): Promise<NonNullable<SecurityAudit.LoginsSection['journal']>> {
		const persistent = (await this.fs.statIfPossible(SecurityAuditTypes.JOURNAL_DIRS[0]))?.isDirectory() ?? false
		try {
			const { stdout } = await this.runner.run(SecurityAuditTypes.Program.journalctl, ['--no-pager', '--list-boots'])
			const first = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC/.exec(stdout)
			return { persistent, firstEntryAt: first ? new Date(`${first[1]}T${first[2]}Z`).toISOString() : null }
		} catch {
			return { persistent, firstEntryAt: null }
		}
	}

	/** Reads on from the cursor's byte offset while the file is the same (inode); a rotated file from its
	 *  start; without a cursor the last `INITIAL_WINDOW_HOURS`. */
	private async fromAuthLog(context: SecurityAuditTypes.CollectContext, path: string): Promise<SecurityAuditTypes.AuthEvents> {
		const stats = await this.fs.stat(path)
		if (!stats) throw new SecurityAuditTypes.SectionUnavailableError(`${path} doesn't exist`)
		const cursor = context.cursor && SecurityAudit.AUTH_LOG_CURSOR_REGEX.test(context.cursor) ? context.cursor.split(':').slice(1).map(Number) : null

		let start = 0
		let windowStart: Date | null = null
		if (cursor && cursor[0] === stats.ino && cursor[1] <= stats.size) start = cursor[1]
		else if (!cursor) {
			start = Math.max(0, stats.size - SecurityAuditTypes.AUTH_LOG_MAX_BYTES)
			windowStart = this.initialWindowStart(context.now)
		}

		const buffer = await this.fs.readRange(path, start, SecurityAuditTypes.AUTH_LOG_MAX_BYTES)
		// Only whole lines; a line longer than the whole read is skipped rather than read forever.
		const end = buffer.lastIndexOf(0x0a) + 1 || (buffer.length === SecurityAuditTypes.AUTH_LOG_MAX_BYTES ? buffer.length : 0)
		const begin = windowStart && start > 0 ? Math.min(buffer.indexOf(0x0a) + 1, end) : 0
		const since = windowStart?.getTime() ?? -Infinity
		const { events, sudo } = this.parser.parseAuthLogEvents(buffer.subarray(begin, end).toString('utf8'), context.now, since)
		return {
			logins: {
				source: SecurityAudit.LoginSource.authLog,
				cursor: `auth-log:${stats.ino}:${start + end}`,
				windowStart: windowStart?.toISOString() ?? null,
				journal: null,
				...this.analyzer.analyze(events, context.sources),
				truncated: start + buffer.length < stats.size,
			},
			sudo: this.sudoSection(sudo),
		}
	}

	private sudoSection(events: SecurityAuditTypes.SudoEvent[]): SecurityAudit.SudoSection {
		const usernames = new Map<string, number>()
		for (const event of events) if (event.username) usernames.set(event.username, (usernames.get(event.username) ?? 0) + 1)
		return {
			authFailures: events.filter((e) => e.kind === SecurityAuditTypes.SudoEventKind.authFailure).length,
			notInSudoers: events.filter((e) => e.kind === SecurityAuditTypes.SudoEventKind.notInSudoers).length,
			topUsernames: [...usernames.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, SecurityAudit.LIMITS.topUsernames)
				.map(([username, count]) => ({ username, count })),
		}
	}

	private initialWindowStart(now: Date): Date {
		return new Date(now.getTime() - SecurityAudit.INITIAL_WINDOW_HOURS * 3_600_000)
	}

	/** journalctl reads it in UTC, the time zone the runner gives it. */
	private journalTime(at: Date): string {
		return at.toISOString().slice(0, 19).replace('T', ' ')
	}
}
