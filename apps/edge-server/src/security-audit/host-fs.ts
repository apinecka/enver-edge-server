import { Injectable } from '@nestjs/common'
import { Stats } from 'fs'
import { access, constants, FileHandle, open, readdir, readlink, stat } from 'fs/promises'
import { join } from 'path'

import { SecurityAuditTypes } from './security-audit.types'

/** Read-only access to the host's files for the audit. `root` lets the tests point it at fixtures. */
@Injectable()
export class HostFs {
	constructor(private readonly root = '/') {}

	/** Null when the file doesn't exist; throws when it exists but can't be read. */
	async read(path: string, maxBytes = SecurityAuditTypes.MAX_FILE_BYTES): Promise<string | null> {
		try {
			return (await this.readRange(path, 0, maxBytes)).toString('utf8')
		} catch (err) {
			if (this.isMissing(err)) return null
			throw err
		}
	}

	/** Up to `maxBytes` from `offset`. */
	async readRange(path: string, offset: number, maxBytes: number): Promise<Buffer> {
		const handle = await open(this.at(path), 'r')
		try {
			const length = Math.max(0, Math.min(maxBytes, (await handle.stat()).size - offset))
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, offset)
			return buffer.subarray(0, bytesRead)
		} finally {
			await handle.close()
		}
	}

	/** Up to `maxBytes`, read until the end rather than by the file's size, which `/proc` reports as 0.
	 *  Null whatever kept it from being read. */
	async readUntilEnd(path: string, maxBytes: number): Promise<Buffer | null> {
		let handle: FileHandle
		try {
			handle = await open(this.at(path), 'r')
		} catch {
			return null
		}
		try {
			const chunks: Buffer[] = []
			let total = 0
			while (total < maxBytes) {
				const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - total))
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
				if (bytesRead === 0) break
				chunks.push(buffer.subarray(0, bytesRead))
				total += bytesRead
			}
			return Buffer.concat(chunks)
		} catch {
			return null
		} finally {
			await handle.close()
		}
	}

	/** A symbolic link's target, null when it can't be read (another user's `/proc/<pid>/exe`). */
	async readLink(path: string): Promise<string | null> {
		try {
			return await readlink(this.at(path))
		} catch {
			return null
		}
	}

	/** Null whatever kept it from being read. */
	async readIfReadable(path: string): Promise<string | null> {
		try {
			return await this.read(path)
		} catch {
			return null
		}
	}

	/** Null whatever kept it from being found. */
	async statIfPossible(path: string): Promise<Stats | null> {
		try {
			return await this.stat(path)
		} catch {
			return null
		}
	}

	async stat(path: string): Promise<Stats | null> {
		try {
			return await stat(this.at(path))
		} catch (err) {
			if (this.isMissing(err)) return null
			throw err
		}
	}

	async list(dir: string): Promise<string[]> {
		try {
			return (await readdir(this.at(dir))).sort()
		} catch {
			return []
		}
	}

	async canRead(path: string): Promise<boolean> {
		try {
			await access(this.at(path), constants.R_OK)
			return true
		} catch {
			return false
		}
	}

	isMissing(err: unknown): boolean {
		const code = (err as NodeJS.ErrnoException | null)?.code
		return code === 'ENOENT' || code === 'ENOTDIR'
	}

	private at(path: string): string {
		return this.root === '/' ? path : join(this.root, path)
	}
}
