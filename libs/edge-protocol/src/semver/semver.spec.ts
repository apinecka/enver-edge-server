import { Semver } from './semver'

describe('Semver', () => {
	describe('parse', () => {
		it('parses a release and a prerelease', () => {
			expect(Semver.parse('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
			expect(Semver.parse('1.0.0-rc.1+build.5')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['rc', '1'] })
		})

		it.each(['dev', '1.2', '01.2.3', '1.2.3-', '../1.2.3', '1.2.3/..', ''])('rejects %p', (value) => {
			expect(Semver.parse(value)).toBeNull()
		})
	})

	describe('compare', () => {
		it.each([
			['1.0.0', '1.0.1', -1],
			['1.0.10', '1.0.9', 1],
			['1.10.0', '1.9.99', 1],
			['2.0.0', '1.99.99', 1],
			['1.0.0', '1.0.0', 0],
			['1.0.0+a', '1.0.0+b', 0],
			['1.0.0-alpha', '1.0.0', -1],
			['1.0.0-alpha', '1.0.0-alpha.1', -1],
			['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
			['1.0.0-beta.2', '1.0.0-beta.11', -1],
			['1.0.0-beta', '1.0.0-alpha', 1],
		])('%s vs %s -> %i', (a, b, expected) => {
			expect(Semver.compare(a, b)).toBe(expected)
		})

		it('throws on an invalid version', () => {
			expect(() => Semver.compare('dev', '1.0.0')).toThrow('Invalid semver: dev')
		})
	})

	describe('isNewer', () => {
		it('is true only for a strictly higher valid version', () => {
			expect(Semver.isNewer('1.0.2', '1.0.1')).toBe(true)
			expect(Semver.isNewer('1.0.1', '1.0.1')).toBe(false)
			expect(Semver.isNewer('1.0.0', '1.0.1')).toBe(false)
		})

		it('is false when either side is invalid', () => {
			expect(Semver.isNewer('1.0.2', 'dev')).toBe(false)
			expect(Semver.isNewer('garbage', '1.0.0')).toBe(false)
		})
	})
})
