import { ApiException, AppsV1Api, CoreV1Api, KubeConfig, KubernetesObject, KubernetesObjectApi, PatchStrategy, V1Deployment, V1Ingress, V1IngressRule, V1Namespace, V1NetworkPolicy, V1PersistentVolumeClaim, V1Pod, V1PodDisruptionBudget, V1Secret, V1Service } from '@kubernetes/client-node'
import { Injectable } from '@nestjs/common'
import { createHash } from 'crypto'

import { KubernetesTypes } from './kubernetes.types'

@Injectable()
export class KubernetesService {
	private appsApi!: AppsV1Api
	private coreApi!: CoreV1Api
	private objectApi!: KubernetesObjectApi
	private ingressClassName?: string
	private certIssuerName?: string

	constructor(options: KubernetesTypes.Options) {
		this.reconfigure(options)
	}

	/** Rebuilds the API clients from fresh connection settings. dockerode/KubeConfig clients are
	 *  cheap, stateless wrappers around an HTTP client, so this can be called repeatedly as settings
	 *  are refreshed at runtime (see apps/edge-server AppService's periodic settings poll) without
	 *  restarting the process. */
	reconfigure(options: KubernetesTypes.Options): void {
		const kc = new KubeConfig()
		if (options.apiUrl && options.token) {
			kc.loadFromOptions({
				clusters: [{ name: 'enver', server: options.apiUrl, skipTLSVerify: options.skipTlsVerify ?? false, caData: this.toCaData(options.caCert) }],
				users: [{ name: 'enver', token: options.token }],
				contexts: [{ name: 'enver', cluster: 'enver', user: 'enver' }],
				currentContext: 'enver',
			})
		} else if (options.kubeconfigPath) {
			kc.loadFromFile(options.kubeconfigPath)
		} else {
			kc.loadFromCluster()
		}
		this.appsApi = kc.makeApiClient(AppsV1Api)
		this.coreApi = kc.makeApiClient(CoreV1Api)
		this.objectApi = KubernetesObjectApi.makeApiClient(kc)
		this.ingressClassName = options.ingressClassName || undefined
		this.certIssuerName = options.certIssuerName || undefined
	}

	/** The settings ask for the PEM certificate, while KubeConfig's caData is the base64 form found in
	 *  a kubeconfig's `certificate-authority-data`; either is accepted. */
	private toCaData(caCert: string | undefined): string | undefined {
		if (!caCert) return undefined
		return caCert.includes('-----BEGIN') ? Buffer.from(caCert.trim() + '\n').toString('base64') : caCert.trim()
	}

