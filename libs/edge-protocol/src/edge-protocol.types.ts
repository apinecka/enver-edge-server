/** The contract between the edge server agent (apps/edge-server) and the Enver instance it connects to: the
 *  jobs the instance sends over the agent's websocket, the messages the agent answers with, and what
 *  the agent reads over HTTP. The agent is published as open source, so nothing the agent imports
 *  may depend on the rest of the Enver codebase. */
export namespace EdgeProtocol {
	/** The close code of a websocket (the web's and the agent's) whose account moved to another instance. */
	export const ACCOUNT_MOVED_CLOSE_CODE = 4421

	/** An env file is named relative to the edge server's env-files directory: segments may not
	 *  start with a dot, so neither `..` nor an absolute path can leave it. */
	export const ENV_FILE_REGEX = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/
	export const ENV_FILE_MAX_LENGTH = 255

	export enum ImageCleanupMode {
		/** Only remove the image tag a swapped-out container was running, right after the swap. */
		swappedOnly = 'swapped-only',
		/** Periodically (hourly) and after every swap, remove every image not referenced by a running container. */
		allUnused = 'all-unused',
	}

	/** Whether the edge server agent can replace itself, as it reports it. */
	export enum AgentSelfUpdate {
		supported = 'supported',
		/** Not started by the installer's launcher (dev run, an install that predates self-update). */
		noLauncher = 'no-launcher',
		/** The launcher runs it, but its versions directory isn't writable for the agent's user. */
		notWritable = 'not-writable',
	}

	export enum AgentUpdateState {
		idle = 'idle',
		checking = 'checking',
		downloading = 'downloading',
		restarting = 'restarting',
	}

	// ─── HTTP (agent → instance) ──────────────────────────────────────────────

	/** `GET /v1/edge-servers/settings`, conditional on its `ETag`. */
	export interface Settings {
		edgeServerGuid: string
		accountGuid: string
		name: string
		dockerSocketPath: string | null
		kubernetesApiUrl: string | null
		kubernetesToken: string | null
		kubernetesCaCert: string | null
		kubernetesIngressClassName: string | null
		kubernetesCertIssuerName: string | null
		imageCleanupMode: ImageCleanupMode
		autoUpdate: boolean
		/** Without a CA certificate the cluster's certificate is checked against the system CAs, unless
		 *  this is set. An agent treats it as false when absent. */
		kubernetesSkipTlsVerify?: boolean
		/** Host directories Docker volumes are confined to (`HostPaths`); empty or absent: no volumes. */
		volumesDirs?: string[]
		/** Host directories database backups are confined to; empty or absent: no backups. */
		backupsDirs?: string[]
	}

	export interface AgentReleasePackage {
		/** Debian architecture (`amd64`, `arm64`) for Linux, `universal` for macOS. */
		arch: string
		sha256: string
		sizeBytes: number
		signatureAvailable: boolean
		/** Relative to the api URL. */
		downloadPath: string
		signaturePath: string
	}

	/** `GET /v1/edge-servers/installer/release`. */
	export interface AgentRelease {
		version: string
		linux: AgentReleasePackage | null
		macos: AgentReleasePackage | null
		signingKeyAvailable: boolean
	}

	// ─── Edge server jobs ─────────────────────────────────────────────────────

	type EdgeServerJobBase = {
		edgeServerGuid: string
	}

	export type PortMapping = {
		internalPort: number
		exposedPort: number
		/** Kubernetes-only: publish on `exposedPort` through a LoadBalancer Service. */
		loadBalancer?: boolean
	}

	/** Kubernetes-only: routes `host` + `path` prefix on the ingress controller to `internalPort`. */
	export type IngressRule = {
		host: string
		path: string
		internalPort: number
		tls: boolean
	}

	/** Kubernetes-only container requests/limits, in Kubernetes quantity notation. */
	export type ResourceRequirements = {
		cpuRequest?: string
		cpuLimit?: string
		memoryRequest?: string
		memoryLimit?: string
	}

	export type VolumeMapping = {
		internalPath: string
		externalPath: string
	}

	/** Decrypted registry credentials, sent with the job that needs them - they travel like the
	 *  service's secret variables, over the agent's own connection only. */
	export type RegistryAuth = {
		type: string
		username?: string
		token?: string
		registryUrl?: string
	}

	export type ServiceActionJobPayload = {
		environmentServiceGuid: string
		environmentGuid: string
		action: 'start' | 'stop' | 'restart'
		deploymentType: 'kubernetes' | 'docker'
		subdomain: string
		serviceName: string
		image: string
		containerName: string
		command?: string[]
		ports: PortMapping[]
		volumes: VolumeMapping[]
		replicas: number
		env?: { name: string; value: string }[]
		registryAuth?: RegistryAuth
		ingressRules?: IngressRule[]
		resources?: ResourceRequirements
		/** Env file the agent reads on its own host (relative to its env-files directory) and lays
		 *  over `env` - its values never reach Enver. */
		envFile?: string
	}

	export type ServiceActionJob = EdgeServerJobBase & {
		type: 'service.action'
		payload: ServiceActionJobPayload
	}

	export type ServiceStatusQueryItem = {
		environmentServiceGuid: string
		environmentGuid: string
		deploymentType: 'kubernetes' | 'docker'
		containerName: string
	}

	export type ServiceStatusQueryPayload = {
		queryId: string
		services: ServiceStatusQueryItem[]
	}

	export type ServiceStatusQueryJob = EdgeServerJobBase & {
		type: 'status.query'
		payload: ServiceStatusQueryPayload
	}

