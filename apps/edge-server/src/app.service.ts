import { DockerService } from '@enver/domains/docker/docker.service'
import { KubernetesService } from '@enver/domains/kubernetes/kubernetes.service'
import { EdgeProtocol } from '@enver/edge-protocol'
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { WebSocket } from 'ws'

import { config } from './app.config'
import { toDockerOptions, toKubernetesOptions } from './edge-server-options'
import { HostDirsService } from './host-dirs/host-dirs.service'
import { InstanceLocator } from './instance-locator'
import { JobProcessorService } from './job-processor/job-processor.service'
import { MetricsService } from './metrics/metrics.service'
import { SelfUpdateService } from './self-update/self-update.service'
import { SettingsClient } from './settings-client'

type JobWithId = EdgeProtocol.EdgeServerJob & { jobId?: string }

const DESIRED_STATE_SYNC_INTERVAL_MS = 60_000
const SETTINGS_REFRESH_INTERVAL_MS = 60_000
const IMAGE_CLEANUP_INTERVAL_MS = 3_600_000
const METRICS_REPORT_INTERVAL_MS = 60_000
const SEEN_JOB_TTL_MS = 120_000

@Injectable()
export class AppService implements OnApplicationBootstrap, OnApplicationShutdown {
	private logger = new Logger(AppService.name)
	private ws: WebSocket | null = null
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private statusPushTimer: ReturnType<typeof setInterval> | null = null
	private desiredStateSyncTimer: ReturnType<typeof setInterval> | null = null
	private settingsRefreshTimer: ReturnType<typeof setInterval> | null = null
	private imageCleanupTimer: ReturnType<typeof setInterval> | null = null
	private metricsReportTimer: ReturnType<typeof setInterval> | null = null
	private seenJobs = new Map<string, number>()

	constructor(
		private jobProcessor: JobProcessorService,
		private dockerService: DockerService,
		private kubernetesService: KubernetesService,
		private settingsClient: SettingsClient,
		private metricsService: MetricsService,
		private selfUpdate: SelfUpdateService,
		private instance: InstanceLocator,
		private hostDirs: HostDirsService,
	) {}

	onApplicationBootstrap() {
		this.selfUpdate.onStatusChange((payload) => this.sendAgentStatus(payload))
		this.connect()
		void this.syncDesiredStates()
		this.statusPushTimer = setInterval(() => {
			void this.jobProcessor.pushAllStatuses((msg) => this.ws?.send(JSON.stringify(msg)))
		}, 4_000)
		this.desiredStateSyncTimer = setInterval(() => {
			void this.syncDesiredStates()
		}, DESIRED_STATE_SYNC_INTERVAL_MS)
		this.settingsRefreshTimer = setInterval(() => {
			void this.refreshSettings()
		}, SETTINGS_REFRESH_INTERVAL_MS)
		this.imageCleanupTimer = setInterval(() => {
			void this.jobProcessor.runPeriodicImageCleanup()
		}, IMAGE_CLEANUP_INTERVAL_MS)
		this.metricsReportTimer = setInterval(() => {
			this.reportMetrics()
		}, METRICS_REPORT_INTERVAL_MS)
	}