	/** One namespace per environment, under the `baseline` Pod Security Standard and a default-deny
	 *  ingress NetworkPolicy, so an environment can neither reach another one's pods nor escape to the
	 *  node. Ports meant to be reachable from outside are opened per service by the `-public` policy. */
	async ensureEnvironmentNamespace(namespace: string, environmentGuid: string): Promise<void> {
		this.assertDnsLabel(namespace)
		const ns: V1Namespace = {
			apiVersion: 'v1',
			kind: 'Namespace',
			metadata: {
				name: namespace,
				labels: {
					...this.managedLabels(),
					[KubernetesTypes.ENVIRONMENT_LABEL]: environmentGuid,
					'pod-security.kubernetes.io/enforce': KubernetesTypes.POD_SECURITY_LEVEL,
					'pod-security.kubernetes.io/enforce-version': 'latest',
					'pod-security.kubernetes.io/warn': KubernetesTypes.POD_SECURITY_LEVEL,
				},
			},
		}
		await this.apply(ns)

		const isolation: V1NetworkPolicy = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: KubernetesTypes.ISOLATION_POLICY_NAME, namespace, labels: this.managedLabels() },
			spec: {
				podSelector: {},
				policyTypes: ['Ingress'],
				ingress: [{ _from: [{ podSelector: {} }] }],
			},
		}
		await this.applyOwned(isolation)
	}

	/** Upserts the dockerconfigjson Secret a Deployment's `imagePullSecrets` references - called
	 *  before every start/restart so rotated credentials stay fresh even when the Deployment itself is untouched. */
	async ensurePullSecret(namespace: string, name: string, auth: KubernetesTypes.RegistryAuth): Promise<void> {
		await this.applyOwned(this.buildPullSecretSpec(namespace, name, auth))
	}

	/** Brings every object of one environment service to the given config: its env Secret, volume
	 *  claims, Deployment, in-cluster Service, LoadBalancer Service, public NetworkPolicy, Ingress and
	 *  PodDisruptionBudget. Objects the config no longer needs are deleted, claims never are. */
	async deployService(config: KubernetesTypes.ServiceConfig): Promise<void> {
		this.assertResourceName(config.name)
		const { namespace, name } = config

		const env = config.env ?? []
		await (env.length > 0 ? this.applyOwned(this.buildEnvSecretSpec(config)) : this.deleteIfExists('v1', 'Secret', namespace, this.envSecretName(name)))

		for (const claim of this.buildVolumeClaimSpecs(config)) {
			await this.applyOwned(claim)
		}

		const existing = await this.readDeployment(namespace, name)
		const previousRestartedAt = existing?.spec?.template?.metadata?.annotations?.[KubernetesTypes.RESTARTED_AT_ANNOTATION]
		const restartedAt = config.restart ? new Date().toISOString() : previousRestartedAt
		await this.applyOwned(this.buildDeploymentSpec(config, restartedAt), existing)

		await (config.ports.length > 0 ? this.applyOwned(this.buildServiceSpec(config)) : this.deleteIfExists('v1', 'Service', namespace, name))

		const loadBalancerPorts = config.ports.filter((p) => p.loadBalancer)
		await (loadBalancerPorts.length > 0
			? this.applyOwned(this.buildLoadBalancerSpec(config, loadBalancerPorts))
			: this.deleteIfExists('v1', 'Service', namespace, this.loadBalancerName(name)))

		const publicPorts = [...new Set([...loadBalancerPorts.map((p) => p.internalPort), ...config.ingressRules.map((r) => r.internalPort)])]
		await (publicPorts.length > 0
			? this.applyOwned(this.buildPublicPolicySpec(config, publicPorts))
			: this.deleteIfExists('networking.k8s.io/v1', 'NetworkPolicy', namespace, this.publicPolicyName(name)))

		await (config.ingressRules.length > 0
			? this.applyOwned(this.buildIngressSpec(config))
			: this.deleteIfExists('networking.k8s.io/v1', 'Ingress', namespace, name))

		await (config.replicas > 1
			? this.applyOwned(this.buildDisruptionBudgetSpec(config))
			: this.deleteIfExists('policy/v1', 'PodDisruptionBudget', namespace, name))
	}

	async stopDeployment(namespace: string, name: string): Promise<void> {
		try {
			await this.appsApi.patchNamespacedDeployment({ name, namespace, body: [{ op: 'add', path: '/spec/replicas', value: 0 }] })
		} catch (err) {
			if (err instanceof ApiException && err.code === 404) throw new KubernetesTypes.DeploymentNotFoundError()
			throw err
		}
	}

	async getDetailedStatus(namespace: string, name: string): Promise<KubernetesTypes.DetailedStatus> {
		const deployment = await this.readDeployment(namespace, name)
		if (!deployment) throw new KubernetesTypes.DeploymentNotFoundError()

		const desiredReplicas = deployment.spec?.replicas ?? 0
		const readyReplicas = deployment.status?.readyReplicas ?? 0
		let phase: KubernetesTypes.DeploymentPhase
		if (desiredReplicas === 0) phase = 'stopped'
		else if (this.isRolledOut(deployment, desiredReplicas)) phase = 'running'
		else phase = 'pending'

		const imageRef = deployment.spec?.template?.spec?.containers?.[0]?.image ?? ''
		const colonIdx = imageRef.lastIndexOf(':')
		const image = colonIdx > imageRef.lastIndexOf('/') ? imageRef.substring(0, colonIdx) : imageRef
		const imageTag = colonIdx > imageRef.lastIndexOf('/') ? imageRef.substring(colonIdx + 1) : null

		let imageDigest: string | null = null
		let uptimeSeconds: number | null = null
		let problem: string | null = null
		try {
			const pods = await this.coreApi.listNamespacedPod({ namespace, labelSelector: `app=${name}` })
			const running = pods.items.find((p) => p.status?.phase === 'Running' && !p.metadata?.deletionTimestamp)
			if (running) {
				imageDigest = running.status?.containerStatuses?.[0]?.imageID ?? null
				const startTime = running.status?.startTime
				if (startTime) uptimeSeconds = Math.floor((Date.now() - new Date(startTime).getTime()) / 1000)
			}
			if (phase === 'pending') problem = this.findPodProblem(pods.items) ?? this.findDeploymentProblem(deployment)
		} catch { /* best-effort */ }

		return { phase, image, imageTag, imageDigest, uptimeSeconds, desiredReplicas, readyReplicas, problem }
	}

	/** The old pods stay available during a rolling update, so availability alone would call a
	 *  restart finished before it began. */
	private isRolledOut(deployment: V1Deployment, desiredReplicas: number): boolean {
		const status = deployment.status
		return (status?.observedGeneration ?? 0) >= (deployment.metadata?.generation ?? 0)
			&& (status?.updatedReplicas ?? 0) >= desiredReplicas
			&& (status?.availableReplicas ?? 0) >= desiredReplicas
			&& (status?.replicas ?? 0) <= desiredReplicas
	}

	async getPodLogs(namespace: string, name: string, tailLines: number): Promise<string[]> {
		const pods = await this.coreApi.listNamespacedPod({ namespace, labelSelector: `app=${name}` })
		const pod = pods.items.find((p) => p.status?.phase === 'Running') ?? pods.items[0]
		if (!pod?.metadata?.name) throw new KubernetesTypes.PodNotFoundError()

		const log = await this.coreApi.readNamespacedPodLog({ name: pod.metadata.name, namespace, tailLines })
		return log.split('\n').filter((line) => line.length > 0)
	}

	/** Server-side apply under one field manager: a field the previous apply set and this one omits
	 *  is removed, so each apply leaves exactly the given spec behind. */
	private async apply(spec: KubernetesObject): Promise<void> {
		await this.objectApi.patch(spec, undefined, undefined, KubernetesTypes.FIELD_MANAGER, true, PatchStrategy.ServerSideApply)
	}

	/** Like apply, but first deletes an object of the same name that enver didn't label as its own.
	 *  Edge servers before server-side apply wrote with create/replace, and server-side apply never
	 *  removes fields another manager owns - a leftover hostPath volume would make the pod invalid. */
	private async applyOwned(spec: KubernetesObject, existing?: KubernetesObject | null): Promise<void> {
		const current = existing !== undefined ? existing : await this.readObject(spec)
		if (current && current.metadata?.labels?.[KubernetesTypes.MANAGED_BY_LABEL] !== KubernetesTypes.MANAGED_BY_VALUE) {
			await this.objectApi.delete(this.header(spec), undefined, undefined, undefined, undefined, 'Background')
			await this.waitUntilGone(spec)
		}
		await this.apply(spec)
	}

	/** An apply to an object that is still terminating would land on it and vanish with it. */
	private async waitUntilGone(spec: KubernetesObject): Promise<void> {
		for (let attempt = 0; attempt < KubernetesTypes.DELETE_WAIT_ATTEMPTS; attempt++) {
			if (!(await this.readObject(spec))) return
			await new Promise((resolve) => setTimeout(resolve, KubernetesTypes.DELETE_WAIT_INTERVAL_MS))
		}
		throw new Error(`${spec.kind} ${spec.metadata?.name} is still being deleted`)
	}

	private async readObject(spec: KubernetesObject): Promise<KubernetesObject | null> {
		try {
			return await this.objectApi.read(this.header(spec))
		} catch (err) {
			if (err instanceof ApiException && err.code === 404) return null
			throw err
		}
	}

	private async readDeployment(namespace: string, name: string): Promise<V1Deployment | null> {
		try {
			return await this.appsApi.readNamespacedDeployment({ name, namespace })
		} catch (err) {
			if (err instanceof ApiException && err.code === 404) return null
			throw err
		}
	}

	private async deleteIfExists(apiVersion: string, kind: string, namespace: string, name: string): Promise<void> {
		try {
			await this.objectApi.delete({ apiVersion, kind, metadata: { name, namespace } })
		} catch (err) {
			if (!(err instanceof ApiException) || err.code !== 404) throw err
		}
	}

	private header(spec: KubernetesObject): { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } } {
		return {
			apiVersion: spec.apiVersion ?? '',
			kind: spec.kind ?? '',
			metadata: { name: spec.metadata?.name ?? '', ...(spec.metadata?.namespace ? { namespace: spec.metadata.namespace } : {}) },
		}
	}

	/** The name is also the Service's DNS name, which must be an RFC 1035 label, and the pods' `app`
	 *  label value; the length leaves room for the suffixed objects. */
	private assertResourceName(name: string): void {
		this.assertDnsLabel(name)
		if (name.length > KubernetesTypes.MAX_NAME_LENGTH || !/^[a-z]/.test(name)) {
			throw new KubernetesTypes.InvalidResourceNameError(
				`Container name "${name}" is not usable in Kubernetes: it must start with a letter and be at most ${KubernetesTypes.MAX_NAME_LENGTH} characters long`,
			)
		}
	}

	private assertDnsLabel(name: string): void {
		if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(name)) {
			throw new KubernetesTypes.InvalidResourceNameError(`"${name}" is not a valid Kubernetes name (lowercase letters, digits and dashes, at most 63 characters)`)
		}
	}

	private findPodProblem(pods: V1Pod[]): string | null {
		for (const pod of pods) {
			if (pod.metadata?.deletionTimestamp) continue
			for (const status of [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])]) {
				const waiting = status.state?.waiting
				if (waiting?.reason && KubernetesTypes.POD_PROBLEM_REASONS.has(waiting.reason)) {
					return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason
				}
			}
			const unschedulable = pod.status?.conditions?.find((c) => c.type === 'PodScheduled' && c.status === 'False')
			if (unschedulable?.reason) return unschedulable.message ? `${unschedulable.reason}: ${unschedulable.message}` : unschedulable.reason
		}
		return null
	}

	/** Pods rejected at admission (Pod Security, quota) never exist, so only the ReplicaSet's failure
	 *  surfaces on the Deployment. */
	private findDeploymentProblem(deployment: V1Deployment): string | null {
		const failure = deployment.status?.conditions?.find((c) => c.type === 'ReplicaFailure' && c.status === 'True')
		return failure?.message ?? null
	}

	private managedLabels(): Record<string, string> {
		return { [KubernetesTypes.MANAGED_BY_LABEL]: KubernetesTypes.MANAGED_BY_VALUE }
	}

	private serviceLabels(config: KubernetesTypes.ServiceConfig): Record<string, string> {
		return { ...this.managedLabels(), [KubernetesTypes.ENVIRONMENT_SERVICE_LABEL]: config.environmentServiceGuid }
	}

	private envSecretName(name: string): string {
		return `${name}-env`
	}

	private loadBalancerName(name: string): string {
		return `${name}-lb`
	}

	private publicPolicyName(name: string): string {
		return `${name}-public`
	}

	private claimName(externalPath: string): string {
		const cleaned = externalPath.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').substring(0, 63).replace(/-+$/, '')
		if (!cleaned) throw new KubernetesTypes.InvalidResourceNameError(`Volume "${externalPath}" does not give a usable PersistentVolumeClaim name`)
		return cleaned
	}

	private portName(port: number): string {
		return `tcp-${port}`
	}

	private buildEnvSecretSpec(config: KubernetesTypes.ServiceConfig): V1Secret {
		return {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: this.envSecretName(config.name), namespace: config.namespace, labels: this.serviceLabels(config) },
			type: 'Opaque',
			// Not stringData: the server folds it into data, so server-side apply would never prune a removed key.
			data: Object.fromEntries((config.env ?? []).map((e) => [e.name, Buffer.from(e.value).toString('base64')])),
		}
	}

	/** Claims are shared by name within the environment, like Docker named volumes. Their spec is
	 *  immutable once bound, so a re-apply only ever repeats the same request. */
	private buildVolumeClaimSpecs(config: KubernetesTypes.ServiceConfig): V1PersistentVolumeClaim[] {
		const names = [...new Set(config.volumes.map((v) => this.claimName(v.externalPath)))]
		return names.map((name) => ({
			apiVersion: 'v1',
			kind: 'PersistentVolumeClaim',
			metadata: { name, namespace: config.namespace, labels: this.managedLabels() },
			spec: {
				accessModes: ['ReadWriteOnce'],
				resources: { requests: { storage: KubernetesTypes.VOLUME_CLAIM_SIZE } },
			},
		}))
	}

	private buildDeploymentSpec(config: KubernetesTypes.ServiceConfig, restartedAt: string | undefined): V1Deployment {
		const claimNames = [...new Set(config.volumes.map((v) => this.claimName(v.externalPath)))]
		const volumes = claimNames.map((claimName) => ({ name: claimName, persistentVolumeClaim: { claimName } }))
		const volumeMounts = config.volumes.map((v) => ({ name: this.claimName(v.externalPath), mountPath: v.internalPath }))
		const env = config.env ?? []
		const annotations: Record<string, string> = {
			...(restartedAt ? { [KubernetesTypes.RESTARTED_AT_ANNOTATION]: restartedAt } : {}),
			...(env.length > 0 ? { [KubernetesTypes.ENV_CHECKSUM_ANNOTATION]: this.envChecksum(env) } : {}),
		}
		const requests = {
			...(config.cpuRequest ? { cpu: config.cpuRequest } : {}),
			...(config.memoryRequest ? { memory: config.memoryRequest } : {}),
		}
		const limits = {
			...(config.cpuLimit ? { cpu: config.cpuLimit } : {}),
			...(config.memoryLimit ? { memory: config.memoryLimit } : {}),
		}
		const firstPort = config.ports[0]?.internalPort

		return {
			apiVersion: 'apps/v1',
			kind: 'Deployment',
			metadata: { name: config.name, namespace: config.namespace, labels: this.serviceLabels(config) },
			spec: {
				replicas: config.replicas,
				selector: { matchLabels: { app: config.name } },
				// A ReadWriteOnce claim can't be mounted by a surge pod on another node, so services with
				// volumes replace their pods instead of rolling them.
				strategy: config.volumes.length > 0
					? { type: 'Recreate' }
					: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
				template: {
					metadata: {
						labels: { app: config.name, ...this.serviceLabels(config) },
						...(Object.keys(annotations).length > 0 ? { annotations } : {}),
					},
					spec: {
						automountServiceAccountToken: false,
						enableServiceLinks: false,
						topologySpreadConstraints: [{
							maxSkew: 1,
							topologyKey: 'kubernetes.io/hostname',
							whenUnsatisfiable: 'ScheduleAnyway',
							labelSelector: { matchLabels: { app: config.name } },
						}],
						containers: [{
							name: config.name,
							image: config.image,
							// Mirrors Docker mode's explicit pullImage() before every start/restart - without
							// this, kubelet may reuse a cached image for mutable tags like `latest`.
							imagePullPolicy: 'Always',
							ports: config.ports.map((p) => ({ name: this.portName(p.internalPort), containerPort: p.internalPort })),
							volumeMounts,
							...(config.command ? { command: config.command } : {}),
							...(env.length > 0 ? { envFrom: [{ secretRef: { name: this.envSecretName(config.name) } }] } : {}),
							...(firstPort ? { readinessProbe: { tcpSocket: { port: firstPort }, periodSeconds: 5, failureThreshold: 3 } } : {}),
							resources: { requests, limits },
						}],
						volumes,
						...(config.imagePullSecretName ? { imagePullSecrets: [{ name: config.imagePullSecretName }] } : {}),
					},
				},
			},
		}
	}

	/** Same DNS name and ports as the Docker container on its environment network, so placeholders
	 *  resolving to `<container>:<internal port>` work unchanged. */
	private buildServiceSpec(config: KubernetesTypes.ServiceConfig): V1Service {
		return {
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: config.name, namespace: config.namespace, labels: this.serviceLabels(config) },
			spec: {
				type: 'ClusterIP',
				selector: { app: config.name },
				ports: config.ports.map((p) => ({ name: this.portName(p.internalPort), port: p.internalPort, targetPort: p.internalPort })),
			},
		}
	}

	private buildLoadBalancerSpec(config: KubernetesTypes.ServiceConfig, ports: KubernetesTypes.PortMapping[]): V1Service {
		return {
			apiVersion: 'v1',
			kind: 'Service',
			metadata: { name: this.loadBalancerName(config.name), namespace: config.namespace, labels: this.serviceLabels(config) },
			spec: {
				type: 'LoadBalancer',
				selector: { app: config.name },
				ports: ports.map((p) => ({ name: this.portName(p.internalPort), port: p.exposedPort, targetPort: p.internalPort })),
			},
		}
	}

	/** Opens the ports that are public anyway (behind an Ingress or a LoadBalancer) to every source.
	 *  Allowing the ingress controller by namespace would not work when it runs on the host network. */
	private buildPublicPolicySpec(config: KubernetesTypes.ServiceConfig, ports: number[]): V1NetworkPolicy {
		return {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: this.publicPolicyName(config.name), namespace: config.namespace, labels: this.serviceLabels(config) },
			spec: {
				podSelector: { matchLabels: { app: config.name } },
				policyTypes: ['Ingress'],
				ingress: [{ ports: ports.map((port) => ({ protocol: 'TCP', port })) }],
			},
		}
	}

	/** Served on the ingress controller's HTTP/HTTPS entry points (80/443 by default). TLS rules get a
	 *  cert-manager certificate when the edge server names a ClusterIssuer, otherwise the controller's
	 *  default certificate. */
	private buildIngressSpec(config: KubernetesTypes.ServiceConfig): V1Ingress {
		const hosts = [...new Set(config.ingressRules.map((r) => r.host))]
		const rules: V1IngressRule[] = hosts.map((host) => ({
			host,
			http: {
				paths: config.ingressRules
					.filter((r) => r.host === host)
					.map((r) => ({ path: r.path, pathType: 'Prefix', backend: { service: { name: config.name, port: { number: r.internalPort } } } })),
			},
		}))
		const tlsHosts = [...new Set(config.ingressRules.filter((r) => r.tls).map((r) => r.host))]
		const certIssuer = tlsHosts.length > 0 ? this.certIssuerName : undefined

		return {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'Ingress',
			metadata: {
				name: config.name,
				namespace: config.namespace,
				labels: this.serviceLabels(config),
				...(certIssuer ? { annotations: { 'cert-manager.io/cluster-issuer': certIssuer } } : {}),
			},
			spec: {
				...(this.ingressClassName ? { ingressClassName: this.ingressClassName } : {}),
				rules,
				...(tlsHosts.length > 0 ? { tls: [{ hosts: tlsHosts, ...(certIssuer ? { secretName: `${config.name}-tls` } : {}) }] } : {}),
			},
		}
	}

	private buildDisruptionBudgetSpec(config: KubernetesTypes.ServiceConfig): V1PodDisruptionBudget {
		return {
			apiVersion: 'policy/v1',
			kind: 'PodDisruptionBudget',
			metadata: { name: config.name, namespace: config.namespace, labels: this.serviceLabels(config) },
			spec: {
				maxUnavailable: 1,
				selector: { matchLabels: { app: config.name } },
			},
		}
	}

	/** Pods read the env Secret only when they start, so a changed value has to change the pod
	 *  template to roll them - the same way Docker recreates the container. */
	private envChecksum(env: Array<{ name: string; value: string }>): string {
		const sorted = [...env].sort((a, b) => a.name.localeCompare(b.name))
		return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').substring(0, 16)
	}

	/** Docker's `docker login` populates the same `auths` map into ~/.docker/config.json - this
	 *  mirrors that format so the kubelet can authenticate the pull with no other host-side state. */
	private buildPullSecretSpec(namespace: string, name: string, auth: KubernetesTypes.RegistryAuth): V1Secret {
		const serveraddress = auth.registryUrl ?? 'https://index.docker.io/v1/'
		const username = auth.username ?? ''
		const password = auth.password ?? ''
		const dockerconfigjson = {
			auths: {
				[serveraddress]: {
					username,
					password,
					auth: Buffer.from(`${username}:${password}`).toString('base64'),
				},
			},
		}
		return {
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name, namespace, labels: this.managedLabels() },
			type: 'kubernetes.io/dockerconfigjson',
			data: { '.dockerconfigjson': Buffer.from(JSON.stringify(dockerconfigjson)).toString('base64') },
		}
	}
}
