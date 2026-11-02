import { Injectable } from '@nestjs/common'

import { SecurityAuditTypes } from './security-audit.types'

@Injectable()
export class OsReleaseParser {
	/** `/etc/os-release`: `KEY=value`, the value optionally quoted with shell escapes. */
	parse(text: string): SecurityAuditTypes.OsRelease {
		const fields = new Map<string, string>()
		for (const line of text.split('\n')) {
			const m = /^\s*([A-Z0-9_]+)=(.*?)\s*$/.exec(line)
			if (!m) continue
			const raw = m[2]
			const unquoted = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1).replace(/\\(["'$`\\])/g, '$1') : raw
			fields.set(m[1], unquoted)
		}
		return {
			id: fields.get('ID')?.toLowerCase() || null,
			idLike: (fields.get('ID_LIKE') ?? '').split(/\s+/).filter(Boolean),
			versionId: fields.get('VERSION_ID') || null,
			prettyName: fields.get('PRETTY_NAME') || null,
			codename: fields.get('VERSION_CODENAME') || fields.get('UBUNTU_CODENAME') || null,
		}
	}
}
