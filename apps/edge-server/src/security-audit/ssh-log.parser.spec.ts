import { readFileSync } from 'fs'
import { join } from 'path'

import { KnownSources } from './known-sources'
import { LoginAnalyzer } from './login-analyzer'
import { SecurityAuditTypes } from './security-audit.types'
import { SshLogParser } from './ssh-log.parser'

const FIXTURES = join(__dirname, 'fixtures')
const fixture = (distro: string, file: string) => readFileSync(join(FIXTURES, distro, file), 'utf8')

/** Every fixture holds the same attack and logins (see the fixtures' journal.json). */
const EXPECTED_FAILURES = {
	total: 11,
	existingUsers: 7,
	nonExistingUsers: 4,
	distinctSources: 4,
	topUsernames: [
		{ username: 'root', count: 7 },
		{ username: 'admin', count: 1 },
		{ username: 'oracle', count: 1 },
		{ username: 'test', count: 1 },
		{ username: 'ubuntu', count: 1 },
	],
}

describe('SshLogParser and LoginAnalyzer', () => {
	const parser = new SshLogParser()
	const analyzer = new LoginAnalyzer()
	describe.each(['debian-11', 'debian-12', 'debian-13', 'ubuntu-20.04', 'ubuntu-22.04', 'ubuntu-24.04'])('journal of %s', (distro) => {
		it('counts failures, lists the logins and returns the last cursor', async () => {
			const stdout = fixture(distro, 'journal.json')
			const { events, cursor } = parser.parseJournal(stdout)
			const lastLine = stdout.trim().split('\n').at(-1) ?? ''
			expect(cursor).toBe((JSON.parse(lastLine) as { __CURSOR: string }).__CURSOR)

			const result = analyzer.analyze(events, await KnownSources.open(null))
			expect(result.failures).toEqual(EXPECTED_FAILURES)
			expect(result.successful).toEqual([
				{ at: '2026-10-31T10:14:00.000Z', username: 'deploy', method: 'key', newSource: null, afterFailures: false },
				{ at: '2026-10-31T10:29:00.000Z', username: 'root', method: 'password', newSource: null, afterFailures: true },
			])
		})
	})

	describe.each(['debian-11', 'ubuntu-20.04', 'ubuntu-24.04'])('/var/log/auth.log of %s', (distro) => {
		it('reads the same as the journal, including folded repeats', async () => {
			// The fixtures' classic lines carry the UTC time, which the parser reads as the host's local time.
			const time = (h: number, m: number) => distro === 'ubuntu-24.04' ? new Date(Date.UTC(2026, 9, 31, h, m)) : new Date(2026, 9, 31, h, m)
			const events = parser.parseAuthLog(fixture(distro, 'var/log/auth.log'), time(12, 0))
				.filter((e) => e.at.getTime() >= time(12, 0).getTime() - 86_400_000)
			const result = analyzer.analyze(events, await KnownSources.open(null))
			expect(result.failures).toEqual(EXPECTED_FAILURES)
			expect(result.successful.map((l) => [l.at, l.username, l.method, l.afterFailures])).toEqual([
				[time(10, 14).toISOString(), 'deploy', 'key', false],
				[time(10, 29).toISOString(), 'root', 'password', true],
			])
		})
	})

	it('dates a classic syslog line without a year in the past year when it would lie ahead', () => {
		const [event] = parser.parseAuthLog('Dec 31 23:00:00 host sshd[1]: Failed password for root from 192.0.2.1 port 1 ssh2', new Date(2027, 0, 1, 1, 0))
		expect(event.at).toEqual(new Date(2026, 11, 31, 23, 0))
	})

	it('reads keyboard-interactive as a password and a non-UTF-8 message given as bytes', () => {
		const message = Buffer.from('Accepted keyboard-interactive/pam for alice from 192.0.2.3 port 2 ssh2')
		const { events } = parser.parseJournal(JSON.stringify({ __CURSOR: 'c', __REALTIME_TIMESTAMP: '1793440800000000', SYSLOG_IDENTIFIER: 'sshd', MESSAGE: [...message] }))
		expect(events).toEqual([expect.objectContaining({ kind: SecurityAuditTypes.SshEventKind.accepted, username: 'alice', method: 'keyboard-interactive/pam' })])
	})

	it('ignores other identifiers and a line cut off by the output limit', () => {
		const line = JSON.stringify({ __CURSOR: 'c1', __REALTIME_TIMESTAMP: '1793440800000000', SYSLOG_IDENTIFIER: 'sudo', MESSAGE: 'Failed password for root from 192.0.2.1 port 1 ssh2' })
		const { events, sudo, cursor } = parser.parseJournal(`${line}\n{"__CURSOR":"c2","MESS`)
		expect(events).toEqual([])
		expect(sudo).toEqual([])
		expect(cursor).toBe('c1')
	})

	describe('sudo', () => {
		const A = SecurityAuditTypes.SudoEventKind.authFailure
		const N = SecurityAuditTypes.SudoEventKind.notInSudoers
		const EXPECTED_SUDO = [
			{ kind: A, username: 'alice' },
			{ kind: A, username: 'alice' },
			{ kind: A, username: 'alice' },
			{ kind: N, username: 'mallory' },
		]

		it.each(['debian-11', 'debian-12', 'debian-13', 'ubuntu-20.04', 'ubuntu-22.04', 'ubuntu-24.04'])('reads the failures from the journal of %s', (distro) => {
			expect(parser.parseJournal(fixture(distro, 'journal.json')).sudo).toEqual(EXPECTED_SUDO)
		})

		it.each(['debian-11', 'ubuntu-20.04', 'ubuntu-24.04'])('reads the failures from /var/log/auth.log of %s, folded repeats included', (distro) => {
			expect(parser.parseAuthLogEvents(fixture(distro, 'var/log/auth.log'), new Date(Date.UTC(2026, 9, 31, 12))).sudo).toEqual(EXPECTED_SUDO)
		})

		it('takes the user from logname without user=, and ignores the commands sudo ran', () => {
			expect(parser.parseSudoMessage('pam_unix(sudo-i:auth): authentication failure; logname=bob uid=1002 euid=0 tty=/dev/pts/0 ruser=bob rhost=  user=')).toEqual([{ kind: A, username: 'bob' }])
			expect(parser.parseSudoMessage('   eve : user NOT in sudoers ; TTY=pts/0 ; PWD=/ ; USER=root ; COMMAND=/bin/sh')).toEqual([{ kind: N, username: 'eve' }])
			expect(parser.parseSudoMessage('alice : TTY=pts/1 ; PWD=/home/alice ; USER=root ; COMMAND=/usr/bin/mysql -psecret')).toEqual([])
			expect(parser.parseSudoMessage('pam_unix(sudo:session): session opened for user root(uid=0) by alice(uid=1001)')).toEqual([])
		})
	})
})
