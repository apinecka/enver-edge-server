export namespace Semver {
	export interface Version {
		major: number
		minor: number
		patch: number
		prerelease: string[]
	}

	const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

	export function parse(value: string): Version | null {
		const match = PATTERN.exec(value.trim())
		if (!match) return null
		return {
			major: Number(match[1]),
			minor: Number(match[2]),
			patch: Number(match[3]),
			prerelease: match[4] ? match[4].split('.') : [],
		}
	}

	export function isValid(value: string): boolean {
		return parse(value) !== null
	}

	/** Precedence per semver 2.0.0 (build metadata ignored). Throws on an invalid version. */
	export function compare(a: string, b: string): -1 | 0 | 1 {
		const left = parse(a)
		const right = parse(b)
		if (!left || !right) throw new Error(`Invalid semver: ${left ? b : a}`)
		for (const key of ['major', 'minor', 'patch'] as const) {
			if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
		}
		return comparePrerelease(left.prerelease, right.prerelease)
	}

	/** False when either side isn't a valid version, so a dev build ("dev") never looks outdated. */
	export function isNewer(candidate: string, current: string): boolean {
		if (!isValid(candidate) || !isValid(current)) return false
		return compare(candidate, current) > 0
	}

	function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
		if (a.length === 0 || b.length === 0) {
			if (a.length === b.length) return 0
			return a.length === 0 ? 1 : -1
		}
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			const x = a[i]
			const y = b[i]
			if (x === undefined) return -1
			if (y === undefined) return 1
			if (x === y) continue
			const xNum = /^\d+$/.test(x)
			const yNum = /^\d+$/.test(y)
			if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1
			if (xNum !== yNum) return xNum ? -1 : 1
			return x < y ? -1 : 1
		}
		return 0
	}
}
