import { DockerTypes } from '@enver/domains/docker/docker.types'
import { EdgeProtocol, HostPaths } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { lstat, realpath } from 'fs/promises'
import * as path from 'path'

import { HostDirsTypes } from './host-dirs.types'

/** Confines Docker volumes and database backups to the directories set for this edge server in Enver,
 *  so whoever may edit a service can't mount or overwrite the rest of the host. */
@Injectable()
export class HostDirsService {
	private dirs: HostDirsTypes.Dirs = { volumesDirs: [], backupsDirs: [] }
	private mountLock: Promise<unknown> = Promise.resolve()

	configure(settings: Pick<EdgeProtocol.Settings, 'volumesDirs' | 'backupsDirs'>): void {
		this.dirs = { volumesDirs: settings.volumesDirs ?? [], backupsDirs: settings.backupsDirs ?? [] }
	}

	/** The real host path a volume's `externalPath` is mounted from. Docker follows symlinks in a bind
	 *  source, so call it right before creating the container and pass it the result. */
	async volumePath(externalPath: string): Promise<string> {
		const { real, realRoot } = await this.resolve(HostDirsTypes.Kind.volumes, this.dirs.volumesDirs, externalPath)
		if (real === realRoot) throw new HostDirsTypes.PathRefusedError(`${externalPath} is a whole volumes directory - use a directory inside it`)
		return real
	}

	/** The real host directory a service's backups go to, from its `backupDirPath`. */
	async backupDir(backupDirPath: string): Promise<string> {
		return (await this.resolve(HostDirsTypes.Kind.backups, this.dirs.backupsDirs, backupDirPath)).real
	}

	/** Runs `fn` while no other caller checks or creates mounts, so two containers started at once
	 *  can't both pass the check against each other. */
	withMountLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.mountLock.then(fn, fn)
		this.mountLock = run.catch(() => undefined)
		return run
	}

	/** Refuses volumes of `containerName` (real paths, from `volumePath`) that `HostPaths.conflicts`
	 *  forbids with each other or with the bind sources of the other managed containers. */
	async assertVolumesFit(containerName: string, sources: string[], existing: DockerTypes.BindMounts[]): Promise<void> {
		const mounts = [
			...sources.map((path) => ({ owner: containerName, kind: HostPaths.MountKind.volume, path })),
			...await this.otherVolumes(existing.filter((c) => c.containerName !== containerName)),
		]
		const [conflict] = HostPaths.conflicts(mounts, containerName)
		if (conflict) throw new HostDirsTypes.PathRefusedError(this.describeConflict(conflict))
	}

	/** Refuses a backup directory (a real path, from `backupDir`) inside a volume of a managed container. */
	async assertBackupDirFits(dir: string, existing: DockerTypes.BindMounts[]): Promise<void> {
		const [conflict] = HostPaths.conflicts([{ owner: '', kind: HostPaths.MountKind.backup, path: dir }, ...await this.otherVolumes(existing)], '')
		if (conflict) throw new HostDirsTypes.PathRefusedError(`The backup directory ${dir} lies inside ${conflict.other.path}, a volume of ${conflict.other.owner} - choose a backup directory outside every volume`)
	}

	/** Their real paths where they still resolve: a container created by hand or by an older agent may hold a link. */
	private async otherVolumes(existing: DockerTypes.BindMounts[]): Promise<HostPaths.Mount[]> {
		return Promise.all(existing.flatMap((c) => c.sources.map(async (source) => ({
			owner: c.containerName,
			kind: HostPaths.MountKind.volume,
			path: await this.realpathOfExisting(source).catch(() => source),
		}))))
	}

	private describeConflict(this: void, { mount, other }: HostPaths.Conflict): string {
		const where = other.owner === mount.owner ? 'another volume of the same service' : `a volume of ${other.owner}`
		return `The volume ${mount.path} and ${other.path}, ${where}, lie inside each other - volumes may share a path, but not nest`
	}

	private async resolve(kind: HostDirsTypes.Kind, dirs: string[], target: string): Promise<{ real: string; realRoot: string }> {
		if (dirs.length === 0) throw new HostDirsTypes.PathRefusedError(`No ${kind} directory is set for this edge server - add one in the edge server's settings in Enver`)
		if (HostPaths.rootsProblem(dirs)) throw new HostDirsTypes.PathRefusedError(`The ${kind} directories of this edge server are invalid - fix them in the edge server's settings in Enver`)
		const located = HostPaths.locate(dirs, target)
		if (!located) throw new HostDirsTypes.PathRefusedError(`${target} is outside the ${kind} directories (${dirs.join(', ')})`)

		const [real, realRoot] = await Promise.all([this.realpathOfExisting(located.path), this.realpathOfExisting(located.root)])
		if (!HostPaths.isInside(realRoot, real)) throw new HostDirsTypes.PathRefusedError(`${target} leads outside the ${kind} directory ${located.root}`)
		return { real, realRoot }
	}

	/** The real path of `target`, through its deepest existing ancestor when it doesn't exist yet. A
	 *  broken symlink is refused: Docker creates a missing bind source, following the link wherever it points. */
	private async realpathOfExisting(target: string): Promise<string> {
		const missing: string[] = []
		let current = target
		for (;;) {
			try {
				return path.posix.join(await realpath(current), ...missing.reverse())
			} catch (err) {
				const parent = path.posix.dirname(current)
				if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw err
				if (await lstat(current).then(() => true, () => false)) throw new HostDirsTypes.PathRefusedError(`${current} is a broken symbolic link`)
				missing.push(path.posix.basename(current))
				current = parent
			}
		}
	}
}
