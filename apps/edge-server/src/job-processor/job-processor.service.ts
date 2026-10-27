import { DockerService } from '@enver/domains/docker/docker.service'
import { DockerTypes } from '@enver/domains/docker/docker.types'
import { KubernetesService } from '@enver/domains/kubernetes/kubernetes.service'
import { KubernetesTypes } from '@enver/domains/kubernetes/kubernetes.types'
import { EdgeProtocol } from '@enver/edge-protocol'
import { Injectable, Logger } from '@nestjs/common'

import { config } from '../app.config'
import { BackupsService } from '../backups/backups.service'
import { EnvFilesService } from '../env-files/env-files.service'
import { HostDirsService } from '../host-dirs/host-dirs.service'

@Injectable()
export class JobProcessorService {
	private readonly logger = new Logger(JobProcessorService.name)
	private watchedServices: EdgeProtocol.ServiceStatusQueryItem[] = []
	private desiredStates = new Map<string, EdgeProtocol.DesiredStateServiceSpec>()
	/** Message from each service's last failed start/stop/restart attempt - cleared on the next success. */
	private lastActionErrors = new Map<string, string>()
	/** Phase of the in-flight start/stop/restart action for a service - overlays the raw Docker/Kubernetes
	 *  state in status checks so pulling/starting/restarting/stopping are visible while an action is running.
	 *  Cleared once the action settles (success or failure), letting the real state take over. */
	private transitions = new Map<string, EdgeProtocol.ServiceStatusResult['status']>()
	private imageCleanupMode: EdgeProtocol.ImageCleanupMode = EdgeProtocol.ImageCleanupMode.swappedOnly

	constructor(
		private dockerService: DockerService,
		private kubernetesService: KubernetesService,
		private backupsService: BackupsService,
		private envFilesService: EnvFilesService,
		private hostDirs: HostDirsService,
	) {}

	async process(job: EdgeProtocol.EdgeServerJob, send: (msg: unknown) => void): Promise<void> {
		if (job.type === 'service.action') {
			if (job.payload.action !== 'stop') {
				this.watch({
					environmentServiceGuid: job.payload.environmentServiceGuid,
					environmentGuid: job.payload.environmentGuid,
					deploymentType: job.payload.deploymentType,
					containerName: job.payload.containerName,
				})
			}
			await this.handleServiceAction(job.payload)
			void this.pushServiceStatus(job.payload, send)
		} else if (job.type === 'status.query') {
			this.watchedServices = job.payload.services
			const response = await this.buildStatusResponse(job.payload.queryId, job.payload.services)
			send(response)
		} else if (job.type === 'desired-state.sync') {
			this.syncDesiredStates(job.payload.services)
		} else if (job.type === 'logs.query') {
			const response = await this.buildLogsResponse(job.payload)
			send(response)
		} else if (job.type === 'backup.list') {
			send(await this.backupsService.buildListResponse(job.payload))
		} else if (job.type === 'backup.delete') {
			send(await this.backupsService.buildDeleteResponse(job.payload))
		} else if (job.type === 'backup.create') {
			// Fire-and-forget: the real outcome arrives later as its own `backup.result` message.
			void this.backupsService.handleCreate(job.payload, send)
		} else if (job.type === 'backup.restore') {
			void this.backupsService.handleRestore(job.payload, send)
		}
	}

	setImageCleanupMode(mode: EdgeProtocol.ImageCleanupMode): void {
		this.imageCleanupMode = mode
	}

	/** Hourly tick from AppService - sweeps every unreferenced image, mirroring `docker rmi $(docker
	 *  images -q)`. A no-op in 'swapped-only' mode, where cleanup only happens right after a swap. */
	async runPeriodicImageCleanup(): Promise<void> {
		if (this.imageCleanupMode !== EdgeProtocol.ImageCleanupMode.allUnused) return
		await this.dockerService.removeUnusedImages()
	}

	syncDesiredStates(services: EdgeProtocol.DesiredStateServiceSpec[]): void {
		this.desiredStates.clear()
		for (const s of services) {
			this.desiredStates.set(s.environmentServiceGuid, s)
			this.watch({
				environmentServiceGuid: s.environmentServiceGuid,
				environmentGuid: s.environmentGuid,
				deploymentType: s.deploymentType,
				containerName: s.containerName,
			})
		}
	}

	/** Replaces an already watched service, since its container name changes with an environment rename. */
	private watch(item: EdgeProtocol.ServiceStatusQueryItem): void {
		const index = this.watchedServices.findIndex((w) => w.environmentServiceGuid === item.environmentServiceGuid)
		if (index === -1) this.watchedServices.push(item)
		else this.watchedServices[index] = item
	}

