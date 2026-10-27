import { DockerService } from '@enver/domains/docker/docker.service'
import { DockerTypes } from '@enver/domains/docker/docker.types'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Writable } from 'stream'

import { HostDirsService } from '../host-dirs/host-dirs.service'
import { BackupsService } from './backups.service'

const mockDocker = {
	execToStream: jest.fn(),
	execFromStream: jest.fn(),
	execFromString: jest.fn(),
	listBindMounts: jest.fn(),
}

describe('BackupsService', () => {
	let base: string
	let backupsDir: string
	let hostDirs: HostDirsService
	let service: BackupsService
	let send: jest.Mock

	const dump = (dir: string, name: string) => {
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, name), 'dump')
	}

	beforeEach(() => {
		jest.clearAllMocks()
		base = mkdtempSync(join(tmpdir(), 'enver-backups-'))
		backupsDir = join(base, 'backups')
		hostDirs = new HostDirsService()
		hostDirs.configure({ backupsDirs: [backupsDir] })
		service = new BackupsService(mockDocker as unknown as DockerService, hostDirs)
		send = jest.fn()
		mockDocker.listBindMounts.mockResolvedValue([])
		mockDocker.execToStream.mockImplementation((_c: string, _cmd: string[], dest: Writable) => new Promise((resolve) => dest.end('new dump', () => resolve(undefined))))
	})

	afterEach(() => {
		rmSync(base, { recursive: true, force: true })
	})

	it('lists only its own dumps', async () => {
		dump(join(backupsDir, 'pg'), 'backup-2026-01-01T00-00-00-000Z.dump')
		dump(join(backupsDir, 'pg'), 'notes.txt')

		const res = await service.buildListResponse({ queryId: 'q', backupDirPath: 'pg' })

		expect(res.files.map((f) => f.fileName)).toEqual(['backup-2026-01-01T00-00-00-000Z.dump'])
	})

	it('refuses to list a directory outside the backups directory', async () => {
		const res = await service.buildListResponse({ queryId: 'q', backupDirPath: '/etc' })

		expect(res).toEqual(expect.objectContaining({ files: [], errorMessage: expect.stringContaining('outside the backups directories') }))
	})

	it('creates the dump in the service directory and prunes only older dumps', async () => {
		const dir = join(backupsDir, 'pg')
		dump(dir, 'backup-2020-01-01T00-00-00-000Z.dump')
		dump(dir, 'keep-me.txt')

		await service.handleCreate({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: 'pg', retentionCount: 1 }, send)

		const files = readdirSync(dir)
		expect(files).toContain('keep-me.txt')
		expect(files.filter((f) => f.endsWith('.dump'))).toHaveLength(1)
		expect(files).not.toContain('backup-2020-01-01T00-00-00-000Z.dump')
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'backup.result', success: true }))
	})

	it('never runs a dump for a directory outside the backups directory', async () => {
		await service.handleCreate({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: '/opt/enver/edge-server', retentionCount: 1 }, send)

		expect(mockDocker.execToStream).not.toHaveBeenCalled()
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: expect.stringContaining('outside the backups directories') }))
	})

	it.each(['../../etc/passwd', 'edge-server.env', 'backup-x.dump/../../x', '.'])('refuses to restore %p', async (fileName) => {
		await service.handleRestore({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: 'pg', fileName }, send)

		expect(mockDocker.execFromStream).not.toHaveBeenCalled()
		expect(mockDocker.execFromString).not.toHaveBeenCalled()
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: false }))
	})

	it('restores from its dump', async () => {
		dump(join(backupsDir, 'pg'), 'backup-2026-01-01T00-00-00-000Z.dump')

		await service.handleRestore({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: 'pg', fileName: 'backup-2026-01-01T00-00-00-000Z.dump' }, send)

		expect(mockDocker.execFromStream).toHaveBeenCalled()
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: true }))
	})

	it('never restores a dump that is a symlink, nor lists it', async () => {
		mkdirSync(join(backupsDir, 'pg'), { recursive: true })
		symlinkSync('/etc/passwd', join(backupsDir, 'pg', 'backup-x.dump'))

		const list = await service.buildListResponse({ queryId: 'q', backupDirPath: 'pg' })
		await service.handleRestore({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: 'pg', fileName: 'backup-x.dump' }, send)

		expect(list.files).toEqual([])
		expect(mockDocker.execFromString).not.toHaveBeenCalled()
		expect(mockDocker.execFromStream).not.toHaveBeenCalled()
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: 'Invalid backup file' }))
	})

	it('never backs up into a directory inside a volume', async () => {
		mockDocker.listBindMounts.mockResolvedValue([{ containerName: 'web', sources: [backupsDir] }])

		await service.handleCreate({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: 'pg', retentionCount: 1 }, send)

		expect(mockDocker.execToStream).not.toHaveBeenCalled()
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: expect.stringContaining('a volume of web') }))
	})

	it('refuses to delete a file that is not one of its dumps', async () => {
		dump(join(backupsDir, 'pg'), 'important.sql')

		const res = await service.buildDeleteResponse({ queryId: 'q', backupDirPath: 'pg', fileName: 'important.sql' })

		expect(res.success).toBe(false)
		expect(existsSync(join(backupsDir, 'pg', 'important.sql'))).toBe(true)
	})

	it('reports a container Enver does not manage', async () => {
		mockDocker.execToStream.mockRejectedValue(new DockerTypes.ContainerNotManagedError('db'))

		await service.handleCreate({ jobId: 'j', environmentServiceGuid: 'es', containerName: 'db', backupDirPath: 'pg', retentionCount: 1 }, send)

		expect(send).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorMessage: expect.stringContaining('not managed by Enver') }))
	})
})
