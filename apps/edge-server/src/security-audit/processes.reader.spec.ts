import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { HostFs } from './host-fs'
import { ProcessesReader } from './processes.reader'
import { SecurityAuditTypes } from './security-audit.types'

describe('ProcessesReader', () => {
	let root: string

	async function proc(pid: number, comm: string, args: string[], exe?: string) {
		const dir = join(root, 'proc', String(pid))
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'comm'), `${comm}\n`)
		await writeFile(join(dir, 'cmdline'), args.length ? `${args.join('\0')}\0` : '')
		if (exe) await symlink(exe, join(dir, 'exe'))
	}

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'enver-proc-'))
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('names known miners and programs started from a temporary directory, never their command line', async () => {
		await proc(1, 'systemd', ['/sbin/init'], '/usr/lib/systemd/systemd')
		await proc(2, 'kthreadd', [])
		await proc(10, 'kdevtmpfs', [])
		await proc(100, 'xmrig', ['./xmrig', '-o', 'pool:3333'])
		await proc(101, 'bash', ['/var/tmp/.x/run', '--user', 'secret-password'])
		await proc(102, 'node', ['node', 'worker.js', '-o', 'stratum+tcp://pool.example.com:3333'], '/usr/bin/node')
		await proc(103, 'kworkerds', ['[kworkerds]'], '/dev/shm/.k (deleted)')
		await proc(104, 'nginx', ['nginx: worker process'])
		await proc(105, 'grep', ['grep', 'xmrig'], '/usr/bin/grep')
		await proc(4242, 'node', ['/opt/enver/edge-server/node', 'main.js'])

		const result = await new ProcessesReader(new HostFs(root)).read(4242)
		expect(result).toEqual({
			scanned: 9,
			exeUnreadable: 3,
			suspicious: [
				{ name: 'xmrig', signature: 'xmrig', location: null },
				{ name: 'bash', signature: null, location: '/var/tmp' },
				{ name: 'node', signature: 'stratum', location: null },
				{ name: 'kworkerds', signature: 'disguised', location: '/dev/shm' },
			],
		})
		expect(JSON.stringify(result)).not.toContain('secret-password')
	})

	it('reports the section unavailable without /proc', async () => {
		await expect(new ProcessesReader(new HostFs(root)).read()).rejects.toThrow(SecurityAuditTypes.SectionUnavailableError)
	})
})