	async pushAllStatuses(send: (msg: unknown) => void): Promise<void> {
		if (this.watchedServices.length === 0) return
		const response = await this.buildStatusResponse('', this.watchedServices)
		send(response)
		await this.reconcile(response.results)
	}

	private async handleServiceAction(p: EdgeProtocol.ServiceActionJobPayload): Promise<void> {
		this.logger.log(`${p.action} ${p.containerName} (${p.deploymentType})`)
		try {
			if (p.deploymentType === 'docker') {
				await this.handleDockerAction(await this.withEnvFile(p))
			} else if (p.deploymentType === 'kubernetes') {
				await this.handleKubernetesAction(await this.withEnvFile(p))
			} else {
				this.logger.warn(`Unknown deployment type: ${p.deploymentType as string}`)
				return
			}
			this.lastActionErrors.delete(p.environmentServiceGuid)
		} catch (err) {
			this.lastActionErrors.set(p.environmentServiceGuid, this.extractErrorMessage(err))
			throw err
		} finally {
			this.transitions.delete(p.environmentServiceGuid)
		}
	}

	/** Read on every start, so editing the file on this host and restarting the service applies it. */
	private async withEnvFile(p: EdgeProtocol.ServiceActionJobPayload): Promise<EdgeProtocol.ServiceActionJobPayload> {
		if (!p.envFile || p.action === 'stop') return p
		return { ...p, env: this.envFilesService.merge(p.env, await this.envFilesService.read(p.envFile)) }
	}

	/** Docker/docker-modem errors already carry a readable `.message`; Kubernetes' ApiException
	 *  wraps the actual admission/validation message in `.body.message` instead. */
	private extractErrorMessage(err: unknown): string {
		if (err && typeof err === 'object' && 'body' in err) {
			const body = (err as { body?: unknown }).body
			if (body && typeof body === 'object' && 'message' in body && typeof (body as { message: unknown }).message === 'string') {
				return (body as { message: string }).message
			}
		}
		if (err instanceof Error) return err.message
		if (typeof err === 'string') return err
		return 'Unknown error'
	}

	private async handleDockerAction(payload: EdgeProtocol.ServiceActionJobPayload): Promise<void> {
		const networkName = `enver-${payload.environmentGuid}`
		switch (payload.action) {
			case 'start':
			case 'restart': {
				await Promise.all(payload.volumes.map((v) => this.hostDirs.volumePath(v.externalPath)))
				this.transitions.set(payload.environmentServiceGuid, 'pulling')
				const [previousImage] = await Promise.all([
					this.previousImageRef(payload.containerName),
					this.dockerService.pullImage(payload.image, this.toDockerAuth(payload.registryAuth)),
				])
				this.transitions.set(payload.environmentServiceGuid, payload.action === 'restart' ? 'restarting' : 'starting')
				await this.dockerService.ensureNetwork(networkName)
				await this.hostDirs.withMountLock(async () => {
					// Resolved again after the pull, since a pull can take long enough to change what a path leads to.
					const volumes = await Promise.all(payload.volumes.map(async (v) => ({ ...v, externalPath: await this.hostDirs.volumePath(v.externalPath) })))
					await this.hostDirs.assertVolumesFit(payload.containerName, volumes.map((v) => v.externalPath), await this.dockerService.listBindMounts())
					await this.dockerService.createContainer({
						name: payload.containerName,
						image: payload.image,
						ports: payload.ports,
						volumes,
						env: payload.env,
						command: payload.command,
						networkName,
						portsHostIp: config.docker.portsHostIp,
					})
					await this.dockerService.startContainer(payload.containerName)
				})
				void this.cleanupAfterSwap(previousImage, payload.image)
				break
			}
			case 'stop':
				this.transitions.set(payload.environmentServiceGuid, 'stopping')
				try { await this.dockerService.removeContainer(payload.containerName) }
				catch (err) {
					// Both are expected transient states, not failures - a removal already underway
					// converges to "stopped" on its own; the next reconcile poll re-checks and retries if not.
					if (!(err instanceof DockerTypes.ContainerNotFoundError) && !(err instanceof DockerTypes.ContainerRemovalInProgressError)) throw err
				}
				break
		}
	}

	/** Image ref (`name:tag`) the container was running before this swap, or null if it has no prior
	 *  container (first-ever start). Read before pulling the new image, since createContainer below
	 *  replaces the container and its old image reference becomes unrecoverable. */
	private async previousImageRef(containerName: string): Promise<string | null> {
		try {
			const status = await this.dockerService.getDetailedStatus(containerName)
			return status.imageTag ? `${status.image}:${status.imageTag}` : status.image
		} catch (err) {
			if (err instanceof DockerTypes.ContainerNotFoundError) return null
			throw err
		}
	}

