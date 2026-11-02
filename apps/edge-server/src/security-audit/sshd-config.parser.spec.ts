import { chmod, cp, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { HostFs } from './host-fs'
import { SshdConfigParser } from './sshd-config.parser'

const FIXTURES = join(__dirname, 'fixtures')

describe('SshdConfigParser', () => {
	const parser = new SshdConfigParser()

	const effective = async (distro: string) => {
		const config = await parser.read(new HostFs(join(FIXTURES, distro)))
		return { config, effective: parser.effective(config, parser.ports(config)) }
	}

	it('Debian 11: the global values apply, a Match block is only reported, ChallengeResponseAuthentication is the keyboard-interactive switch', async () => {
		const { effective: e } = await effective('debian-11')
		expect(e).toEqual(expect.objectContaining({
			ports: [2222],
			permitRootLogin: 'yes',
			passwordAuthentication: 'yes',
			kbdInteractiveAuthentication: 'no',
			pubkeyAuthentication: 'yes',
			permitEmptyPasswords: 'no',
			maxAuthTries: 6,
			x11Forwarding: 'yes',
			hasMatchBlocks: true,
			weakAlgorithms: [],
		}))
	})

	it('Debian 12: 50-cloud-init.conf is included first and wins over the main file; weak algorithms are listed', async () => {
		const { config, effective: e } = await effective('debian-12')
		expect(config.readFiles).toEqual([
			'/etc/ssh/sshd_config',
			'/etc/ssh/sshd_config.d/50-cloud-init.conf',
			'/etc/ssh/sshd_config.d/60-legacy.conf',
		])
		expect(e).toEqual(expect.objectContaining({
			ports: [22],
			passwordAuthentication: 'no',
			permitRootLogin: 'prohibit-password',
			maxAuthTries: 3,
			allowGroups: ['ssh-users'],
			weakAlgorithms: ['aes128-cbc', '3des-cbc', 'hmac-md5'],
			hasMatchBlocks: false,
		}))
	})

	it('Debian 13: quoted values', async () => {
		const { effective: e } = await effective('debian-13')
		expect(e).toEqual(expect.objectContaining({ passwordAuthentication: 'no', permitRootLogin: 'prohibit-password', kbdInteractiveAuthentication: 'no' }))
	})

	it('Ubuntu 20.04: AllowUsers accumulates over its lines', async () => {
		const { effective: e } = await effective('ubuntu-20.04')
		expect(e).toEqual(expect.objectContaining({
			allowUsers: ['deploy', 'admin@192.0.2.0/24', 'ops'],
			passwordAuthentication: 'yes',
			kbdInteractiveAuthentication: 'no',
			x11Forwarding: 'yes',
		}))
	})

	it('Ubuntu 22.04: a cloud image that allows passwords', async () => {
		const { effective: e } = await effective('ubuntu-22.04')
		expect(e.passwordAuthentication).toBe('yes')
	})

	it('Ubuntu 24.04: a trailing comment is dropped and the socket units give the ports', async () => {
		const fs = new HostFs(join(FIXTURES, 'ubuntu-24.04'))
		const config = await parser.read(fs)
		const units = [
			await fs.read('/usr/lib/systemd/system/ssh.socket') ?? '',
			await fs.read('/run/systemd/generator/ssh.socket.d/addresses.conf') ?? '',
		]
		expect(parser.ports(config)).toEqual([2222])
		expect(parser.socketPorts(units)).toEqual([2222])
		expect(parser.effective(config, [2222])).toEqual(expect.objectContaining({ permitEmptyPasswords: 'yes', passwordAuthentication: 'no' }))
	})

	it('accepts `Keyword=value` and keeps the first occurrence', async () => {
		const config = await parser.read({ read: (path: string) => Promise.resolve(path === '/etc/ssh/sshd_config' ? 'PermitRootLogin=no\nPermitRootLogin yes\nPort = 22\nPort 2200\n' : null), list: () => Promise.resolve([]) } as unknown as HostFs)
		expect(parser.effective(config, parser.ports(config))).toEqual(expect.objectContaining({ permitRootLogin: 'no', ports: [22, 2200] }))
	})

	it('reports an included file it cannot read', async () => {
		if (process.getuid?.() === 0) return
		const root = await mkdtemp(join(tmpdir(), 'enver-sshd-'))
		try {
			await cp(join(FIXTURES, 'ubuntu-22.04'), root, { recursive: true })
			await chmod(join(root, 'etc/ssh/sshd_config.d/50-cloud-init.conf'), 0o000)
			const config = await parser.read(new HostFs(root))
			expect(config.unreadableFiles).toEqual(['/etc/ssh/sshd_config.d/50-cloud-init.conf'])
			expect(parser.effective(config, [22]).passwordAuthentication).toBe('yes')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
