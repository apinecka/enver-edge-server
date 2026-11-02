import { createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { cp, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { HostFs } from './host-fs'
import { PersistenceReader } from './persistence.reader'

const FIXTURES = join(__dirname, 'fixtures')
const KEY = readFileSync(join(FIXTURES, 'debian-12/etc/machine-id'), 'utf8').trim()
const hmac = (content: string) => createHmac('sha256', KEY).update(content).digest('hex')

describe('PersistenceReader', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'enver-persistence-'))
		await cp(join(FIXTURES, 'debian-12'), root, { recursive: true })
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('lists the crontabs and the units in /etc with a hash keyed by the machine id', async () => {
		const result = await new PersistenceReader(new HostFs(root)).read()
		expect(result.ldSoPreload).toBe(false)
		expect(result.files.map((f) => f.path)).toEqual([
			'/etc/cron.d/e2scrub_all',
			'/etc/cron.daily/.placeholder',
			'/etc/cron.daily/apt-compat',
			'/etc/crontab',
			'/etc/systemd/system/backup.service',
			'/etc/systemd/system/backup.timer',
		])
		expect(result.files[3]).toEqual({ path: '/etc/crontab', hash: hmac(readFileSync(join(FIXTURES, 'debian-12/etc/crontab'), 'utf8')) })
	})

	it('flags a non-empty /etc/ld.so.preload, hashes a symlink\'s target and never opens what isn\'t a file', async () => {
		await writeFile(join(root, 'etc/ld.so.preload'), '/usr/lib/libprocesshider.so\n')
		await writeFile(join(root, 'etc/rc.local'), 'exit 0\n')
		await symlink(join(root, 'etc/rc.local'), join(root, 'etc/systemd/system/linked.service'))
		await symlink('/dev/null', join(root, 'etc/systemd/system/masked.service'))
		const result = await new PersistenceReader(new HostFs(root)).read()
		expect(result.ldSoPreload).toBe(true)
		expect(result.files).toEqual(expect.arrayContaining([
			{ path: '/etc/rc.local', hash: hmac('exit 0\n') },
			{ path: '/etc/systemd/system/linked.service', hash: hmac('exit 0\n') },
			{ path: '/etc/systemd/system/masked.service', hash: null },
		]))
	})

	it('leaves the hashes out without a machine id, and an empty ld.so.preload alone', async () => {
		await rm(join(root, 'etc/machine-id'))
		await writeFile(join(root, 'etc/ld.so.preload'), '')
		const result = await new PersistenceReader(new HostFs(root)).read()
		expect(result.ldSoPreload).toBe(false)
		expect(result.files.every((f) => f.hash === null)).toBe(true)
	})
})