	/** Fire-and-forget so a cleanup failure never fails the swap itself - the job has already been
	 *  acked successfully by the time this runs. */
	private async cleanupAfterSwap(previousImage: string | null, newImage: string): Promise<void> {
		try {
			if (this.imageCleanupMode === EdgeProtocol.ImageCleanupMode.allUnused) {
				await this.dockerService.removeUnusedImages()
			} else if (previousImage && previousImage !== newImage) {
				await this.dockerService.removeImage(previousImage)
			}
		} catch (err) {
			this.logger.warn({ err }, `Image cleanup after swap failed for ${newImage}`)
		}
	}

	private async handleKubernetesAction(p: EdgeProtocol.ServiceActionJobPayload): Promise<void> {
		const namespace = this.namespace(p.environmentGuid)
		const name = p.containerName
		const imagePullSecretName = p.registryAuth ? `${name}-pull-secret` : undefined
		switch (p.action) {
			case 'start':
			case 'restart':
				this.transitions.set(p.environmentServiceGuid, p.action === 'restart' ? 'restarting' : 'starting')
				await this.kubernetesService.ensureEnvironmentNamespace(namespace, p.environmentGuid)
				if (p.registryAuth && imagePullSecretName) {
					await this.kubernetesService.ensurePullSecret(namespace, imagePullSecretName, {
						username: p.registryAuth.username,
						password: p.registryAuth.token,
						registryUrl: p.registryAuth.registryUrl,
					})
				}
				// Every start applies the whole spec, so a changed image, variable, port or ingress rule
				// takes effect the same way Docker's recreated container picks it up.
				await this.kubernetesService.deployService({
					namespace,
					environmentServiceGuid: p.environmentServiceGuid,
					name,
					image: p.image,
					ports: p.ports,
					volumes: p.volumes,
					ingressRules: p.ingressRules ?? [],
					replicas: p.replicas,
					env: p.env,
					command: p.command,
					...p.resources,
					imagePullSecretName,
					restart: p.action === 'restart',
				})
				break
			case 'stop':
				this.transitions.set(p.environmentServiceGuid, 'stopping')
				try { await this.kubernetesService.stopDeployment(namespace, name) }
				catch (err) { if (!(err instanceof KubernetesTypes.DeploymentNotFoundError)) throw err }
				break
		}
	}

	/** One namespace per environment - keeps Kubernetes-deployed services network-isolated
	 *  per-environment, mirroring the per-environment Docker network created in handleDockerAction. */
	private namespace(environmentGuid: string): string {
		return `env-${environmentGuid}`
	}

	private toDockerAuth(auth: EdgeProtocol.RegistryAuth | undefined): DockerTypes.RegistryAuth | undefined {
		if (!auth) return undefined
		return { username: auth.username, password: auth.token, serveraddress: auth.registryUrl }
	}

	private async reconcile(results: EdgeProtocol.ServiceStatusResult[]): Promise<void> {
		for (const result of results) {
			const spec = this.desiredStates.get(result.environmentServiceGuid)
			if (!spec) continue
			if (spec.desiredState === 'running' && result.status === 'stopped') {
				this.logger.log(`Reconciling ${spec.containerName}: starting (desired=running, actual=stopped)`)
				await this.handleServiceAction({ ...spec, action: 'start' }).catch((err: unknown) =>
					this.logger.error({ err }, `Reconcile failed: start ${spec.containerName}`)
				)
			} else if (spec.desiredState === 'stopped' && result.status === 'running') {
				this.logger.log(`Reconciling ${spec.containerName}: stopping (desired=stopped, actual=running)`)
				await this.handleServiceAction({ ...spec, action: 'stop' }).catch((err: unknown) =>
					this.logger.error({ err }, `Reconcile failed: stop ${spec.containerName}`)
				)
			}
		}
	}

	private async pushServiceStatus(p: EdgeProtocol.ServiceActionJobPayload, send: (msg: unknown) => void): Promise<void> {
		const result = await this.checkServiceStatus({
			environmentServiceGuid: p.environmentServiceGuid,
			environmentGuid: p.environmentGuid,
			deploymentType: p.deploymentType,
			containerName: p.containerName,
		}).catch((): EdgeProtocol.ServiceStatusResult => ({
			environmentServiceGuid: p.environmentServiceGuid,
			status: 'stopped', image: null, imageTag: null, imageDigest: null, uptimeSeconds: null,
			errorMessage: this.lastActionErrors.get(p.environmentServiceGuid) ?? null,
		}))
		send({ type: 'status.response', queryId: '', results: [result] } satisfies EdgeProtocol.ServiceStatusResponseMessage)
	}

