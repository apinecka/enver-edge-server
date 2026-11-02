import { Injectable } from '@nestjs/common'
import { execFile } from 'child_process'
import { access, constants } from 'fs/promises'
import { join } from 'path'

import { SecurityAuditTypes } from './security-audit.types'

/** Runs the audit's fixed read-only programs: by absolute path, without a shell, with a timeout and an
 *  output limit, in the C locale and UTC so their output parses the same everywhere. */
@Injectable()
export class CommandRunner {
	private resolved = new Map<SecurityAuditTypes.Program, string | null>()

	async exists(program: SecurityAuditTypes.Program): Promise<boolean> {
		return (await this.resolve(program)) !== null
	}

	/** Resolves with the output whatever the exit code; rejects only when the program is missing,
	 *  couldn't start or timed out. */
	async run(program: SecurityAuditTypes.Program, args: string[], options: SecurityAuditTypes.CommandOptions = SecurityAuditTypes.COMMAND_DEFAULTS): Promise<SecurityAuditTypes.CommandResult> {
		const path = await this.resolve(program)
		if (!path) throw new SecurityAuditTypes.SectionUnavailableError(`${program} is not installed`)
		return new Promise((resolve, reject) => {
			execFile(path, args, {
				shell: false,
				timeout: options.timeoutMs,
				maxBuffer: options.maxBytes,
				encoding: 'utf8',
				env: { PATH: SecurityAuditTypes.PROGRAM_DIRS.join(':'), LC_ALL: 'C', LANG: 'C', TZ: 'UTC', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' },
			}, (error, stdout) => {
				if (!error) return resolve({ stdout, exitCode: 0, truncated: false })
				const code = (error as NodeJS.ErrnoException & { code?: unknown }).code
				if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ stdout, exitCode: null, truncated: true })
				if (typeof code === 'number') return resolve({ stdout, exitCode: code, truncated: false })
				reject(new SecurityAuditTypes.SectionUnavailableError(error.killed ? `${program} timed out` : `${program} failed: ${error.message}`))
			})
		})
	}

	private async resolve(program: SecurityAuditTypes.Program): Promise<string | null> {
		if (this.resolved.has(program)) return this.resolved.get(program) ?? null
		let found: string | null = null
		for (const dir of SecurityAuditTypes.PROGRAM_DIRS) {
			const candidate = join(dir, program)
			try {
				await access(candidate, constants.X_OK)
				found = candidate
				break
			} catch { /* next directory */ }
		}
		this.resolved.set(program, found)
		return found
	}
}
