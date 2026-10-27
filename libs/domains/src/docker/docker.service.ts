import { Injectable } from '@nestjs/common'
import * as Dockerode from 'dockerode'
import { Readable } from 'stream'

import { DockerTypes } from './docker.types'
import { DockerFrameDemux } from './docker-frame-demux'

@Injectable()
export class DockerService {
	private docker!: Dockerode

	constructor(options: DockerTypes.Options) {
		this.reconfigure(options)
	}

	/** Rebuilds the dockerode client from fresh connection settings - dockerode is a cheap, stateless
	 *  wrapper around an HTTP/socket client, so this can be called repeatedly as settings are
	 *  refreshed at runtime (see apps/edge-server AppService's periodic settings poll) without
	 *  restarting the process. */
	reconfigure(options: DockerTypes.Options): void {
		this.docker = new Dockerode({
			socketPath: options.socketPath ?? '/var/run/docker.sock',
			...(options.host ? { host: options.host, port: options.port ?? 2375 } : {}),
		})
	}

	async pullImage(image: string, auth?: DockerTypes.RegistryAuth): Promise<void> {
		const stream = await this.docker.pull(image, auth ? { authconfig: auth } : {})
		await new Promise<void>((resolve, reject) => {
			this.docker.modem.followProgress(stream, (err: Error | null) => {
				if (err) reject(err)
				else resolve()
			})
		})
	}

	async ensureNetwork(name: string): Promise<void> {
		try {
			await this.docker.createNetwork({ Name: name })
		} catch (err) {
			if (this.isConflict(err)) return
			throw err
		}
	}

	async createContainer(config: DockerTypes.ServiceConfig): Promise<void> {
		try { await this.removeContainer(config.name) }
		catch (err) { if (!(err instanceof DockerTypes.ContainerNotFoundError)) throw err }

		const exposedPorts = Object.fromEntries(config.ports.map((p) => [`${p.internalPort}/tcp`, {}]))
		const hostIp = config.portsHostIp ? { HostIp: config.portsHostIp } : {}
		const portBindings = Object.fromEntries(config.ports.map((p) => [`${p.internalPort}/tcp`, [{ HostPort: String(p.exposedPort), ...hostIp }]]))
		const binds = config.volumes.map((v) => `${v.externalPath}:${v.internalPath}`)

		await this.docker.createContainer({
			name: config.name,
			Image: config.image,
			ExposedPorts: exposedPorts,
			Env: config.env?.map((e) => `${e.name}=${e.value}`),
			Cmd: config.command,
			Labels: { [DockerTypes.MANAGED_LABEL]: 'true' },
			HostConfig: {
				PortBindings: portBindings,
				Binds: binds,
				RestartPolicy: { Name: config.restartPolicy ?? 'unless-stopped' },
				NetworkMode: config.networkName,
			},
		})
	}

	async startContainer(name: string): Promise<void> {
		await this.inspectManaged(name)
		const container = this.docker.getContainer(name)
		try {
			await container.start()
		} catch (err) {
			if (this.isNotFound(err)) throw new DockerTypes.ContainerNotFoundError()
			throw err
		}
	}

	/** Stops and removes the container so the next start creates it fresh - persistent state must live in a volume. */
	async removeContainer(name: string): Promise<void> {
		await this.inspectManaged(name)
		const container = this.docker.getContainer(name)
		try { await container.stop() } catch { /* already stopped or not running */ }
		try {
			await container.remove()
		} catch (err) {
			if (this.isNotFound(err)) throw new DockerTypes.ContainerNotFoundError()
			if (this.isRemovalInProgress(err)) throw new DockerTypes.ContainerRemovalInProgressError()
			throw err
		}
	}

	async restartContainer(name: string): Promise<void> {
		await this.inspectManaged(name)
		const container = this.docker.getContainer(name)
		try {
			await container.restart()
		} catch (err) {
			if (this.isNotFound(err)) throw new DockerTypes.ContainerNotFoundError()
			throw err
		}
	}

