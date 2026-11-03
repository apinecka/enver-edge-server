import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'

import { HostFs } from './host-fs'
import { SecurityAuditTypes } from './security-audit.types'

/** The host's open ports, VPN interfaces and its firewall, from files anyone may read: `/proc/net/{tcp,udp}{,6}`,
 *  `/sys/class/net` and UFW's config. */
@Injectable()
export class NetworkReader {
	constructor(private readonly fs: HostFs) {}

	async ports(): Promise<SecurityAudit.PortsSection> {
		const texts = await Promise.all(SecurityAuditTypes.PROC_NET_TCP.map((path) => this.fs.readUntilEnd(path, SecurityAuditTypes.PROC_NET_MAX_BYTES)))
		if (texts.every((text) => text === null)) throw new SecurityAuditTypes.SectionUnavailableError('/proc/net/tcp is not readable')
		const ports = new Set(texts.flatMap((text) => text ? this.parseListening(text.toString('utf8')) : []))
		const udpTexts = await Promise.all(SecurityAuditTypes.PROC_NET_UDP.map((path) => this.fs.readUntilEnd(path, SecurityAuditTypes.PROC_NET_MAX_BYTES)))
		const udp = new Set(udpTexts.flatMap((text) => text ? this.parseListening(text.toString('utf8'), SecurityAuditTypes.UDP_UNCONNECTED) : []))
		return {
			listening: [...ports].sort((a, b) => a - b),
			udpListening: [...udp].sort((a, b) => a - b),
			vpnInterfaces: await this.vpnInterfaces(),
		}
	}

	/** WireGuard by its `uevent`, tun and tap by `tun_flags` (OpenVPN and the like); other interfaces aren't named. */
	async vpnInterfaces(): Promise<SecurityAudit.VpnInterface[]> {
		const interfaces: SecurityAudit.VpnInterface[] = []
		for (const name of await this.fs.list(SecurityAuditTypes.SYS_CLASS_NET)) {
			if (interfaces.length >= SecurityAudit.LIMITS.vpnInterfaces) break
			const dir = `${SecurityAuditTypes.SYS_CLASS_NET}/${name}`
			const uevent = await this.fs.readIfReadable(`${dir}/uevent`)
			if (uevent && /^DEVTYPE=wireguard$/m.test(uevent)) {
				interfaces.push({ name, kind: SecurityAudit.VpnKind.wireguard })
				continue
			}
			const flags = await this.fs.readIfReadable(`${dir}/tun_flags`)
			if (flags === null || !/^0x[0-9a-f]+\s*$/i.test(flags)) continue
			interfaces.push({ name, kind: parseInt(flags, 16) & SecurityAuditTypes.IFF_TAP ? SecurityAudit.VpnKind.tap : SecurityAudit.VpnKind.tun })
		}
		return interfaces
	}

	/** Lines of `/proc/net/{tcp,udp}{,6}` (`sl local_address rem_address st ...`, addresses in hex): the
	 *  ports of sockets in `state` (listening TCP, unconnected UDP) whose local address is all zeros, i.e.
	 *  every address. */
	parseListening(text: string, state: string = SecurityAuditTypes.TCP_LISTEN): number[] {
		const ports: number[] = []
		for (const line of text.split('\n')) {
			const fields = line.trim().split(/\s+/)
			if (fields.length < 4 || !/^\d+:$/.test(fields[0]) || fields[3] !== state) continue
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
