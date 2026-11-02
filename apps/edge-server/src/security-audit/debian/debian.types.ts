import { SecurityAudit } from '@enver/edge-protocol'

export namespace DebianTypes {
	export const SUPPORTED_DEBIAN = ['11', '12', '13']
	export const MIN_UBUNTU = [20, 4] as const

	/** Packages the report asks dpkg about. */
	export const PACKAGES = ['openssh-server', 'unattended-upgrades', 'fail2ban', 'crowdsec'] as const

	export interface InstalledPackage {
		installed: boolean
		version: string | null
	}

	export type Upgrades = Pick<SecurityAudit.UpdatesSection, 'security' | 'esmInfra' | 'esmApps' | 'regular'>
}