	async getDetailedStatus(name: string): Promise<DockerTypes.DetailedStatus> {
		const info = await this.inspectManaged(name)
		const imageRef = info.Config.Image
		const colonIdx = imageRef.lastIndexOf(':')
		const image = colonIdx > 0 ? imageRef.substring(0, colonIdx) : imageRef
		const imageTag = colonIdx > 0 ? imageRef.substring(colonIdx + 1) : null
		const isRunning = info.State.Status === 'running'
		const uptimeSeconds = isRunning && info.State.StartedAt && info.State.StartedAt !== '0001-01-01T00:00:00Z'
			? Math.floor((Date.now() - new Date(info.State.StartedAt).getTime()) / 1000)
			: null
		return { state: info.State.Status, image, imageTag, imageDigest: info.Image, uptimeSeconds }
	}

	/** Removes a single image tag - a 404 (no such image) or 409 (still referenced by a container) are
	 *  both treated as success, per the cleanup job's "suppress and consider done" contract. */
	async removeImage(imageRef: string): Promise<void> {
		try {
			await this.docker.getImage(imageRef).remove()
		} catch (err) {
			if (this.isNotFound(err) || this.isConflict(err)) return
			throw err
		}
	}

	/** Mirrors `docker rmi $(docker images -q)` - attempts to remove every locally cached image;
	 *  ones still referenced by a container fail with a 409 and are silently kept. */
	async removeUnusedImages(): Promise<void> {
		const images = await this.docker.listImages()
		await Promise.all(images.map((image) => this.removeImage(image.Id)))
	}

	async getLogs(name: string, tailLines: number): Promise<string[]> {
		await this.inspectManaged(name)
		const container = this.docker.getContainer(name)
		try {
			const raw = await container.logs({ stdout: true, stderr: true, tail: tailLines, follow: false }) as unknown as Buffer
			return this.demuxLogBuffer(raw).split('\n').filter((line) => line.length > 0)
		} catch (err) {
			if (this.isNotFound(err)) throw new DockerTypes.ContainerNotFoundError()
			throw err
		}
	}

	async getStatus(name: string): Promise<DockerTypes.ServiceStatus> {
		const info = await this.inspectManaged(name)
		return {
			state: info.State.Status,
			startedAt: info.State.StartedAt,
			exitCode: info.State.ExitCode,
		}
	}

	/** Execs `cmd` inside `containerName` and streams its stdout directly to `dest`, a file on the local
	 *  filesystem (e.g. `pg_dump ... > file`) via a real `pipe()` chain end to end, so a slow disk
	 *  write applies backpressure all the way back to the container instead of piling the whole dump
	 *  up in memory (see DockerFrameDemux for why this can't just use dockerode's own demuxStream).
	 *  Throws `ExecFailedError` (carrying stderr) on a non-zero exit. */
	async execToStream(containerName: string, cmd: string[], dest: NodeJS.WritableStream): Promise<void> {
		const exec = await this.createExec(containerName, cmd, false)
		const stream = await exec.start({ hijack: true, stdin: false })
		const demux = new DockerFrameDemux()

		await new Promise<void>((resolve, reject) => {
			stream.pipe(demux).pipe(dest)
			dest.on('finish', resolve)
			stream.on('error', reject)
			demux.on('error', reject)
			dest.on('error', reject)
		})

		await this.assertExecSucceeded(exec, demux.stderrChunks)
	}

	/** Execs `cmd` inside `containerName`, streaming `input` (e.g. a file, `pg_restore ... < file`) in
	 *  as stdin via a real `pipe()` chain, same backpressure reasoning as `execToStream`. Throws
	 *  `ExecFailedError` (carrying stderr) on a non-zero exit. */
	async execFromStream(containerName: string, cmd: string[], input: NodeJS.ReadableStream): Promise<void> {
		await this.execWithStdin(containerName, cmd, input)
	}

	/** Same as `execFromStream`, but for a short in-memory command (e.g. a SQL script) instead of a
	 *  file on disk - used for small one-off statements where writing a temp file would be overkill. */
	async execFromString(containerName: string, cmd: string[], input: string): Promise<void> {
		await this.execWithStdin(containerName, cmd, Readable.from([Buffer.from(input, 'utf8')]))
	}

