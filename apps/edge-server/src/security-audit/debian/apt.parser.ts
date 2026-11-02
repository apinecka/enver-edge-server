import { SecurityAudit } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'

import { DebianTypes } from './debian.types'

/** Parses what dpkg and apt print on Debian and Ubuntu. */
@Injectable()
export class AptParser {
	/** `apt-get -s dist-upgrade`: one `Inst <name> [<installed>] (<candidate> <origin>:<version>/<suite>, ... [<arch>])`
	 *  per package; a package new to the system has no `[<installed>]`. */
	parseSimulation(stdout: string): DebianTypes.Upgrades {
		const upgrades: DebianTypes.Upgrades = { security: [], esmInfra: [], esmApps: [], regular: [] }
		for (const line of stdout.split('\n')) {
			const m = /^Inst (\S+) (?:\[([^\]]*)\] )?\((\S+) (.*?)(?: \[[^\]]*\])?\)/.exec(line)
			if (!m) continue
			const update: SecurityAudit.PackageUpdate = { name: m[1], installedVersion: m[2] ?? null, candidateVersion: m[3] }
			upgrades[this.category(m[4].split(/,\s*/))].push(update)
		}
		return upgrades
	}

	/** `dpkg-query -W -f '${Package}\t${db:Status-Abbrev}\t${Version}\n'`. */
	parsePackages(stdout: string): Map<string, DebianTypes.InstalledPackage> {
		const packages = new Map<string, DebianTypes.InstalledPackage>()
		for (const line of stdout.split('\n')) {
			const [name, status, version] = line.split('\t')
			if (!name || status === undefined) continue
			packages.set(name.replace(/:.*$/, ''), { installed: status[1] === 'i', version: version?.trim() || null })
		}
		return packages
	}

	/** `dpkg-query -W -f '${db:Status-Abbrev}\t${Package}\t${Version}\t${Architecture}\t${Source}\n'`: the
	 *  installed packages (status `i`), sorted by name and architecture. `${Source}` is empty when the source
	 *  package is named like the binary one, and carries a version only when that differs (binNMUs). */
	parseInstalled(stdout: string): SecurityAudit.InstalledPackage[] {
		const packages: SecurityAudit.InstalledPackage[] = []
		for (const line of stdout.split('\n')) {
			const [status, name, version, arch, source] = line.split('\t')
			if (!status || status[1] !== 'i' || !name || !version || !arch) continue
			const m = /^(\S+)(?: \(([^)]+)\))?$/.exec(source?.trim() ?? '')
			const sourceName = m?.[1] && m[1] !== name ? m[1] : null
			const sourceVersion = m?.[2] && m[2] !== version ? m[2] : null
			packages.push({ name, version: version.trim(), arch: arch.trim(), source: sourceName, sourceVersion })
		}
		return packages.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0)
	}

	/** `APT::Periodic::<key> "<n>";` over the files of `apt.conf.d` in order: a later one overrides.
	 *  A value above 0 turns it on (it is an interval in days). */
	periodic(files: string[], key: string): boolean | null {
		let value: boolean | null = null
		const re = new RegExp(`^\\s*APT::Periodic::${key.replace(/[-]/g, '\\-')}\\s+"([^"]*)"\\s*;`, 'gim')
		for (const text of files) {
			const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '')
			for (const m of withoutComments.matchAll(re)) {
				const n = Number.parseInt(m[1], 10)
				value = Number.isFinite(n) ? n > 0 : m[1].toLowerCase() === 'always'
			}
		}
		return value
	}

	/** Ubuntu Pro's origins are `UbuntuESM` (`esm-infra`) and `UbuntuESMApps` (`esm-apps`). */
	private category(origins: string[]): keyof DebianTypes.Upgrades {
		const labels = origins.map((o) => o.split(':')[0])
		const suites = origins.map((o) => o.slice(o.lastIndexOf('/') + 1))
		if (labels.includes('UbuntuESMApps') || suites.some((s) => /-apps-/.test(s))) return 'esmApps'
		if (labels.includes('UbuntuESM') || suites.some((s) => /-infra-/.test(s))) return 'esmInfra'
		if (suites.some((s) => s.endsWith('-security'))) return 'security'
		return 'regular'
	}
}
