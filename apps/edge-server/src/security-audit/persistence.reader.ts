import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { createHmac } from 'crypto'

import { HostFs } from './host-fs'
import { SecurityAuditTypes } from './security-audit.types'

/** Where a program can make itself start again: `/etc/ld.so.preload`, the system crontabs, systemd units
 *  in `/etc` and `rc.local`. Only names and keyed hashes leave the host, so the api can tell a new or a
 *  changed file without ever seeing its content (cron lines can hold passwords). */
@Injectable()
export class PersistenceReader {
	constructor(private readonly fs: HostFs) {}

	async read(): Promise<SecurityAudit.PersistenceSection> {
		const preload = await this.fs.statIfPossible(SecurityAuditTypes.LD_SO_PRELOAD)
		const key = await this.machineId()
		const paths: string[] = [...SecurityAuditTypes.PERSISTENCE_FILES]
		for (const { dir, suffixes } of SecurityAuditTypes.PERSISTENCE_DIRS) {
			for (const name of await this.fs.list(dir)) {
				if (!suffixes || suffixes.some((suffix) => name.endsWith(suffix))) paths.push(`${dir}/${name}`)
			}
		}
		const files: SecurityAudit.PersistenceFile[] = []
		for (const path of paths.sort()) {
			const stats = await this.fs.statIfPossible(path)
			if (!stats || stats.isDirectory()) continue
			files.push({ path, hash: key && stats.isFile() ? await this.hash(path, key) : null })
		}
		return { ldSoPreload: preload !== null && preload.size > 0, files: files.slice(0, SecurityAudit.LIMITS.persistenceFiles) }
	}

	/** Only regular files are opened (a FIFO would block); a symlink counts as the file it points to. */
	private async hash(path: string, key: string): Promise<string | null> {
		const content = await this.fs.readUntilEnd(path, SecurityAuditTypes.MAX_FILE_BYTES)
		return content === null ? null : createHmac('sha256', key).update(content).digest('hex')
	}

	private async machineId(): Promise<string | null> {
		for (const path of SecurityAuditTypes.MACHINE_ID) {
			const id = (await this.fs.readIfReadable(path))?.trim()
			if (id) return id
		}
		return null
	}
}