	private async buildStatusResponse(queryId: string, services: EdgeProtocol.ServiceStatusQueryItem[]): Promise<EdgeProtocol.ServiceStatusResponseMessage> {
		const results = await Promise.all(
			services.map((s) =>
				this.checkServiceStatus(s).catch((): EdgeProtocol.ServiceStatusResult => ({
					environmentServiceGuid: s.environmentServiceGuid,
					status: 'stopped', image: null, imageTag: null, imageDigest: null, uptimeSeconds: null,
					errorMessage: this.lastActionErrors.get(s.environmentServiceGuid) ?? null,
				}))
			)
		)
		return { type: 'status.response', queryId, results }
	}

	private async checkServiceStatus(s: EdgeProtocol.ServiceStatusQueryItem): Promise<EdgeProtocol.ServiceStatusResult> {
		if (s.deploymentType === 'docker') return this.checkDockerStatus(s)
		return this.checkKubernetesStatus(s)
	}

	private async buildLogsResponse(payload: EdgeProtocol.LogsQueryPayload): Promise<EdgeProtocol.LogsResponseMessage> {
		try {
			const lines = payload.deploymentType === 'docker'
				? await this.dockerService.getLogs(payload.containerName, config.logs.maxLines)
				: await this.kubernetesService.getPodLogs(this.namespace(payload.environmentGuid), payload.containerName, config.logs.maxLines)
			return { type: 'logs.response', queryId: payload.queryId, lines }
		} catch {
			return { type: 'logs.response', queryId: payload.queryId, lines: [] }
		}
	}

	private async checkDockerStatus(s: EdgeProtocol.ServiceStatusQueryItem): Promise<EdgeProtocol.ServiceStatusResult> {
		const errorMessage = this.lastActionErrors.get(s.environmentServiceGuid) ?? null
		const transition = this.transitions.get(s.environmentServiceGuid)
		try {
			const d = await this.dockerService.getDetailedStatus(s.containerName)
			return {
				environmentServiceGuid: s.environmentServiceGuid,
				status: transition ?? this.dockerStateToStatus(d.state),
				image: d.image, imageTag: d.imageTag, imageDigest: d.imageDigest, uptimeSeconds: d.uptimeSeconds,
				errorMessage,
			}
		} catch (err) {
			if (err instanceof DockerTypes.ContainerNotFoundError)
				return { environmentServiceGuid: s.environmentServiceGuid, status: transition ?? 'stopped', image: null, imageTag: null, imageDigest: null, uptimeSeconds: null, errorMessage }
			if (err instanceof DockerTypes.ContainerNotManagedError)
				return { environmentServiceGuid: s.environmentServiceGuid, status: 'stopped', image: null, imageTag: null, imageDigest: null, uptimeSeconds: null, errorMessage: err.message }
			throw err
		}
	}

	private async checkKubernetesStatus(s: EdgeProtocol.ServiceStatusQueryItem): Promise<EdgeProtocol.ServiceStatusResult> {
		const errorMessage = this.lastActionErrors.get(s.environmentServiceGuid) ?? null
		const transition = this.transitions.get(s.environmentServiceGuid)
		try {
			const d = await this.kubernetesService.getDetailedStatus(this.namespace(s.environmentGuid), s.containerName)
			return {
				environmentServiceGuid: s.environmentServiceGuid,
				status: transition ?? this.k8sPhaseToStatus(d.phase),
				image: d.image, imageTag: d.imageTag, imageDigest: d.imageDigest, uptimeSeconds: d.uptimeSeconds,
				errorMessage: errorMessage ?? d.problem,
			}
		} catch (err) {
			if (err instanceof KubernetesTypes.DeploymentNotFoundError)
				return { environmentServiceGuid: s.environmentServiceGuid, status: transition ?? 'stopped', image: null, imageTag: null, imageDigest: null, uptimeSeconds: null, errorMessage }
			throw err
		}
	}

	private dockerStateToStatus(state: string): EdgeProtocol.ServiceStatusResult['status'] {
		if (state === 'running') return 'running'
		if (state === 'restarting') return 'starting'
		return 'stopped'
	}

	private k8sPhaseToStatus(phase: KubernetesTypes.DeploymentPhase): EdgeProtocol.ServiceStatusResult['status'] {
		if (phase === 'running') return 'running'
		if (phase === 'pending') return 'starting'
		return 'stopped'
	}
}