	/** Shared plumbing for execFromStream/execFromString - pipes `input` in as the exec's stdin. The
	 *  container's own stdout/stderr output is drained (not written anywhere - callers don't need the
	 *  command's stdout) but still must be consumed so the exec isn't stalled waiting for a reader. */
	private async execWithStdin(containerName: string, cmd: string[], input: NodeJS.ReadableStream): Promise<void> {
		const exec = await this.createExec(containerName, cmd, true)
		const stream = await exec.start({ hijack: true, stdin: true })
		const demux = new DockerFrameDemux()

		const outputDrained = new Promise<void>((resolve, reject) => {
			stream.pipe(demux)
			demux.resume()
			stream.on('end', resolve)
			stream.on('error', reject)
			demux.on('error', reject)
		})

		await new Promise<void>((resolve, reject) => {
			input.on('error', reject)
			input.pipe(stream)
			input.on('end', resolve)
		})
		await outputDrained

		await this.assertExecSucceeded(exec, demux.stderrChunks)
	}

	private async createExec(containerName: string, cmd: string[], attachStdin: boolean): Promise<Dockerode.Exec> {
		await this.inspectManaged(containerName)
		const container = this.docker.getContainer(containerName)
		try {
			return await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, AttachStdin: attachStdin })
		} catch (err) {
			if (this.isNotFound(err)) throw new DockerTypes.ContainerNotFoundError()
			throw err
		}
	}

	/** The bind sources of every container Enver manages, stopped ones included, since Docker mounts
	 *  them again whenever they start. */
	async listBindMounts(): Promise<DockerTypes.BindMounts[]> {
		const containers = await this.docker.listContainers({ all: true })
		return containers
			.filter((c) => c.Labels?.[DockerTypes.MANAGED_LABEL] === 'true' || this.onManagedNetwork([c.HostConfig?.NetworkMode ?? '', ...Object.keys(c.NetworkSettings?.Networks ?? {})]))
			.map((c) => ({
				containerName: (c.Names[0] ?? c.Id).replace(/^\//, ''),
				sources: c.Mounts.filter((m) => m.Type === 'bind').map((m) => m.Source),
			}))
	}

	private async inspectManaged(name: string): Promise<Dockerode.ContainerInspectInfo> {
		let info: Dockerode.ContainerInspectInfo
		try {
			info = await this.docker.getContainer(name).inspect()
		} catch (err) {
			if (this.isNotFound(err)) throw new DockerTypes.ContainerNotFoundError()
			throw err
		}
		if (!this.isManaged(info)) throw new DockerTypes.ContainerNotManagedError(name)
		return info
	}

	private isManaged(info: Dockerode.ContainerInspectInfo): boolean {
		if (info.Config.Labels?.[DockerTypes.MANAGED_LABEL] === 'true') return true
		return this.onManagedNetwork([info.HostConfig.NetworkMode ?? '', ...Object.keys(info.NetworkSettings?.Networks ?? {})])
	}

	private onManagedNetwork(this: void, networks: string[]): boolean {
		return networks.some((network) => network.startsWith(DockerTypes.MANAGED_NETWORK_PREFIX))
	}

	private async assertExecSucceeded(exec: Dockerode.Exec, stderrChunks: Buffer[]): Promise<void> {
		const { ExitCode } = await exec.inspect()
		if (ExitCode) throw new DockerTypes.ExecFailedError(ExitCode, Buffer.concat(stderrChunks).toString('utf8'))
	}

	/** Strips the 8-byte frame headers Docker prefixes stdout/stderr chunks with when the container has no TTY. */
	private demuxLogBuffer(buffer: Buffer): string {
		const chunks: Buffer[] = []
		let offset = 0
		while (offset + 8 <= buffer.length) {
			const size = buffer.readUInt32BE(offset + 4)
			const start = offset + 8
			const end = start + size
			chunks.push(buffer.subarray(start, end))
			offset = end
		}
		return Buffer.concat(chunks).toString('utf8')
	}

	private isNotFound(err: unknown): boolean {
		return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404
	}

	private isConflict(err: unknown): boolean {
		return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 409
	}

	/** Docker returns a generic 409 for several distinct conflicts (e.g. "cannot remove a running
	 *  container") - narrow to the specific transient race where a removal is already underway. */
	private isRemovalInProgress(err: unknown): boolean {
		return this.isConflict(err) && typeof (err as { message?: unknown }).message === 'string'
			&& (err as { message: string }).message.includes('already in progress')
	}
}
