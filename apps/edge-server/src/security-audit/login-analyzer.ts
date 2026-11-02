import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'

import { KnownSources } from './known-sources'
import { SecurityAuditTypes } from './security-audit.types'

type Attempt = { at: Date; address: string | null; username: string | null; invalidUser: boolean }

/** Counts failed attempts and lists successful logins. A failed attempt is a `Failed <method>` line, or
 *  a connection that tried an account and ended before authenticating without one - which is all a
 *  server that accepts only keys logs for an attack. */
@Injectable()
export class LoginAnalyzer {
	analyze(events: SecurityAuditTypes.SshEvent[], sources: KnownSources): Pick<SecurityAudit.LoginsSection, 'successful' | 'successfulTotal' | 'failures'> {
		const failures = this.failedAttempts(events)
		const accepted = events.filter((e) => e.kind === SecurityAuditTypes.SshEventKind.accepted)
		const timeline: { at: Date; attempt: Attempt | null; success: SecurityAuditTypes.SshEvent | null }[] = [
			...failures.map((attempt) => ({ at: attempt.at, attempt, success: null })),
			...accepted.map((success) => ({ at: success.at, attempt: null, success })),
		].sort((a, b) => a.at.getTime() - b.at.getTime())

		const successful: SecurityAudit.Login[] = []
		for (const { attempt, success } of timeline) {
			if (attempt) {
				sources.recordFailure(attempt.address, attempt.at)
				continue
			}
			if (!success) continue
			successful.push({
				at: success.at.toISOString(),
				username: success.username ?? '',
				method: this.method(success.method),
				newSource: sources.isNew(success.address),
				afterFailures: sources.recentFailures(success.address, success.at) >= SecurityAudit.AFTER_FAILURES_THRESHOLD,
			})
			sources.recordSuccess(success.address, success.at)
		}

		const usernames = new Map<string, number>()
		for (const f of failures) if (f.username !== null) usernames.set(f.username, (usernames.get(f.username) ?? 0) + 1)
		return {
			successful,
			successfulTotal: successful.length,
			failures: {
				total: failures.length,
				existingUsers: failures.filter((f) => !f.invalidUser).length,
				nonExistingUsers: failures.filter((f) => f.invalidUser).length,
				distinctSources: new Set(failures.map((f) => f.address).filter((a) => a !== null)).size,
				topUsernames: [...usernames]
					.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
					.slice(0, SecurityAudit.LIMITS.topUsernames)
					.map(([username, count]) => ({ username, count })),
			},
		}
	}

	private failedAttempts(events: SecurityAuditTypes.SshEvent[]): Attempt[] {
		const attempts: Attempt[] = []
		const withFailedLine = new Set<string>()
		const accepted = new Set<string>()
		const unfinished = new Map<string, Attempt>()
		for (const e of events) {
			if (e.kind === SecurityAuditTypes.SshEventKind.failed) {
				withFailedLine.add(e.connection)
				attempts.push(e)
			} else if (e.kind === SecurityAuditTypes.SshEventKind.accepted) {
				accepted.add(e.connection)
			} else if (!unfinished.has(e.connection) || e.invalidUser) {
				unfinished.set(e.connection, e)
			}
		}
		for (const [connection, attempt] of unfinished) {
			if (!withFailedLine.has(connection) && !accepted.has(connection)) attempts.push(attempt)
		}
		return attempts
	}

	private method(method: string | null): SecurityAudit.LoginMethod {
		if (method === 'publickey') return SecurityAudit.LoginMethod.key
		if (method === 'password' || method?.startsWith('keyboard-interactive')) return SecurityAudit.LoginMethod.password
		return SecurityAudit.LoginMethod.other
	}
}
