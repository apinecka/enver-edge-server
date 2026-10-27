import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { config as mockConfig } from '../app.config'
import { EnvFilesService } from './env-files.service'
import { EnvFilesTypes } from './env-files.types'

jest.mock('../app.config', () => ({ config: { envFiles: { dir: '', maxBytes: 1024 } } }))

describe('EnvFilesService', () => {
	let root: string
	let service: EnvFilesService

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'enver-env-files-'))
		mockConfig.envFiles.dir = join(root, 'env-files')
		await mkdir(mockConfig.envFiles.dir)
		service = new EnvFilesService()
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	describe('read', () => {
		it('parses a dotenv file inside the directory, including a subdirectory', async () => {
			await mkdir(join(mockConfig.envFiles.dir, 'prod'))
			await writeFile(join(mockConfig.envFiles.dir, 'prod', 'api.env'), '# comment\nDB_PASSWORD=s3cret\nQUOTED="a b"\n')

			await expect(service.read('prod/api.env')).resolves.toEqual([
				{ name: 'DB_PASSWORD', value: 's3cret' },
				{ name: 'QUOTED', value: 'a b' },
			])
		})

		it.each(['../outside.env', '/etc/passwd', 'prod/../../x', '.hidden', ''])('refuses the name "%s"', async (name) => {
			await expect(service.read(name)).rejects.toThrow(EnvFilesTypes.InvalidEnvFileNameError)
		})

		it('refuses a symlink pointing out of the directory', async () => {
			await writeFile(join(root, 'secret'), 'KEY=value\n')
			await symlink(join(root, 'secret'), join(mockConfig.envFiles.dir, 'link.env'))

			await expect(service.read('link.env')).rejects.toThrow(EnvFilesTypes.EnvFileOutsideDirError)
		})

		it('reports a missing file without its contents', async () => {
			await expect(service.read('missing.env')).rejects.toThrow(EnvFilesTypes.EnvFileNotFoundError)
		})

		it('reports a missing directory as a missing file', async () => {
			mockConfig.envFiles.dir = join(root, 'nope')

			await expect(service.read('app.env')).rejects.toThrow(EnvFilesTypes.EnvFileNotFoundError)
		})

		it('refuses a directory', async () => {
			await mkdir(join(mockConfig.envFiles.dir, 'dir.env'))

			await expect(service.read('dir.env')).rejects.toThrow(EnvFilesTypes.EnvFileNotFoundError)
		})

		it('refuses a file over the size limit', async () => {
			await writeFile(join(mockConfig.envFiles.dir, 'big.env'), `KEY=${'x'.repeat(2048)}\n`)

			await expect(service.read('big.env')).rejects.toThrow(EnvFilesTypes.EnvFileTooLargeError)
		})
	})

	describe('merge', () => {
		it('lets the file override a variable Enver sent and keeps the rest', () => {
			expect(service.merge(
				[{ name: 'A', value: 'enver' }, { name: 'B', value: 'enver' }],
				[{ name: 'B', value: 'file' }, { name: 'C', value: 'file' }],
			)).toEqual([
				{ name: 'A', value: 'enver' },
				{ name: 'B', value: 'file' },
				{ name: 'C', value: 'file' },
			])
		})
	})
})
