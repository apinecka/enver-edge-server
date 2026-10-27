import { HostPaths } from './host-paths'

describe('HostPaths', () => {
	describe('rootProblem', () => {
		it.each(['/', '/etc', '/var/lib/dpkg', '/opt/enver/volumes', '/srv/enver', '/home/me/data', '/Volumes/disk'])('accepts %s', (dir) => {
			expect(HostPaths.rootProblem(dir)).toBeNull()
		})

		it.each([
			['opt/enver', HostPaths.RootProblem.notAbsolute],
			['/opt/enver/volumes/', HostPaths.RootProblem.notNormalized],
			['/opt/enver/../etc', HostPaths.RootProblem.notNormalized],
			['/opt//enver', HostPaths.RootProblem.notNormalized],
			['/opt/a\0b', HostPaths.RootProblem.notNormalized],
			[`/opt/${'x'.repeat(300)}`, HostPaths.RootProblem.tooLong],
		])('refuses %s', (dir, problem) => {
			expect(HostPaths.rootProblem(dir)).toBe(problem)
		})
	})

	describe('rootsProblem', () => {
		it('accepts any absolute directories, nested ones included', () => {
			expect(HostPaths.rootsProblem(['/opt/data', '/opt/data/dev1', '/'])).toBeNull()
		})

		it('refuses an invalid entry and too many', () => {
			expect(HostPaths.rootsProblem(['/srv', 'backups'])).toBe(HostPaths.RootProblem.notAbsolute)
			expect(HostPaths.rootsProblem(Array.from({ length: HostPaths.MAX_DIRS + 1 }, (_, i) => `/v${i}`))).toBe(HostPaths.RootProblem.tooMany)
		})
	})

	describe('locate', () => {
		const dirs = ['/opt/data', '/mnt/disk']

		it.each([
			['web', { root: '/opt/data', path: '/opt/data/web' }],
			['dev1/postgres', { root: '/opt/data', path: '/opt/data/dev1/postgres' }],
			['/opt/data', { root: '/opt/data', path: '/opt/data' }],
			['/opt/data/backups/dev/postgres', { root: '/opt/data', path: '/opt/data/backups/dev/postgres' }],
			['/mnt/disk/dev1/postgres-init.sh', { root: '/mnt/disk', path: '/mnt/disk/dev1/postgres-init.sh' }],
			['/mnt/disk/a/../b', { root: '/mnt/disk', path: '/mnt/disk/b' }],
		])('locates %s', (target, expected) => {
			expect(HostPaths.locate(dirs, target)).toEqual(expected)
		})

		it.each(['', '..', '../x', 'a/../../x', '/etc', '/opt/data/../etc', '/opt/data-other', 'a\0b'])('refuses %p', (target) => {
			expect(HostPaths.locate(dirs, target)).toBeNull()
		})

		it('refuses a relative path without any directory', () => {
			expect(HostPaths.locate([], 'web')).toBeNull()
		})
	})

	describe('conflicts', () => {
		const volume = (owner: string, path: string) => ({ owner, kind: HostPaths.MountKind.volume, path })
		const backup = (owner: string, path: string) => ({ owner, kind: HostPaths.MountKind.backup, path })

		it('lets volumes share a path or sit side by side', () => {
			expect(HostPaths.conflicts([volume('a', '/d/x'), volume('b', '/d/x'), volume('c', '/d/y'), backup('d', '/d/z')])).toEqual([])
		})

		it('finds nesting volumes, also of one owner', () => {
			expect(HostPaths.conflicts([volume('a', '/d/x'), volume('b', '/d/x/y')])).toEqual([{ mount: volume('a', '/d/x'), other: volume('b', '/d/x/y') }])
			expect(HostPaths.conflicts([volume('a', '/d/x'), volume('a', '/d/x/y')])).toHaveLength(1)
		})

		it('finds a backup directory inside a volume but not a volume inside a backup directory', () => {
			expect(HostPaths.conflicts([volume('a', '/d'), backup('b', '/d/backups')])).toHaveLength(1)
			expect(HostPaths.conflicts([volume('a', '/d/backups'), backup('b', '/d/backups')])).toHaveLength(1)
			expect(HostPaths.conflicts([volume('a', '/d/backups/x'), backup('b', '/d/backups')])).toEqual([])
			expect(HostPaths.conflicts([backup('a', '/d'), backup('b', '/d/x')])).toEqual([])
		})

		it('puts the given owner first and leaves out pairs without it', () => {
			const mounts = [volume('a', '/d/x'), volume('b', '/d/x/y'), volume('c', '/d/x/z')]
			expect(HostPaths.conflicts(mounts, 'b')).toEqual([{ mount: volume('b', '/d/x/y'), other: volume('a', '/d/x') }])
		})
	})

	describe('resolve', () => {
		const root = '/opt/enver/volumes'

		it.each([
			['web', '/opt/enver/volumes/web'],
			['web/data', '/opt/enver/volumes/web/data'],
			['/opt/enver/volumes/web', '/opt/enver/volumes/web'],
		])('resolves %s', (target, expected) => {
			expect(HostPaths.resolve(root, target)).toBe(expected)
		})

		it.each(['', '../backups', 'web/../../x', '/etc', '/opt/enver/volumes-other', 'a\0b'])('refuses %p', (target) => {
			expect(HostPaths.resolve(root, target)).toBeNull()
		})
	})
})