	export type DesiredStateServiceSpec = {
		environmentServiceGuid: string
		environmentGuid: string
		desiredState: 'running' | 'stopped'
		deploymentType: 'kubernetes' | 'docker'
		containerName: string
		command?: string[]
		image: string
		ports: PortMapping[]
		volumes: VolumeMapping[]
		env?: { name: string; value: string }[]
		replicas: number
		subdomain: string
		serviceName: string
		registryAuth?: RegistryAuth
		ingressRules?: IngressRule[]
		resources?: ResourceRequirements
		/** Env file the agent reads on its own host (relative to its env-files directory) and lays
		 *  over `env` - its values never reach Enver. */
		envFile?: string
	}

	export type DesiredStateSyncJob = EdgeServerJobBase & {
		type: 'desired-state.sync'
		payload: {
			services: DesiredStateServiceSpec[]
		}
	}

	export type LogsQueryPayload = {
		queryId: string
		environmentGuid: string
		deploymentType: 'kubernetes' | 'docker'
		containerName: string
	}

	export type LogsQueryJob = EdgeServerJobBase & {
		type: 'logs.query'
		payload: LogsQueryPayload
	}

	// ─── DB backups (Postgres, docker-only) ───────────────────────────────────

	export type BackupListPayload = {
		queryId: string
		backupDirPath: string
	}

	export type BackupListJob = EdgeServerJobBase & {
		type: 'backup.list'
		payload: BackupListPayload
	}

	export type BackupDeletePayload = {
		queryId: string
		backupDirPath: string
		fileName: string
	}

	export type BackupDeleteJob = EdgeServerJobBase & {
		type: 'backup.delete'
		payload: BackupDeletePayload
	}

	export type BackupCreatePayload = {
		jobId: string
		environmentServiceGuid: string
		containerName: string
		backupDirPath: string
		retentionCount: number
	}

	export type BackupCreateJob = EdgeServerJobBase & {
		type: 'backup.create'
		payload: BackupCreatePayload
	}

	export type BackupRestorePayload = {
		jobId: string
		environmentServiceGuid: string
		containerName: string
		backupDirPath: string
		fileName: string
	}

	export type BackupRestoreJob = EdgeServerJobBase & {
		type: 'backup.restore'
		payload: BackupRestorePayload
	}

	/** Handled by the api instance holding the edge server's socket, which closes it: sent after the
	 *  token was rotated or the edge server deleted. Never forwarded to the edge server itself. */
	export type ConnectionRevokeJob = EdgeServerJobBase & {
		type: 'connection.revoke'
		/** `account_moved`: the account moved to another instance - the agent asks the hub again. */
		payload: { reason: 'token_rotated' | 'deleted' | 'account_moved' }
	}

	/** Asks the agent to check for a newer version now and apply it, even with auto-update off. */
	export type AgentUpdateJob = EdgeServerJobBase & {
		type: 'agent.update'
		payload: { requestedAt: string }
	}

	/** Discriminated union — narrows automatically on `job.type`. */
	export type EdgeServerJob =
		| ServiceActionJob
		| ServiceStatusQueryJob
		| DesiredStateSyncJob
		| LogsQueryJob
		| BackupListJob
		| BackupDeleteJob
		| BackupCreateJob
		| BackupRestoreJob
		| ConnectionRevokeJob
		| AgentUpdateJob

	// ─── Status response (edge server → API, via WebSocket) ──────────────────

	export type ServiceStatusResult = {
		environmentServiceGuid: string
		status: 'running' | 'stopped' | 'starting' | 'stopping' | 'pulling' | 'restarting'
		image: string | null
		imageTag: string | null
		imageDigest: string | null
		uptimeSeconds: number | null
		/** Message from the last failed start/stop/restart attempt (Docker/Kubernetes), if any. */
		errorMessage: string | null
	}

	export type ServiceStatusResponseMessage = {
		type: 'status.response'
		queryId: string
		results: ServiceStatusResult[]
	}

	export type LogsResponseMessage = {
		type: 'logs.response'
		queryId: string
		lines: string[]
	}

	export type BackupFileInfo = {
		fileName: string
		sizeBytes: number
		createdAt: string
	}

	export type BackupListResponseMessage = {
		type: 'backup.list.response'
		queryId: string
		files: BackupFileInfo[]
		errorMessage: string | null
	}

	export type BackupDeleteResponseMessage = {
		type: 'backup.delete.response'
		queryId: string
		success: boolean
		errorMessage: string | null
	}

	/** Async result of a fire-and-forget `backup.create`/`backup.restore` job - cached by the API
	 *  (keyed by jobId) for the frontend's progress modal to poll, mirroring how `service.action`
	 *  results surface via a cached errorMessage rather than a direct response to the dispatch. */
	export type BackupResultMessage = {
		type: 'backup.result'
		jobId: string
		environmentServiceGuid: string
		success: boolean
		errorMessage: string | null
		fileName: string | null
	}

	/** Host metrics for the machine the edge server itself runs on - pushed proactively (not in
	 *  response to a query), same WebSocket connection as status/logs responses. */
	export type MetricsReportPayload = {
		recordedAt: string
		cpuPercent: number
		memoryUsedBytes: number
		memoryTotalBytes: number
		swapUsedBytes: number
		swapTotalBytes: number
		diskUsedBytes: number
		diskTotalBytes: number
		uptimeSeconds: number
	}

	export type MetricsReportMessage = {
		type: 'metrics.report'
		payload: MetricsReportPayload
	}

	/** Sent on every (re)connect and whenever the agent's self-update state changes. */
	export type AgentStatusMessage = {
		type: 'agent.status'
		payload: {
			version: string
			platform: string
			selfUpdate: 'supported' | 'no-launcher' | 'not-writable'
			state: 'idle' | 'checking' | 'downloading' | 'restarting'
			lastCheckAt: string | null
			lastError: string | null
			rolledBackVersion: string | null
		}
	}
}
