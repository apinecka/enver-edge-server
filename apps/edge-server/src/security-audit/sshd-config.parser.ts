import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { dirname, isAbsolute, join } from 'path'

import { HostFs } from './host-fs'
import { SecurityAuditTypes } from './security-audit.types'

/** Reads `sshd_config` with its `Include`s the way sshd does for a connection no `Match` block
 *  applies to: the first occurrence of a keyword wins (except the accumulating ones), `Match` blocks
 *  are skipped and only reported. `sshd -T` would be exact, but it needs root. */
@Injectable()
export class SshdConfigParser {
	async read(fs: HostFs, path = SecurityAuditTypes.SSHD_CONFIG): Promise<SecurityAuditTypes.SshdConfig> {
		const config: SecurityAuditTypes.SshdConfig = { values: new Map(), hasMatchBlocks: false, readFiles: [], unreadableFiles: [] }
		await this.readFile(fs, path, config, 0)
		return config
	}

	effective(config: SecurityAuditTypes.SshdConfig, ports: number[]): NonNullable<SecurityAudit.SshSection['config']> {
		const first = (keyword: keyof typeof SecurityAuditTypes.SSHD_DEFAULTS) =>
			(config.values.get(keyword)?.[0] ?? SecurityAuditTypes.SSHD_DEFAULTS[keyword]).toLowerCase()
		const maxAuthTries = Number.parseInt(first('maxauthtries'), 10)
		return {
			permitRootLogin: first('permitrootlogin'),
			passwordAuthentication: first('passwordauthentication'),
			kbdInteractiveAuthentication: first('kbdinteractiveauthentication'),
			pubkeyAuthentication: first('pubkeyauthentication'),
			permitEmptyPasswords: first('permitemptypasswords'),
			maxAuthTries: Number.isFinite(maxAuthTries) ? maxAuthTries : Number(SecurityAuditTypes.SSHD_DEFAULTS.maxauthtries),
			x11Forwarding: first('x11forwarding'),
			allowUsers: config.values.get('allowusers') ?? [],
			allowGroups: config.values.get('allowgroups') ?? [],
			ports,
			weakAlgorithms: this.weakAlgorithms(config),
			hasMatchBlocks: config.hasMatchBlocks,
		}
	}

	/** The `Port`s, or sshd's 22. */
	ports(config: SecurityAuditTypes.SshdConfig): number[] {
		const ports = (config.values.get('port') ?? []).map((p) => Number.parseInt(p, 10)).filter((p) => p > 0 && p < 65536)
		return ports.length ? [...new Set(ports)] : [22]
	}

	/** `ListenStream=` of a socket unit and its drop-ins: `22`, `0.0.0.0:2222`, `[::]:22`. An empty
	 *  value resets the list, as in systemd. */
	socketPorts(units: string[]): number[] {
		let ports: number[] = []
		for (const unit of units) {
			for (const line of unit.split('\n')) {
				const match = /^\s*ListenStream\s*=\s*(.*?)\s*$/.exec(line)
				if (!match) continue
				if (match[1] === '') {
					ports = []
					continue
				}
				const port = Number.parseInt(/(\d+)$/.exec(match[1])?.[1] ?? '', 10)
				if (port > 0 && port < 65536) ports.push(port)
			}
		}
		return [...new Set(ports)]
	}

	private async readFile(fs: HostFs, path: string, config: SecurityAuditTypes.SshdConfig, depth: number): Promise<void> {
		let text: string | null
		try {
			text = await fs.read(path)
		} catch {
			config.unreadableFiles.push(path)
			return
		}
		if (text === null) return
		config.readFiles.push(path)

		let inMatch = false
		for (const line of text.split('\n')) {
			const tokens = this.tokenize(line)
			if (!tokens.length) continue
			const keyword = tokens[0].toLowerCase()
			const args = tokens.slice(1)
			if (keyword === 'match') {
				inMatch = !(args.length === 1 && args[0].toLowerCase() === 'all')
				if (inMatch) config.hasMatchBlocks = true
				continue
			}
			if (inMatch) continue
			if (keyword === 'include') {
				if (depth >= SecurityAuditTypes.SSHD_INCLUDE_DEPTH) continue
				for (const pattern of args) {
					for (const file of await this.expand(fs, pattern)) await this.readFile(fs, file, config, depth + 1)
				}
				continue
			}
			this.set(config, keyword, args)
		}
	}

	private set(config: SecurityAuditTypes.SshdConfig, keyword: string, args: string[]): void {
		const key = keyword === 'challengeresponseauthentication' ? 'kbdinteractiveauthentication' : keyword
		if ((SecurityAuditTypes.SSHD_ACCUMULATING as readonly string[]).includes(key)) {
			config.values.set(key, [...config.values.get(key) ?? [], ...args])
		} else if (!config.values.has(key)) {
			config.values.set(key, args)
		}
	}

	/** Whitespace or one `=` between keyword and arguments, double quotes group, `#` starts a comment. */
	private tokenize(line: string): string[] {
		const tokens: string[] = []
		const re = /"([^"]*)"|([^\s"]+)/g
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) return tokens
		const eq = /^([A-Za-z0-9]+)\s*=\s*(.*)$/.exec(trimmed)
		const rest = eq ? `${eq[1]} ${eq[2]}` : trimmed
		for (const match of rest.matchAll(re)) {
			const token = match[1] ?? match[2]
			if (match[1] === undefined && token.startsWith('#')) break
			tokens.push(token)
		}
		return tokens
	}

	/** Relative patterns are under `/etc/ssh`; `*` and `?` in the file name, sorted like glob(3). */
	private async expand(fs: HostFs, pattern: string): Promise<string[]> {
		const path = isAbsolute(pattern) ? pattern : join(dirname(SecurityAuditTypes.SSHD_CONFIG), pattern)
		const base = path.slice(path.lastIndexOf('/') + 1)
		if (!/[*?[]/.test(base)) return [path]
		const dir = dirname(path)
		const re = new RegExp(`^${base.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
		return (await fs.list(dir)).filter((name) => !name.startsWith('.') && re.test(name)).map((name) => join(dir, name))
	}

	private weakAlgorithms(config: SecurityAuditTypes.SshdConfig): string[] {
		const weak: string[] = []
		for (const [keyword, re] of Object.entries(SecurityAuditTypes.WEAK_ALGORITHMS)) {
			const value = config.values.get(keyword)?.[0]
			if (!value || value.startsWith('-')) continue
			for (const algorithm of value.replace(/^[+^]/, '').split(',')) {
				if (re.test(algorithm.toLowerCase())) weak.push(algorithm)
			}
		}
		return weak
	}
}