	onApplicationShutdown() {
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.statusPushTimer) clearInterval(this.statusPushTimer)
		if (this.desiredStateSyncTimer) clearInterval(this.desiredStateSyncTimer)
		if (this.settingsRefreshTimer) clearInterval(this.settingsRefreshTimer)
		if (this.imageCleanupTimer) clearInterval(this.imageCleanupTimer)
		if (this.metricsReportTimer) clearInterval(this.metricsReportTimer)
		this.ws?.close()
	}

	/** Proactive push (not a response to a query), same WebSocket connection as status/logs responses. */
	private reportMetrics(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return
		const payload = this.metricsService.collect()
		this.ws.send(JSON.stringify({ type: 'metrics.report', payload } satisfies EdgeProtocol.MetricsReportMessage))
	}

	private sendAgentStatus(payload: EdgeProtocol.AgentStatusMessage['payload']): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return
		this.ws.send(JSON.stringify({ type: 'agent.status', payload } satisfies EdgeProtocol.AgentStatusMessage))
	}

	/** Re-downloads docker/kubernetes settings (via ETag - a 304 short-circuits to a no-op) and
	 *  rebuilds both clients so changes made in the UI (docker socket path, kubernetes connection,
	 *  ingress class, cert issuer) take effect without restarting the edge-server process. */
	private async refreshSettings(): Promise<void> {
		const result = await this.settingsClient.fetch()
		if (result === null || result === 'unchanged') return
		this.dockerService.reconfigure(toDockerOptions(result))
		this.kubernetesService.reconfigure(toKubernetesOptions(result))
		this.jobProcessor.setImageCleanupMode(result.imageCleanupMode)
		this.hostDirs.configure(result)
		this.selfUpdate.setAutoUpdate(result.autoUpdate !== false)
	}

	private async syncDesiredStates(): Promise<void> {
		try {
			const res = await fetch(`${this.instance.apiUrl}/v1/edge-servers/desired-state`, {
				headers: { Authorization: `Bearer ${config.token}` },
			})
			if (res.status === 421) {
				await this.instance.relocate()
				return
			}
			if (!res.ok) {
				this.logger.error(`Failed to sync desired states: HTTP ${res.status}`)
				return
			}
			const specs = await res.json() as EdgeProtocol.DesiredStateServiceSpec[]
			this.jobProcessor.syncDesiredStates(specs)
			this.logger.debug(`Desired state synced: ${specs.length} service(s)`)
		} catch (err) {
			this.logger.error({ err }, 'Failed to sync desired states from API')
		}
	}

	private connect() {
		const wsUrl = this.instance.apiUrl.replace(/^http/, 'ws') + '/edge-servers/websocket'
		const ws = new WebSocket(wsUrl, {
			headers: { Authorization: `Bearer ${config.token}` },
		})
		this.ws = ws

		ws.on('open', () => {
			this.logger.log(`WebSocket connected to ${wsUrl}`)
			this.selfUpdate.onConnected()
		})

		ws.on('message', (data) => {
			try {
				const buf = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data
				const job = JSON.parse(buf.toString()) as JobWithId
				void this.dispatch(job)
			} catch (err) {
				this.logger.error({ err }, 'Failed to parse job message')
			}
		})

		ws.on('error', (err: Error) => {
			this.logger.error({ err }, 'WebSocket error')
		})

		ws.on('close', (code: number, reason: Buffer) => {
			this.logger.warn(`WebSocket closed: ${code} ${reason.toString()}`)
			this.selfUpdate.onDisconnected()
			this.scheduleReconnect(code === EdgeProtocol.ACCOUNT_MOVED_CLOSE_CODE)
		})
	}

	/** Acks on receipt, not on completion: the api resends an unacked job after 10 s, so a slow or
	 *  failing job would otherwise run several times. A redelivered job is only acked again. */
	private async dispatch(job: JobWithId): Promise<void> {
		if (job.jobId) {
			this.ws?.send(JSON.stringify({ type: 'ack', jobId: job.jobId }))
			if (this.isDuplicateJob(job.jobId)) return
		}
		if (job.type === 'agent.update') {
			void this.selfUpdate.checkNow(true)
			return
		}
		try {
			await this.jobProcessor.process(job, (msg) => this.ws?.send(JSON.stringify(msg)))
		} catch (err) {
			this.logger.error({ err }, `Failed to process job ${job.jobId ?? job.type}`)
		}
	}

	private isDuplicateJob(jobId: string): boolean {
		const now = Date.now()
		for (const [id, expiresAt] of this.seenJobs) {
			if (expiresAt <= now) this.seenJobs.delete(id)
		}
		if (this.seenJobs.has(jobId)) return true
		this.seenJobs.set(jobId, now + SEEN_JOB_TTL_MS)
		return false
	}

	/** `moved`: the account moved to another instance - the hub says which before the agent reconnects. */
	private scheduleReconnect(moved = false) {
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		this.reconnectTimer = setTimeout(async () => {
			if (moved) await this.instance.relocate()
			this.logger.log('Reconnecting...')
			const result = await this.settingsClient.fetch()
			if (result === null) {
				// API not ready yet — keep retrying until it comes back
				this.scheduleReconnect()
				return
			}
			this.connect()
		}, 5000)
	}
}
