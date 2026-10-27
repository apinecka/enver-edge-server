import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { HostDirsService } from './host-dirs.service'
import { HostDirsTypes } from './host-dirs.types'

describe('HostDirsService', () => {
	let base: string
	let service: HostDirsService

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'enver-host-dirs-'))
		mkdirSync(`${base}/volumes`)
		mkdirSync(`${base}/disk`)
		mkdirSync(`${base}/backups`)
		service = new HostDirsService()
	})

	afterEach(() => {
		rmSync(base, { recursive: true, force: true })
	})

	const real = (p: string) => p.replace(base, realpathSync(base))

	it('refuses volumes and backups while the api sends no directories', async () => {
		service.configure({})
		await expect(service.volumePath('/srv/web')).rejects.toThrow(/No volumes directory is set/)
		await expect(service.backupDir('/var/backups/pg')).rejects.toThrow(/No backups directory is set/)
	})

	it('refuses volumes and backups when the lists are empty', async () => {
		service.configure({ volumesDirs: [], backupsDirs: [] })
		await expect(service.volumePath('web')).rejects.toThrow(HostDirsTypes.PathRefusedError)
		await expect(service.backupDir('pg')).rejects.toThrow(/No backups directory is set/)
	})

	it('resolves volumes at any depth inside any of the directories, files included', async () => {
		service.configure({ volumesDirs: [`${base}/volumes`, `${base}/disk`], backupsDirs: [`${base}/backups`] })
		await expect(service.volumePath('web')).resolves.toBe(real(`${base}/volumes/web`))
		await expect(service.volumePath('dev1/postgres/data')).resolves.toBe(real(`${base}/volumes/dev1/postgres/data`))
		await expect(service.volumePath(`${base}/disk/dev1/postgres-init.sh`)).resolves.toBe(real(`${base}/disk/dev1/postgres-init.sh`))
		await expect(service.volumePath(`${base}/disk/x`)).resolves.toBe(real(`${base}/disk/x`))
	})

	it.each(['.', '', 'ROOT'])('refuses the whole volumes directory as %p', async (target) => {
		service.configure({ volumesDirs: [`${base}/volumes`] })
		await expect(service.volumePath(target === 'ROOT' ? `${base}/volumes` : target)).rejects.toThrow(target === '' ? /outside/ : /whole volumes directory/)
	})

	it('lets volumes and backups share a directory', async () => {
		service.configure({ volumesDirs: [base], backupsDirs: [base] })
		await expect(service.volumePath('dev1/postgres')).resolves.toBe(real(`${base}/dev1/postgres`))
		await expect(service.volumePath('.')).rejects.toThrow(/whole volumes directory/)
		await expect(service.backupDir(`${base}/backups/dev/postgres`)).resolves.toBe(real(`${base}/backups/dev/postgres`))
	})

	it.each(['..', '../x', 'a/../../x', '/etc', '/'])('refuses the volume %s outside the directories', async (target) => {
		service.configure({ volumesDirs: [`${base}/volumes`] })
		await expect(service.volumePath(target)).rejects.toThrow(/outside the volumes directories/)
	})

	it('resolves backup directories at any depth inside any of the directories', async () => {
		service.configure({ backupsDirs: [`${base}/backups`, `${base}/disk`] })
		await expect(service.backupDir('pg/main')).resolves.toBe(real(`${base}/backups/pg/main`))
		await expect(service.backupDir(`${base}/disk`)).resolves.toBe(real(`${base}/disk`))
		await expect(service.backupDir('/etc')).rejects.toThrow(/outside the backups directories/)
	})

	it('refuses a path that leads out through a symlink, but follows one that stays inside', async () => {
		symlinkSync('/etc', `${base}/volumes/escape`)
		symlinkSync(`${base}/volumes/web`, `${base}/volumes/alias`)
		service.configure({ volumesDirs: [`${base}/volumes`] })
		await expect(service.volumePath('escape')).rejects.toThrow(/leads outside/)
		await expect(service.volumePath('escape/passwd')).rejects.toThrow(/leads outside/)
		await expect(service.volumePath('alias/data')).rejects.toThrow(/broken symbolic link/)
		mkdirSync(`${base}/volumes/web`)
		await expect(service.volumePath('alias/data')).resolves.toBe(real(`${base}/volumes/web/data`))
	})

	it('refuses a broken symlink, which Docker would follow when creating the source', async () => {
		symlinkSync(`${base}/outside`, `${base}/volumes/dangling`)
		service.configure({ volumesDirs: [`${base}/volumes`] })
		await expect(service.volumePath('dangling')).rejects.toThrow(/broken symbolic link/)
		await expect(service.volumePath('dangling/x')).rejects.toThrow(/broken symbolic link/)
	})

	it('refuses a backup directory that leads out through a symlink', async () => {
		symlinkSync('/etc', `${base}/backups/escape`)
		service.configure({ backupsDirs: [`${base}/backups`] })
		await expect(service.backupDir('escape')).rejects.toThrow(/leads outside/)
	})

	it('refuses a list the api should never have sent', async () => {
		service.configure({ volumesDirs: ['relative'] })
		await expect(service.volumePath('web')).rejects.toThrow(/directories of this edge server are invalid/)
	})

	describe('mount conflicts', () => {
		it('lets volumes share a path but not nest, also within one container', async () => {
			const existing = [{ containerName: 'a', sources: [`${base}/volumes/dev1`] }]
			await expect(service.assertVolumesFit('b', [`${base}/volumes/dev1`], existing)).resolves.toBeUndefined()
			await expect(service.assertVolumesFit('b', [`${base}/volumes/dev2`], existing)).resolves.toBeUndefined()
			await expect(service.assertVolumesFit('b', [`${base}/volumes/dev1/postgres`], existing)).rejects.toThrow(/a volume of a, lie inside each other/)
			await expect(service.assertVolumesFit('b', [`${base}/volumes`], existing)).rejects.toThrow(/lie inside each other/)
			await expect(service.assertVolumesFit('b', [`${base}/volumes/x`, `${base}/volumes/x/y`], [])).rejects.toThrow(/another volume of the same service/)
		})

		it('ignores the mounts of the container being replaced', async () => {
			await expect(service.assertVolumesFit('a', [`${base}/volumes/dev1/postgres`], [{ containerName: 'a', sources: [`${base}/volumes/dev1`] }])).resolves.toBeUndefined()
		})

		it('compares the real paths of existing mounts', async () => {
			symlinkSync(`${base}/volumes`, `${base}/link`)
			await expect(service.assertVolumesFit('b', [real(`${base}/volumes/x`)], [{ containerName: 'a', sources: [`${base}/link`] }])).rejects.toThrow(/lie inside each other/)
		})

		it('refuses a backup directory inside a volume', async () => {
			await expect(service.assertBackupDirFits(`${base}/data/backups`, [{ containerName: 'web', sources: [`${base}/data`] }])).rejects.toThrow(/a volume of web/)
			await expect(service.assertBackupDirFits(`${base}/data`, [{ containerName: 'web', sources: [`${base}/data/web`] }])).resolves.toBeUndefined()
		})

		it('runs one locked section at a time, also after a failure', async () => {
			const order: string[] = []
			const slow = service.withMountLock(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20))
				order.push('first')
				throw new Error('boom')
			})
			const next = service.withMountLock(() => Promise.resolve(order.push('second')))
			await expect(slow).rejects.toThrow('boom')
			await next
			expect(order).toEqual(['first', 'second'])
		})
	})
})
