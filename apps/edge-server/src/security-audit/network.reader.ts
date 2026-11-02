import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'

import { HostFs } from './host-fs'
import { SecurityAuditTypes } from './security-audit.types'

/** The host's open ports and its firewall, from files anyone may read: `/proc/net/tcp{,6}` and UFW's config. */
@Injectable()
export class NetworkReader {
	constructor(private readonly fs: HostFs) {}

	async ports(): Promise<SecurityAudit.PortsSection> {
		const texts = await Promise.all(SecurityAuditTypes.PROC_NET_TCP.map((path) => this.fs.readUntilEnd(path, SecurityAuditTypes.PROC_NET_MAX_BYTES)))
		if (texts.every((text) => text === null)) throw new SecurityAuditTypes.SectionUnavailableError('/proc/net/tcp is not readable')
		const ports = new Set(texts.flatMap((text) => text ? this.parseListening(text.toString('utf8')) : []))
		return { listening: [...ports].sort((a, b) => a - b) }
	}

	/** Lines of `/proc/net/tcp` or `tcp6` (`sl local_address rem_address st ...`, addresses in hex): the
	 *  ports of listening sockets whose local address is all zeros, i.e. every address. */
	parseListening(text: string): number[] {
		const ports: number[] = []
		for (const line of text.split('\n')) {
			const fields = line.trim().split(/\s+/)
			if (fields.length < 4 || !/^\d+:$/.test(fields[0]) || fields[3] !== SecurityAuditTypes.TCP_LISTEN) continue
			const match = /^(0{8}|0{32}):([0-9A-Fa-f]{4})$/.exec(fields[1])
			if (!match) continue
			const port = parseInt(match[2], 16)
			if (port > 0) ports.push(port)
		}
		return ports
	}

	async firewall(): Promise<SecurityAudit.FirewallSection> {
		const stats = await this.fs.statIfPossible(SecurityAuditTypes.UFW_CONF)
		if (!stats) return { ufw: { installed: false, enabled: null } }
		const text = await this.fs.readIfReadable(SecurityAuditTypes.UFW_CONF)
		return { ufw: { installed: true, enabled: text === null ? null : this.parseUfwEnabled(text) } }
	}

	/** `ENABLED=yes` in ufw.conf; anything else, or no line, counts as off, as ufw reads it. */
	parseUfwEnabled(text: string): boolean {
		const match = /^\s*ENABLED\s*=\s*"?(\w+)"?\s*$/m.exec(text)
		return match?.[1].toLowerCase() === 'yes'
	}
}
