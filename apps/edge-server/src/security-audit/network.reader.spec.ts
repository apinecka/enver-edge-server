import { mkdir,mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { HostFs } from './host-fs'
import { NetworkReader } from './network.reader'
import { SecurityAuditTypes } from './security-audit.types'

const FIXTURES = join(__dirname, 'fixtures')

describe('NetworkReader', () => {
	it.each([
		['debian-12', [22, 80, 6379]],
		['ubuntu-24.04', [443, 2222, 2375]],
	])('lists the ports of %s listening on every address, not on one', async (distro, ports) => {
		await expect(new NetworkReader(new HostFs(join(FIXTURES, distro))).ports()).resolves.toEqual({ listening: ports })
	})

	it('reports the ports unavailable without /proc/net/tcp', async () => {
		await expect(new NetworkReader(new HostFs(join(FIXTURES, 'debian-11'))).ports()).rejects.toThrow(SecurityAuditTypes.SectionUnavailableError)
	})

	it('ignores sockets that don\'t listen and malformed lines', () => {
		const reader = new NetworkReader(new HostFs())
		expect(reader.parseListening([
			'   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1',
			'   1: 00000000:0050 076433C6:C738 01 00000000:00000000 00:00000000 00000000     0        0 2 1',
			'   2: 00000000:XYZ0 00000000:0000 0A',
			'garbage',
		].join('\n'))).toEqual([22])
	})

	describe('firewall', () => {
		let root: string
		beforeEach(async () => {
			root = await mkdtemp(join(tmpdir(), 'enver-ufw-'))
		})
		afterEach(async () => {
			await rm(root, { recursive: true, force: true })
		})

		it('reads ENABLED from ufw.conf', async () => {
			await expect(new NetworkReader(new HostFs(join(FIXTURES, 'ubuntu-24.04'))).firewall()).resolves.toEqual({ ufw: { installed: true, enabled: true } })
			await mkdir(join(root, 'etc/ufw'), { recursive: true })
			await writeFile(join(root, 'etc/ufw/ufw.conf'), 'ENABLED=no\n')
			await expect(new NetworkReader(new HostFs(root)).firewall()).resolves.toEqual({ ufw: { installed: true, enabled: false } })
		})

		it('knows when ufw isn\'t installed', async () => {
			await expect(new NetworkReader(new HostFs(root)).firewall()).resolves.toEqual({ ufw: { installed: false, enabled: null } })
		})
	})
})
