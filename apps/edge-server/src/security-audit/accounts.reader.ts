import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'

import { HostFs } from './host-fs'
import { SecurityAuditTypes } from './security-audit.types'

/** The accounts that can log in or become root, from `/etc/passwd` and `/etc/group` (both readable by
 *  anyone). Ordinary system accounts are left out. */
@Injectable()
export class AccountsReader {
	constructor(private readonly fs: HostFs) {}

	async read(): Promise<SecurityAudit.AccountsSection> {
		const passwd = await this.fs.readIfReadable(SecurityAuditTypes.PASSWD_FILE)
		if (passwd === null) throw new SecurityAuditTypes.SectionUnavailableError(`${SecurityAuditTypes.PASSWD_FILE} is not readable`)
		return this.parse(passwd, await this.fs.readIfReadable(SecurityAuditTypes.GROUP_FILE) ?? '')
	}

	parse(passwd: string, group: string): SecurityAudit.AccountsSection {
		const users = this.lines(passwd, 7).map((f) => ({ name: f[0], uid: Number(f[2]), gid: Number(f[3]), shell: f[6].trim() }))
			.filter((u) => u.name !== '' && Number.isInteger(u.uid) && u.uid >= 0)
		const privileged: readonly string[] = SecurityAudit.PRIVILEGED_GROUPS
		const groups = this.lines(group, 4)
			.filter((f) => privileged.includes(f[0]))
			.map((f) => {
				const gid = Number(f[2])
				const members = new Set([
					...f[3].split(',').map((m) => m.trim()).filter(Boolean),
					...users.filter((u) => u.gid === gid).map((u) => u.name),
				])
				return { name: f[0], members: [...members].sort() }
			})
			.sort((a, b) => privileged.indexOf(a.name) - privileged.indexOf(b.name))
		const members = new Set(groups.flatMap((g) => g.members))
		const accounts = users
			.map((u) => ({ name: u.name, uid: u.uid, loginShell: u.shell !== '' && !SecurityAuditTypes.NO_LOGIN_SHELL.test(u.shell) }))
			.filter((a) => a.uid === 0 || a.loginShell || members.has(a.name))
		return { accounts, groups }
	}

	/** Lines with at least `fields` colon-separated fields; comments and blank lines skipped. */
	private lines(text: string, fields: number): string[][] {
		return text.split('\n')
			.filter((line) => line.trim() !== '' && !line.startsWith('#'))
			.map((line) => line.split(':'))
			.filter((f) => f.length >= fields)
	}
}
