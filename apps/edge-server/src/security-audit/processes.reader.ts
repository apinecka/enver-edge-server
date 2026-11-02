import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { basename } from 'path'

import { HostFs } from './host-fs'
import { SecurityAuditTypes } from './security-audit.types'

/** Looks through `/proc` for known miners and programs started from a world-writable directory. The
 *  command line is matched here and never reported: it can hold passwords. Other users' executables
 *  can't be resolved without root; for them the first argument of the command line is used instead. */
@Injectable()
export class ProcessesReader {
	constructor(private readonly fs: HostFs) {}

	async read(ownPid = process.pid): Promise<SecurityAudit.ProcessesSection> {
		const pids = (await this.fs.list(SecurityAuditTypes.PROC_DIR)).filter((name) => /^\d+$/.test(name) && Number(name) !== ownPid)
		if (pids.length === 0) throw new SecurityAuditTypes.SectionUnavailableError('/proc lists no processes')
		let scanned = 0
		let exeUnreadable = 0
		const suspicious: SecurityAudit.SuspiciousProcess[] = []
		for (const pid of pids.slice(0, SecurityAuditTypes.MAX_PROCESSES)) {
			const dir = `${SecurityAuditTypes.PROC_DIR}/${pid}`
			const comm = (await this.fs.readUntilEnd(`${dir}/comm`, 64))?.toString('utf8').trim()
			if (!comm) continue
			scanned++
			const args = ((await this.fs.readUntilEnd(`${dir}/cmdline`, SecurityAuditTypes.CMDLINE_MAX_BYTES))?.toString('utf8') ?? '').split('\0').filter(Boolean)
			const exe = await this.fs.readLink(`${dir}/exe`)
			// Kernel threads have neither a command line nor an executable
			if (exe === null && args.length > 0) exeUnreadable++
			const signature = this.signature(comm, args)
			const location = this.tempDir(exe ?? (args[0]?.startsWith('/') ? args[0] : null))
			if (signature || location) suspicious.push({ name: comm, signature, location })
		}
		return { scanned, exeUnreadable, suspicious: suspicious.slice(0, SecurityAudit.LIMITS.processes) }
	}

	signature(comm: string, args: string[]): string | null {
		const names = new Set([comm.toLowerCase(), ...(args[0] ? [basename(args[0]).toLowerCase()] : [])])
		const cmdline = args.join(' ')
		const match = SecurityAuditTypes.MINER_SIGNATURES.find((s) =>
			(s.names?.some((name) => names.has(name)) ?? false) || (!!s.cmdline && cmdline !== '' && s.cmdline.test(cmdline)))
		return match?.id ?? null
	}

	/** `exe` of a deleted file ends with ` (deleted)`, typical of a dropper that removed itself. */
	tempDir(path: string | null): string | null {
		if (!path) return null
		const clean = path.replace(/ \(deleted\)$/, '')
		return SecurityAudit.TEMP_DIRS.find((dir) => clean.startsWith(`${dir}/`)) ?? null
	}
}
