import { readFileSync } from 'fs'
import { join } from 'path'

import { AptParser } from './apt.parser'

const simulation = (distro: string) => readFileSync(join(__dirname, '../fixtures', distro, 'apt-get-s-dist-upgrade.txt'), 'utf8')
const names = (list: { name: string }[]) => list.map((p) => p.name)

describe('AptParser', () => {
	const parser = new AptParser()

	describe('parseSimulation', () => {
		it('Debian 11: security updates apart from point-release ones', () => {
			const u = parser.parseSimulation(simulation('debian-11'))
			expect(names(u.security)).toEqual(['libssl1.1', 'openssl', 'openssh-sftp-server', 'openssh-server', 'openssh-client'])
			expect(names(u.regular)).toEqual(['base-files'])
			expect(u.security).toContainEqual({ name: 'openssh-server', installedVersion: '1:8.4p1-5+deb11u3', candidateVersion: '1:8.4p1-5+deb11u5' })
		})

		it('Debian 12: a newly installed kernel has no installed version', () => {
			const u = parser.parseSimulation(simulation('debian-12'))
			expect(u.security).toContainEqual({ name: 'linux-image-6.1.0-41-amd64', installedVersion: null, candidateVersion: '6.1.153-1' })
			expect(names(u.security)).toEqual(['libssl3', 'linux-image-6.1.0-41-amd64', 'linux-image-amd64'])
			expect(names(u.regular)).toEqual(['tzdata'])
		})

		it('Debian 13: nothing to upgrade', () => {
			expect(parser.parseSimulation(simulation('debian-13'))).toEqual({ security: [], esmInfra: [], esmApps: [], regular: [] })
		})

		it('Ubuntu 20.04: esm-infra', () => {
			const u = parser.parseSimulation(simulation('ubuntu-20.04'))
			expect(names(u.esmInfra)).toEqual(['libssl1.1', 'openssl', 'sudo'])
			expect(u.security).toEqual([])
		})

		it('Ubuntu 22.04: a package in -updates and -security counts as security; esm-apps apart', () => {
			const u = parser.parseSimulation(simulation('ubuntu-22.04'))
			expect(names(u.security)).toEqual(['libc6', 'libc-bin'])
			expect(names(u.esmApps)).toEqual(['python3-pil', 'vim'])
			expect(names(u.regular)).toEqual(['libpython3.10'])
		})

		it('Ubuntu 24.04', () => {
			const u = parser.parseSimulation(simulation('ubuntu-24.04'))
			expect(names(u.security)).toEqual(['libssh-4'])
			expect(names(u.regular)).toEqual(['openssh-client'])
		})
	})

	describe('parsePackages', () => {
		it('tells installed packages from removed ones and strips the architecture', () => {
			const packages = parser.parsePackages('openssh-server\tii \t1:9.2p1-2+deb12u7\nfail2ban\trc \t1.0.2-2\nunattended-upgrades:all\tii \t2.9.1+nmu3\n')
			expect(packages.get('openssh-server')).toEqual({ installed: true, version: '1:9.2p1-2+deb12u7' })
			expect(packages.get('fail2ban')).toEqual({ installed: false, version: '1.0.2-2' })
			expect(packages.get('unattended-upgrades')?.installed).toBe(true)
		})
	})

	describe('parseInstalled', () => {
		it('keeps installed packages only, sorted, with their source package where it differs', () => {
			const installed = parser.parseInstalled(readFileSync(join(__dirname, '../fixtures/ubuntu-24.04/dpkg-query-installed.txt'), 'utf8'))
			expect(installed.map((p) => p.name)).toEqual(['base-files', 'docker-ce', 'libc6', 'libssl3t64', 'openssh-server', 'openssl', 'sudo', 'vim'])
			expect(installed).toContainEqual({ name: 'libssl3t64', version: '3.0.13-0ubuntu3.6', arch: 'amd64', source: 'openssl', sourceVersion: null })
			expect(installed).toContainEqual({ name: 'vim', version: '2:9.1.0016-1ubuntu7.9', arch: 'amd64', source: null, sourceVersion: null })
		})

		it('skips removed and unknown packages and malformed lines', () => {
			expect(parser.parseInstalled('rc \tfoo\t1.0\tamd64\t\nun \tbar\t\t\t\nii \tbaz\n\n')).toEqual([])
		})
	})

	describe('periodic', () => {
		it('a later file overrides, comments are ignored, 0 is off', () => {
			const files = [
				'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
				'// APT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::Unattended-Upgrade "0";\n',
			]
			expect(parser.periodic(files, 'Unattended-Upgrade')).toBe(false)
			expect(parser.periodic(files, 'Update-Package-Lists')).toBe(true)
			expect(parser.periodic([], 'Unattended-Upgrade')).toBeNull()
		})
	})
})
