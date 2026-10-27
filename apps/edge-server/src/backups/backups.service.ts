import { DockerService } from '@enver/domains/docker/docker.service'
import { DockerTypes } from '@enver/domains/docker/docker.types'
import { EdgeProtocol } from '@enver/edge-protocol'
import { Injectable, Logger } from '@nestjs/common'
import { constants as fsConstants } from 'fs'
import * as fs from 'fs/promises'
import * as path from 'path'

import { HostDirsService } from '../host-dirs/host-dirs.service'
import { HostDirsTypes } from '../host-dirs/host-dirs.types'
import { BackupsTypes } from './backups.types'

@Injectable()
export class BackupsService {
	private logger = new Logger(BackupsService.name)

	constructor(
		private dockerService: DockerService,
		private hostDirs: HostDirsService,
	) {}

	async buildListResponse(payload: EdgeProtocol.BackupListPayload): Promise<EdgeProtocol.BackupListResponseMessage> {
		try {
			return { type: 'backup.list.response', queryId: payload.queryId, files: await this.listFiles(await this.backupDir(payload.backupDirPath)), errorMessage: null }
		} catch (err) {
			return { type: 'backup.list.response', queryId: payload.queryId, files: [], errorMessage: this.extractErrorMessage(err) }
		}
	}

	async buildDeleteResponse(payload: EdgeProtocol.BackupDeletePayload): Promise<EdgeProtocol.BackupDeleteResponseMessage> {
		try {
			await fs.unlink(this.resolvePath(await this.backupDir(payload.backupDirPath), payload.fileName))
			return { type: 'backup.delete.response', queryId: payload.queryId, success: true, errorMessage: null }
		} catch (err) {
			return { type: 'backup.delete.response', queryId: payload.queryId, success: false, errorMessage: this.extractErrorMessage(err) }
		}
	}

	/** Runs `pg_dump` inside the target container and streams it straight to a new file in the
	 *  configured backup dir - fire-and-forget from the caller's point of view (a dump can take much
	 *  longer than the WS ack window), reporting the outcome later via a `backup.result` message. */
	async handleCreate(payload: EdgeProtocol.BackupCreatePayload, send: (msg: unknown) => void): Promise<void> {
		const fileName = `${BackupsTypes.FILE_PREFIX}${this.timestampSlug()}${BackupsTypes.FILE_SUFFIX}`
		let destPath: string | null = null
		try {
			const dir = await this.backupDir(payload.backupDirPath)
			destPath = this.resolvePath(dir, fileName)
			await fs.mkdir(dir, { recursive: true })
			const dest = (await fs.open(destPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)).createWriteStream()
			try {
				await this.dockerService.execToStream(payload.containerName, this.dumpCommand(), dest)
			} catch (err) {
				dest.destroy()
				throw err
			}
			await this.pruneRetained(dir, payload.retentionCount)
			send(this.resultMessage(payload, true, null, fileName))
		} catch (err) {
			if (destPath) await fs.unlink(destPath).catch(() => { /* dump never started or already cleaned up */ })
			this.logger.error({ err }, `Backup create failed for ${payload.containerName}`)
			send(this.resultMessage(payload, false, this.extractErrorMessage(err), null))
		}
	}

	/** Runs `pg_restore` inside the target container, fed from an existing backup file. Wipes every
	 *  non-system schema first (see wipeSql) so the result is an exact 1:1 match of the backup -
	 *  not just "whatever the backup happens to mention" - which matters when several branches have
	 *  been applying different migrations to the same shared environment between backups: anything
	 *  a different branch's migration added that isn't in this backup must not survive the restore.
	 *  Same fire-and-forget/`backup.result` shape as handleCreate. */
	async handleRestore(payload: EdgeProtocol.BackupRestorePayload, send: (msg: unknown) => void): Promise<void> {
		try {
			const src = (await this.openDump(this.resolvePath(await this.backupDir(payload.backupDirPath), payload.fileName))).createReadStream()
			try {
				await this.dockerService.execFromString(payload.containerName, this.psqlCommand(), this.wipeSql())
				await this.dockerService.execFromStream(payload.containerName, this.restoreCommand(), src)
			} catch (err) {
				src.destroy()
				throw err
			}
			send(this.resultMessage(payload, true, null, payload.fileName))
		} catch (err) {
			this.logger.error({ err }, `Backup restore failed for ${payload.containerName}`)
			send(this.resultMessage(payload, false, this.extractErrorMessage(err), payload.fileName))
		}
	}

	private async backupDir(backupDirPath: string): Promise<string> {
		const dir = await this.hostDirs.backupDir(backupDirPath)
		await this.hostDirs.assertBackupDirFits(dir, await this.dockerService.listBindMounts())
		return dir
	}

