import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { KnownSources } from './known-sources'
import { SecurityAuditTypes } from './security-audit.types'

const at = (iso: string) => new Date(iso)

describe('KnownSources', () => {
	let dir: string

	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'enver-sources-')) })
	afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

	it('learns on the first run, then tells new sources from known ones', async () => {
		const first = await KnownSources.open(dir)
		expect(first.learning).toBe(true)
		expect(first.isNew('192.0.2.1')).toBeNull()
		first.recordSuccess('192.0.2.1', at('2026-10-01T00:00:00Z'))
		await first.save(at('2026-10-01T00:00:00Z'))

		const second = await KnownSources.open(dir)
		expect(second.learning).toBe(false)
		expect(second.isNew('192.0.2.1')).toBe(false)
		expect(second.isNew('192.0.2.2')).toBe(true)
	})

	it('stores only salted hashes, readable by the agent alone', async () => {
		const sources = await KnownSources.open(dir)
		sources.recordSuccess('203.0.113.77', at('2026-10-01T00:00:00Z'))
		sources.recordFailure('198.51.100.9', at('2026-10-01T00:00:00Z'))
		await sources.save(at('2026-10-01T00:00:00Z'))

		const file = join(dir, SecurityAuditTypes.KNOWN_SOURCES_FILE)
		const text = await readFile(file, 'utf8')
		expect(text).not.toContain('203.0.113.77')
		expect(text).not.toContain('198.51.100.9')
		expect((await stat(file)).mode & 0o777).toBe(0o600)
	})

	it('forgets a source after 90 days and failures after 24 hours', async () => {
		const sources = await KnownSources.open(dir)
		sources.recordSuccess('192.0.2.1', at('2026-07-01T00:00:00Z'))
		sources.recordSuccess('192.0.2.2', at('2026-10-01T00:00:00Z'))
		sources.recordFailure('192.0.2.3', at('2026-10-30T00:00:00Z'))
		await sources.save(at('2026-10-31T12:00:00Z'))

		const later = await KnownSources.open(dir)
		expect(later.isNew('192.0.2.1')).toBe(true)
		expect(later.isNew('192.0.2.2')).toBe(false)
		expect(later.recentFailures('192.0.2.3', at('2026-10-31T12:00:00Z'))).toBe(0)
	})

	it('counts failures across runs within the window', async () => {
		const sources = await KnownSources.open(dir)
		for (let i = 0; i < 3; i++) sources.recordFailure('192.0.2.5', at(`2026-10-31T0${i}:00:00Z`))
		await sources.save(at('2026-10-31T03:00:00Z'))

		const next = await KnownSources.open(dir)
		for (let i = 0; i < 2; i++) next.recordFailure('192.0.2.5', at(`2026-10-31T0${4 + i}:00:00Z`))
		expect(next.recentFailures('192.0.2.5', at('2026-10-31T06:00:00Z'))).toBe(5)
	})

	it('without a state directory it never calls a source new', async () => {
		const sources = await KnownSources.open(null)
		expect(sources.persistent).toBe(false)
		sources.recordSuccess('192.0.2.1', at('2026-10-01T00:00:00Z'))
		expect(sources.isNew('192.0.2.9')).toBeNull()
		await expect(sources.save(at('2026-10-01T00:00:00Z'))).resolves.toBeUndefined()
	})

	it('starts over from a damaged file', async () => {
		const { writeFile } = await import('fs/promises')
		await writeFile(join(dir, SecurityAuditTypes.KNOWN_SOURCES_FILE), '{"version":1')
		expect((await KnownSources.open(dir)).learning).toBe(true)
	})
})
