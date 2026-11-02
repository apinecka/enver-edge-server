import { SecurityAudit } from '@enver/edge-protocol'
import { appendFile, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { HostFs } from './host-fs'
import { KnownSources } from './known-sources'
import { LoginAnalyzer } from './login-analyzer'
import { LoginsReader } from './logins-reader'
import { SecurityAuditTypes } from './security-audit.types'
import { SshLogParser } from './ssh-log.parser'

const NOW = new Date('2026-10-31T12:00:00Z')
const CURSOR = 's=4f1c0e8f9b2a4d6e8c0b1a2f3e4d5c6b;i=10;b=fe9b92823e0b1b17c9799c8835c75d6f;m=1;t=1;x=1'
const TAIL = 's=4f1c0e8f9b2a4d6e8c0b1a2f3e4d5c6b;i=99;b=fe9b92823e0b1b17c9799c8835c75d6f;m=1;t=1;x=1'
const line = (message: string) => `2026-10-31T11:00:00.000000+00:00 host sshd[42]: ${message}\n`

const mockRunner = { exists: jest.fn(), run: jest.fn() }

describe('LoginsReader', () => {
	let root: string
	let reader: LoginsReader

	const context = async (overrides: Partial<SecurityAuditTypes.CollectContext> = {}): Promise<SecurityAuditTypes.CollectContext> => ({
		os: { id: 'debian', idLike: [], versionId: '12', prettyName: null, codename: null },
		cursor: null,
		now: NOW,
		sources: await KnownSources.open(null),
		journalReadable: true,
		authLogReadable: null,
		packagesHash: null,
		...overrides,
	})

	beforeEach(async () => {
		jest.clearAllMocks()
		root = await mkdtemp(join(tmpdir(), 'enver-logins-'))
		reader = new LoginsReader(new HostFs(root), mockRunner as never, new SshLogParser(), new LoginAnalyzer())
		mockRunner.exists.mockResolvedValue(true)
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	describe('journal', () => {
		it('falls back to the initial window when the journal no longer knows the cursor', async () => {
			mockRunner.run
				.mockResolvedValueOnce({ stdout: '', exitCode: 1, truncated: false })
				.mockResolvedValueOnce({ stdout: '', exitCode: 0, truncated: false })
				.mockResolvedValueOnce({ stdout: JSON.stringify({ __CURSOR: TAIL, __REALTIME_TIMESTAMP: '1', MESSAGE: 'x' }), exitCode: 0, truncated: false })
				.mockResolvedValue({ stdout: '', exitCode: 0, truncated: false })

			const { logins } = await reader.read(await context({ cursor: CURSOR }), '/var/log/auth.log')

			expect(mockRunner.run.mock.calls[0][1]).toEqual(expect.arrayContaining(['--after-cursor', CURSOR]))
			expect(mockRunner.run.mock.calls[1][1]).toEqual(expect.arrayContaining(['--since', '2026-10-30 12:00:00']))
			expect(logins).toEqual(expect.objectContaining({ cursor: TAIL, windowStart: '2026-10-30T12:00:00.000Z', successfulTotal: 0 }))
		})

		it('keeps the cursor when nothing new was logged', async () => {
			mockRunner.run.mockResolvedValue({ stdout: '', exitCode: 0, truncated: false })
			const { logins } = await reader.read(await context({ cursor: CURSOR }), '/var/log/auth.log')
			expect(logins.cursor).toBe(CURSOR)
			expect(logins.failures.total).toBe(0)
		})

		it('ignores a cursor of the auth log', async () => {
			mockRunner.run.mockResolvedValue({ stdout: '', exitCode: 0, truncated: false })
			await reader.read(await context({ cursor: 'auth-log:1:2' }), '/var/log/auth.log')
			expect(mockRunner.run.mock.calls[0][1]).toEqual(expect.arrayContaining(['--since']))
		})
	})

	describe('auth log', () => {
		const authLog = '/auth.log'

		it('continues from the cursor, starts a rotated file from its beginning and keeps a half-written line for later', async () => {
			const file = join(root, 'auth.log')
			await writeFile(file, line('Failed password for root from 192.0.2.1 port 1 ssh2'))
			const ctx = await context({ journalReadable: false, authLogReadable: true })

			const { logins: first, sudo } = await reader.read(ctx, authLog)
			expect(first.failures.total).toBe(1)
			expect(first.source).toBe(SecurityAudit.LoginSource.authLog)
			expect(sudo).toEqual({ authFailures: 0, notInSudoers: 0, topUsernames: [] })

			await appendFile(file, line('Failed password for admin from 192.0.2.2 port 1 ssh2') + '2026-10-31T11:00:01.000000+00:00 host sshd[43]: Failed pass')
			const { logins: second } = await reader.read({ ...ctx, cursor: first.cursor }, authLog)
			expect(second.failures.topUsernames).toEqual([{ username: 'admin', count: 1 }])
			expect(second.windowStart).toBeNull()

			await appendFile(file, 'word for bob from 192.0.2.3 port 1 ssh2\n')
			const { logins: third } = await reader.read({ ...ctx, cursor: second.cursor }, authLog)
			expect(third.failures.topUsernames).toEqual([{ username: 'bob', count: 1 }])

			await rm(file)
			await writeFile(file, line('Failed password for carol from 192.0.2.4 port 1 ssh2'))
			const { ino } = await stat(file)
			const { logins: rotated } = await reader.read({ ...ctx, cursor: `auth-log:${ino + 1}:5` }, authLog)
			expect(rotated.failures.topUsernames).toEqual([{ username: 'carol', count: 1 }])
			expect(rotated.cursor).toBe(`auth-log:${ino}:${(await stat(file)).size}`)
		})
	})

	it('reports the section unavailable without the journal or the auth log', async () => {
		await expect(reader.read(await context({ journalReadable: false, authLogReadable: false }), '/auth.log')).rejects.toThrow(SecurityAuditTypes.SectionUnavailableError)
	})
})