	private resultMessage(payload: { jobId: string; environmentServiceGuid: string }, success: boolean, errorMessage: string | null, fileName: string | null): EdgeProtocol.BackupResultMessage {
		return { type: 'backup.result', jobId: payload.jobId, environmentServiceGuid: payload.environmentServiceGuid, success, errorMessage, fileName }
	}

	/** Only the agent's own dumps: the directory may hold other files, which are never listed or pruned. */
	private async listFiles(dirPath: string): Promise<EdgeProtocol.BackupFileInfo[]> {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })
		return Promise.all(
			entries.filter((e) => e.isFile() && BackupsTypes.FILE_NAME_REGEX.test(e.name)).map(async (e) => {
				const stat = await fs.lstat(path.join(dirPath, e.name))
				return { fileName: e.name, sizeBytes: stat.size, createdAt: stat.birthtime.toISOString() }
			}),
		)
	}

	/** Keeps only the `retentionCount` newest dumps in the dir, deleting the rest - assumes the dir
	 *  is dedicated to one service's backups (one directory per Postgres service). */
	private async pruneRetained(dirPath: string, retentionCount: number): Promise<void> {
		if (!Number.isInteger(retentionCount) || retentionCount < 1) return
		const files = await this.listFiles(dirPath)
		const excess = files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(retentionCount)
		await Promise.all(excess.map((f) => fs.unlink(path.join(dirPath, f.fileName)).catch(() => { /* already gone */ })))
	}

	/** Never through a symbolic link, so a link planted among the dumps can't hand another host file to the container. */
	private async openDump(filePath: string): Promise<fs.FileHandle> {
		const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
		if (!(await handle.stat()).isFile()) {
			await handle.close()
			throw new Error('Invalid backup file')
		}
		return handle
	}

	/** `fileName` comes from a job (delete/restore): only a dump the agent itself named is accepted, so
	 *  it can neither leave `dirPath` nor touch another file in it. */
	private resolvePath(dirPath: string, fileName: string): string {
		if (!BackupsTypes.FILE_NAME_REGEX.test(fileName)) throw new Error('Invalid backup file name')
		return path.join(dirPath, fileName)
	}

	/** Custom format (`-Fc`) - compact and restorable with plain `pg_restore`. Credentials aren't
	 *  passed in at all: `$POSTGRES_USER`/`$POSTGRES_DB` are the official postgres image's own env
	 *  vars, already present inside the container, so pg_dump/pg_restore just inherit them.
	 *  `${VAR:-postgres}` matters, not just `$VAR`: the image only actually exports these env vars
	 *  when they were set at container creation - otherwise they're empty, and `-U ""` silently
	 *  falls back to peer-auth as the exec session's OS user (`root` for `docker exec`), which fails
	 *  with "role root does not exist" instead of using the image's own implied "postgres" default. */
	private dumpCommand(): string[] {
		return ['sh', '-c', 'pg_dump -Fc -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"']
	}

	private restoreCommand(): string[] {
		return ['sh', '-c', 'pg_restore -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" --clean --if-exists']
	}

	private psqlCommand(): string[] {
		return ['sh', '-c', 'psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}"']
	}

	/** Drops every non-system schema (with CASCADE, so all tables/views/sequences/extensions in it go
	 *  too) and recreates an empty `public`, mirroring a fresh database - run immediately before
	 *  `pg_restore` so restoring is a true replace, not a merge. `format(..., '%I', ...)` identifier-quotes
	 *  each schema name pulled from the catalog itself (not user input, but cheap safety regardless). */
	private wipeSql(): string {
		return `
DO $$
DECLARE
	schema_name text;
BEGIN
	FOR schema_name IN
		SELECT nspname FROM pg_catalog.pg_namespace
		WHERE nspname NOT IN ('pg_catalog', 'information_schema')
			AND nspname NOT LIKE 'pg\\_%'
	LOOP
		EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_name);
	END LOOP;
END $$;
CREATE SCHEMA public;
`
	}

	private timestampSlug(): string {
		return new Date().toISOString().replace(/[:.]/g, '-')
	}

	private extractErrorMessage(err: unknown): string {
		if (err instanceof DockerTypes.ExecFailedError) return err.stderr || err.message
		if (err instanceof DockerTypes.ContainerNotFoundError) return 'Container not found'
		if (err instanceof DockerTypes.ContainerNotManagedError || err instanceof HostDirsTypes.PathRefusedError) return err.message
		if (err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT') return 'Backup directory not found'
		if (err && typeof err === 'object' && (err as { code?: string }).code === 'ELOOP') return 'Invalid backup file'
		if (err instanceof Error) return err.message
		return 'Unknown error'
	}
}
