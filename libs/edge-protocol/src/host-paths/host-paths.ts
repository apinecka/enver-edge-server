import * as path from 'path'

/** Where on the edge server's host Docker volumes and database backups may live: the directories
 *  listed in the edge server's settings, nothing else. Whoever may edit those settings chooses them
 *  at their own risk, so no path is refused for being a system one; the only guarantee is that a
 *  volume or backup never leads outside them. */
export namespace HostPaths {
	export const SUGGESTED_VOLUMES_DIR = '/opt/enver/volumes'
	export const SUGGESTED_BACKUPS_DIR = '/opt/enver/backups'
	export const MAX_LENGTH = 255
	export const MAX_DIRS = 32

	export enum RootProblem {
		invalid = 'invalid',
		notAbsolute = 'not_absolute',
		notNormalized = 'not_normalized',
		tooLong = 'too_long',
		tooMany = 'too_many',
	}

	/** Why `dir` can't be a volumes or backups directory, or null when it can. */
	export function rootProblem(dir: string): RootProblem | null {
		if (dir.length > MAX_LENGTH) return RootProblem.tooLong
		if (!path.posix.isAbsolute(dir)) return RootProblem.notAbsolute
		if (path.posix.normalize(dir) !== dir || (dir !== '/' && dir.endsWith('/')) || dir.includes('\0')) return RootProblem.notNormalized
		return null
	}

	/** Why the list can't be set, or null when it can. */
	export function rootsProblem(dirs: readonly string[]): RootProblem | null {
		if (dirs.length > MAX_DIRS) return RootProblem.tooMany
		for (const dir of dirs) {
			const problem = rootProblem(dir)
			if (problem) return problem
		}
		return null
	}

	/** Where `target` lies: relative to the first of `roots`, or an absolute path inside any of them.
	 *  Null when it lies outside them all. */
	export function locate(roots: readonly string[], target: string): { root: string; path: string } | null {
		if (!target || target.includes('\0')) return null
		if (!path.posix.isAbsolute(target)) {
			const root = roots[0]
			const resolved = root === undefined ? null : resolve(root, target)
			return root !== undefined && resolved ? { root, path: resolved } : null
		}
		const resolved = path.posix.normalize(target)
		const root = roots.find((r) => isInside(r, resolved))
		return root ? { root, path: resolved } : null
	}

	export enum MountKind {
		volume = 'volume',
		backup = 'backup',
	}

	/** A host path in use: a volume's bind source or a backup directory, of `owner` (a container, a service). */
	export interface Mount {
		owner: string
		kind: MountKind
		path: string
	}

	export interface Conflict {
		mount: Mount
		other: Mount
	}

	/** Pairs of mounts that may not exist together: two volumes of which one lies inside the other
	 *  (also of the same owner; the same path is fine), and a backup directory inside a volume. A
	 *  container holding the outer directory could otherwise swap the inner one for a symlink, which
	 *  Docker follows whenever it mounts the volume again, or plant files among the backups.
	 *  Only pairs with a mount of `owner` when given. */
	export function conflicts(mounts: readonly Mount[], owner?: string): Conflict[] {
		const found: Conflict[] = []
		for (let i = 0; i < mounts.length; i++) {
			for (let j = i + 1; j < mounts.length; j++) {
				const [a, b] = mounts[i].owner === owner || mounts[j].owner !== owner ? [mounts[i], mounts[j]] : [mounts[j], mounts[i]]
				if (owner !== undefined && a.owner !== owner) continue
				if (conflicting(a, b)) found.push({ mount: a, other: b })
			}
		}
		return found
	}

	function conflicting(a: Mount, b: Mount): boolean {
		if (a.kind === MountKind.volume && b.kind === MountKind.volume) return a.path !== b.path && (isInside(a.path, b.path) || isInside(b.path, a.path))
		if (a.kind === MountKind.backup && b.kind === MountKind.volume) return isInside(b.path, a.path)
		if (a.kind === MountKind.volume && b.kind === MountKind.backup) return isInside(a.path, b.path)
		return false
	}

	/** `target` relative to `root` (or an absolute path inside it), or null when it leaves the root. */
	export function resolve(root: string, target: string): string | null {
		if (!target || target.includes('\0')) return null
		const resolved = path.posix.resolve(root, target)
		return isInside(root, resolved) ? resolved : null
	}

	/** Whether `target` is `dir` itself or lies under it. */
	export function isInside(dir: string, target: string): boolean {
		const relative = path.posix.relative(dir, target)
		return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative))
	}
}
