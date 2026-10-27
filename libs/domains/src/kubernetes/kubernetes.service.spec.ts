import { ApiException, KubernetesObject } from '@kubernetes/client-node'

import { KubernetesService } from './kubernetes.service'
import { KubernetesTypes } from './kubernetes.types'

const mockObjectPatch = jest.fn()
const mockObjectRead = jest.fn()
const mockObjectDelete = jest.fn()
const mockReadNamespacedDeployment = jest.fn()
const mockPatchNamespacedDeployment = jest.fn()
const mockListNamespacedPod = jest.fn()
const mockReadNamespacedPodLog = jest.fn()

const mockLoadFromOptions = jest.fn()
const mockLoadFromFile = jest.fn()
const mockLoadFromCluster = jest.fn()

// The real @kubernetes/client-node package is ESM-only, which breaks jest.requireActual() under
// this repo's CJS Jest config - so the mock defines minimal stand-ins rather than wrapping the real module.
jest.mock('@kubernetes/client-node', () => {
	class MockApiException extends Error {
		code: number
		constructor(code: number) { super('ApiException'); this.code = code }
	}
	class MockCoreV1Api {}
	class MockAppsV1Api {}
	return {
		ApiException: MockApiException,
		CoreV1Api: MockCoreV1Api,
		AppsV1Api: MockAppsV1Api,
		PatchStrategy: { ServerSideApply: 'application/apply-patch+yaml' },
		KubernetesObjectApi: {
			makeApiClient: jest.fn(() => ({ patch: mockObjectPatch, read: mockObjectRead, delete: mockObjectDelete })),
		},
		KubeConfig: jest.fn().mockImplementation(() => ({
			loadFromOptions: mockLoadFromOptions,
			loadFromFile: mockLoadFromFile,
			loadFromCluster: mockLoadFromCluster,
			makeApiClient: jest.fn((Api: unknown) => {
				if (Api === MockCoreV1Api) return { listNamespacedPod: mockListNamespacedPod, readNamespacedPodLog: mockReadNamespacedPodLog }
				return { readNamespacedDeployment: mockReadNamespacedDeployment, patchNamespacedDeployment: mockPatchNamespacedDeployment }
			}),
		})),
	}
})

interface Loose { [key: string]: Loose; [index: number]: Loose }
type AnyObject = KubernetesObject & { spec?: Loose; data?: Record<string, string>; type?: string }

function makeService(options: Partial<KubernetesTypes.Options> = { kubeconfigPath: '/fake/kubeconfig' }): KubernetesService {
	return new KubernetesService(new KubernetesTypes.Options(options))
}

function makeApiException(code: number): ApiException<unknown> {
	return new (ApiException as unknown as new (code: number) => ApiException<unknown>)(code)
}

function makeConfig(overrides: Partial<KubernetesTypes.ServiceConfig> = {}): KubernetesTypes.ServiceConfig {
	return {
		namespace: 'env-1',
		environmentServiceGuid: 'es-guid',
		name: 'web',
		image: 'nginx:1.27',
		ports: [{ internalPort: 80, exposedPort: 8080 }],
		volumes: [],
		ingressRules: [],
		replicas: 1,
		...overrides,
	}
}

function applied(kind: string, name?: string): AnyObject | undefined {
	const calls = mockObjectPatch.mock.calls as Array<[AnyObject]>
	return calls.map((c) => c[0]).reverse().find((o) => o.kind === kind && (name === undefined || o.metadata?.name === name))
}

function deleted(kind: string, name: string): boolean {
	return (mockObjectDelete.mock.calls as Array<[AnyObject]>).some((c) => c[0].kind === kind && c[0].metadata?.name === name)
}

function makeDeploymentStatus(overrides: { replicas?: number; generation?: number; status?: Record<string, unknown> } = {}) {
	return {
		metadata: { generation: overrides.generation ?? 2 },
		spec: { replicas: overrides.replicas ?? 2, template: { spec: { containers: [{ image: 'registry.example.com:5000/team/app:1.4' }] } } },
		status: { observedGeneration: 2, replicas: 2, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2, ...overrides.status },
	}
}

describe('KubernetesService', () => {
	let service: KubernetesService

	beforeEach(() => {
		jest.clearAllMocks()
		mockObjectPatch.mockResolvedValue({})
		mockObjectRead.mockRejectedValue(makeApiException(404))
		mockObjectDelete.mockResolvedValue({})
		mockReadNamespacedDeployment.mockRejectedValue(makeApiException(404))
		mockListNamespacedPod.mockResolvedValue({ items: [] })
		service = makeService()
	})

	describe('reconfigure (constructor)', () => {
		beforeEach(() => {
			jest.clearAllMocks()
		})

		it('loads from apiUrl/token when both are set', () => {
			makeService({ apiUrl: 'https://10.0.0.5:6443', token: 'sa-token' })
			expect(mockLoadFromOptions).toHaveBeenCalledWith(expect.objectContaining({
				clusters: [expect.objectContaining({ server: 'https://10.0.0.5:6443', skipTLSVerify: false })],
				users: [expect.objectContaining({ token: 'sa-token' })],
			}))
			expect(mockLoadFromFile).not.toHaveBeenCalled()
		})

		it('checks the certificate against the system CAs without a CA when skipping is off', () => {
			makeService({ apiUrl: 'https://10.0.0.5:6443', token: 'sa-token', skipTlsVerify: false })
			expect(mockLoadFromOptions).toHaveBeenCalledWith(expect.objectContaining({
				clusters: [expect.objectContaining({ skipTLSVerify: false, caData: undefined })],
			}))
		})

		it('skips the check only when asked to', () => {
			makeService({ apiUrl: 'https://10.0.0.5:6443', token: 'sa-token', skipTlsVerify: true })
			expect(mockLoadFromOptions).toHaveBeenCalledWith(expect.objectContaining({
				clusters: [expect.objectContaining({ skipTLSVerify: true })],
			}))
		})

		it('base64-encodes a PEM CA certificate for caData', () => {
			const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
			makeService({ apiUrl: 'https://10.0.0.5:6443', token: 'sa-token', caCert: pem })
			expect(mockLoadFromOptions).toHaveBeenCalledWith(expect.objectContaining({
				clusters: [expect.objectContaining({ skipTLSVerify: false, caData: Buffer.from(pem + '\n').toString('base64') })],
			}))
		})

		it('passes an already base64-encoded CA certificate through', () => {
			makeService({ apiUrl: 'https://10.0.0.5:6443', token: 'sa-token', caCert: 'TUlJQg==' })
			expect(mockLoadFromOptions).toHaveBeenCalledWith(expect.objectContaining({
				clusters: [expect.objectContaining({ caData: 'TUlJQg==' })],
			}))
		})

		it('falls back to kubeconfigPath, then to in-cluster config', () => {
			makeService({ kubeconfigPath: '/fake/kubeconfig' })
			expect(mockLoadFromFile).toHaveBeenCalledWith('/fake/kubeconfig')
			makeService({})
			expect(mockLoadFromCluster).toHaveBeenCalled()
		})
	})

	describe('ensureEnvironmentNamespace', () => {
		it('applies the namespace under the baseline Pod Security Standard', async () => {
			await service.ensureEnvironmentNamespace('env-1', 'env-guid')

			expect(mockObjectPatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'Namespace' }), undefined, undefined, KubernetesTypes.FIELD_MANAGER, true, 'application/apply-patch+yaml')
			expect(applied('Namespace')?.metadata?.labels).toEqual(expect.objectContaining({
				'pod-security.kubernetes.io/enforce': 'baseline',
				[KubernetesTypes.ENVIRONMENT_LABEL]: 'env-guid',
				[KubernetesTypes.MANAGED_BY_LABEL]: KubernetesTypes.MANAGED_BY_VALUE,
			}))
		})

		it('only lets pods of the same namespace in by default', async () => {
			await service.ensureEnvironmentNamespace('env-1', 'env-guid')

			expect(applied('NetworkPolicy', KubernetesTypes.ISOLATION_POLICY_NAME)?.spec).toEqual({
				podSelector: {},
				policyTypes: ['Ingress'],
				ingress: [{ _from: [{ podSelector: {} }] }],
			})
		})

		it('rejects a namespace name that is not a DNS label', async () => {
			await expect(service.ensureEnvironmentNamespace('Env_1', 'env-guid')).rejects.toThrow(KubernetesTypes.InvalidResourceNameError)
		})
	})

	describe('ensurePullSecret', () => {
		it('applies a dockerconfigjson secret encoding the given credentials', async () => {
			await service.ensurePullSecret('ns', 'my-pull-secret', { username: 'me', password: 'tok', registryUrl: 'https://registry.example.com' })

			const body = applied('Secret', 'my-pull-secret')
			expect(body?.type).toBe('kubernetes.io/dockerconfigjson')
			const decoded = JSON.parse(Buffer.from(body?.data?.['.dockerconfigjson'] ?? '', 'base64').toString('utf8')) as { auths: Record<string, unknown> }
			expect(decoded.auths['https://registry.example.com']).toEqual({ username: 'me', password: 'tok', auth: Buffer.from('me:tok').toString('base64') })
		})

		it('defaults to the Docker Hub server address', async () => {
			await service.ensurePullSecret('ns', 'my-pull-secret', { username: 'me', password: 'tok' })

			const decoded = JSON.parse(Buffer.from(applied('Secret')?.data?.['.dockerconfigjson'] ?? '', 'base64').toString('utf8')) as { auths: Record<string, unknown> }
			expect(Object.keys(decoded.auths)).toEqual(['https://index.docker.io/v1/'])
		})
	})

	describe('deployService', () => {
		it('rejects a name that would not be a valid Service DNS name', async () => {
			await expect(service.deployService(makeConfig({ name: '1-web' }))).rejects.toThrow(KubernetesTypes.InvalidResourceNameError)
			await expect(service.deployService(makeConfig({ name: 'w'.repeat(KubernetesTypes.MAX_NAME_LENGTH + 1) }))).rejects.toThrow(KubernetesTypes.InvalidResourceNameError)
			expect(mockObjectPatch).not.toHaveBeenCalled()
		})

		it('puts the variables in a Secret the pod reads through envFrom, with a checksum that rolls the pods', async () => {
			await service.deployService(makeConfig({ env: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }] }))

			expect(applied('Secret', 'web-env')?.data).toEqual({ A: Buffer.from('1').toString('base64'), B: Buffer.from('2').toString('base64') })
			const pod = applied('Deployment')?.spec.template
			expect(pod.spec.containers[0].envFrom).toEqual([{ secretRef: { name: 'web-env' } }])
			expect(pod.spec.containers[0].env).toBeUndefined()

			mockObjectPatch.mockClear()
			await service.deployService(makeConfig({ env: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] }))
			const sameOrder = applied('Deployment')?.spec.template.metadata.annotations[KubernetesTypes.ENV_CHECKSUM_ANNOTATION]
			expect(sameOrder).toBe(pod.metadata.annotations[KubernetesTypes.ENV_CHECKSUM_ANNOTATION])

			mockObjectPatch.mockClear()
			await service.deployService(makeConfig({ env: [{ name: 'A', value: 'changed' }] }))
			expect(applied('Deployment')?.spec.template.metadata.annotations[KubernetesTypes.ENV_CHECKSUM_ANNOTATION]).not.toBe(sameOrder)
		})

		it('deletes the env Secret when the service has no variables', async () => {
			await service.deployService(makeConfig())
			expect(deleted('Secret', 'web-env')).toBe(true)
		})

		it('hardens the pod and spreads replicas across nodes', async () => {
			await service.deployService(makeConfig({ replicas: 3 }))

			const spec = applied('Deployment')?.spec
			expect(spec.replicas).toBe(3)
			expect(spec.template.spec).toEqual(expect.objectContaining({ automountServiceAccountToken: false, enableServiceLinks: false }))
			expect(spec.template.spec.topologySpreadConstraints).toEqual([expect.objectContaining({ topologyKey: 'kubernetes.io/hostname', maxSkew: 1 })])
			expect(spec.strategy).toEqual({ type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } })
			expect(spec.template.spec.containers[0].readinessProbe).toEqual(expect.objectContaining({ tcpSocket: { port: 80 } }))
		})

		it('passes the resource requests and limits', async () => {
			await service.deployService(makeConfig({ cpuRequest: '100m', memoryLimit: '256Mi' }))
			expect(applied('Deployment')?.spec.template.spec.containers[0].resources).toEqual({ requests: { cpu: '100m' }, limits: { memory: '256Mi' } })
		})

		it('mounts volumes as PersistentVolumeClaims and recreates instead of rolling', async () => {
			await service.deployService(makeConfig({ volumes: [{ internalPath: '/data', externalPath: '/srv/App Data' }, { internalPath: '/logs', externalPath: '/srv/App Data' }] }))

			const claim = applied('PersistentVolumeClaim')
			expect(claim?.metadata?.name).toBe('srv-app-data')
			expect(claim?.spec).toEqual({ accessModes: ['ReadWriteOnce'], resources: { requests: { storage: KubernetesTypes.VOLUME_CLAIM_SIZE } } })
			const spec = applied('Deployment')?.spec
			expect(spec.template.spec.volumes).toEqual([{ name: 'srv-app-data', persistentVolumeClaim: { claimName: 'srv-app-data' } }])
			expect(spec.template.spec.containers[0].volumeMounts).toEqual([{ name: 'srv-app-data', mountPath: '/data' }, { name: 'srv-app-data', mountPath: '/logs' }])
			expect(spec.strategy).toEqual({ type: 'Recreate' })
			expect(JSON.stringify(spec)).not.toContain('hostPath')
		})

		it('references the pull secret by name when set', async () => {
			await service.deployService(makeConfig({ imagePullSecretName: 'web-pull-secret' }))
			expect(applied('Deployment')?.spec.template.spec.imagePullSecrets).toEqual([{ name: 'web-pull-secret' }])
		})

		it('keeps the previous restart stamp on a start and sets a new one on a restart', async () => {
			mockReadNamespacedDeployment.mockResolvedValue({
				metadata: { labels: { [KubernetesTypes.MANAGED_BY_LABEL]: KubernetesTypes.MANAGED_BY_VALUE } },
				spec: { template: { metadata: { annotations: { [KubernetesTypes.RESTARTED_AT_ANNOTATION]: 'earlier' } } } },
			})

			await service.deployService(makeConfig())
			expect(applied('Deployment')?.spec.template.metadata.annotations[KubernetesTypes.RESTARTED_AT_ANNOTATION]).toBe('earlier')

			await service.deployService(makeConfig({ restart: true }))
			expect(applied('Deployment')?.spec.template.metadata.annotations[KubernetesTypes.RESTARTED_AT_ANNOTATION]).not.toBe('earlier')
		})

		it('deletes a Deployment enver did not label as its own before applying it', async () => {
			mockReadNamespacedDeployment.mockResolvedValue({ metadata: { name: 'web' }, spec: {} })
			mockObjectRead.mockResolvedValueOnce({ metadata: { name: 'web' } }).mockRejectedValue(makeApiException(404))

			await service.deployService(makeConfig())

			expect(deleted('Deployment', 'web')).toBe(true)
			expect(applied('Deployment')).toBeDefined()
		})

		it('exposes every port in-cluster under the container name, with named ports', async () => {
			await service.deployService(makeConfig({ ports: [{ internalPort: 80, exposedPort: 8080 }, { internalPort: 9090, exposedPort: 9090 }] }))

			const svc = applied('Service', 'web')
			expect(svc?.spec).toEqual({
				type: 'ClusterIP',
				selector: { app: 'web' },
				ports: [{ name: 'tcp-80', port: 80, targetPort: 80 }, { name: 'tcp-9090', port: 9090, targetPort: 9090 }],
			})
		})

		it('publishes load-balancer ports on their exposed port and opens them in a public policy', async () => {
			await service.deployService(makeConfig({ ports: [{ internalPort: 80, exposedPort: 8080 }, { internalPort: 5432, exposedPort: 15432, loadBalancer: true }] }))

			expect(applied('Service', 'web-lb')?.spec).toEqual({
				type: 'LoadBalancer',
				selector: { app: 'web' },
				ports: [{ name: 'tcp-5432', port: 15432, targetPort: 5432 }],
			})
			expect(applied('NetworkPolicy', 'web-public')?.spec.ingress).toEqual([{ ports: [{ protocol: 'TCP', port: 5432 }] }])
		})

		it('deletes the objects a service no longer needs', async () => {
			await service.deployService(makeConfig({ ports: [] }))

			expect(deleted('Service', 'web')).toBe(true)
			expect(deleted('Service', 'web-lb')).toBe(true)
			expect(deleted('NetworkPolicy', 'web-public')).toBe(true)
			expect(deleted('Ingress', 'web')).toBe(true)
			expect(deleted('PodDisruptionBudget', 'web')).toBe(true)
		})

		it('ignores a 404 when deleting an object that is already gone', async () => {
			mockObjectDelete.mockRejectedValue(makeApiException(404))
			await expect(service.deployService(makeConfig())).resolves.toBeUndefined()
		})

		it('keeps one pod available during voluntary disruptions when there are several replicas', async () => {
			await service.deployService(makeConfig({ replicas: 2 }))
			expect(applied('PodDisruptionBudget', 'web')?.spec).toEqual({ maxUnavailable: 1, selector: { matchLabels: { app: 'web' } } })
		})

		describe('ingress', () => {
			const rules: KubernetesTypes.IngressRule[] = [
				{ host: 'app.example.com', path: '/', internalPort: 80, tls: true },
				{ host: 'app.example.com', path: '/metrics', internalPort: 9090, tls: true },
				{ host: 'plain.example.com', path: '/', internalPort: 80, tls: false },
			]
			const ports = [{ internalPort: 80, exposedPort: 80 }, { internalPort: 9090, exposedPort: 9090 }]

			it('groups the rules by host and opens their ports in the public policy', async () => {
				await service.deployService(makeConfig({ ports, ingressRules: rules }))

				const ingress = applied('Ingress', 'web')
				expect(ingress?.spec.rules).toEqual([
					{
						host: 'app.example.com',
						http: { paths: [
							{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } },
							{ path: '/metrics', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 9090 } } } },
						] },
					},
					{ host: 'plain.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } },
				])
				expect(applied('NetworkPolicy', 'web-public')?.spec.ingress).toEqual([{ ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 9090 }] }])
			})

			it('leaves the IngressClass to the cluster default and TLS to the controller certificate without settings', async () => {
				await service.deployService(makeConfig({ ports, ingressRules: rules }))

				const ingress = applied('Ingress', 'web')
				expect(ingress?.spec.ingressClassName).toBeUndefined()
				expect(ingress?.spec.tls).toEqual([{ hosts: ['app.example.com'] }])
				expect(ingress?.metadata?.annotations).toBeUndefined()
			})

			it('uses the configured IngressClass and cert-manager ClusterIssuer', async () => {
				service = makeService({ kubeconfigPath: '/fake', ingressClassName: 'traefik', certIssuerName: 'letsencrypt' })
				await service.deployService(makeConfig({ ports, ingressRules: rules }))

				const ingress = applied('Ingress', 'web')
				expect(ingress?.spec.ingressClassName).toBe('traefik')
				expect(ingress?.spec.tls).toEqual([{ hosts: ['app.example.com'], secretName: 'web-tls' }])
				expect(ingress?.metadata?.annotations).toEqual({ 'cert-manager.io/cluster-issuer': 'letsencrypt' })
			})
		})
	})

	describe('stopDeployment', () => {
		it('scales the deployment to zero', async () => {
			mockPatchNamespacedDeployment.mockResolvedValue({})
			await service.stopDeployment('ns', 'web')
			expect(mockPatchNamespacedDeployment).toHaveBeenCalledWith({ name: 'web', namespace: 'ns', body: [{ op: 'add', path: '/spec/replicas', value: 0 }] })
		})

		it('throws DeploymentNotFoundError on a 404', async () => {
			mockPatchNamespacedDeployment.mockRejectedValue(makeApiException(404))
			await expect(service.stopDeployment('ns', 'web')).rejects.toThrow(KubernetesTypes.DeploymentNotFoundError)
		})
	})

	describe('getDetailedStatus', () => {
		it('throws DeploymentNotFoundError when the deployment does not exist', async () => {
			await expect(service.getDetailedStatus('ns', 'web')).rejects.toThrow(KubernetesTypes.DeploymentNotFoundError)
		})

		it('reports running once every replica is updated and available, and splits a registry port from the tag', async () => {
			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus())

			const status = await service.getDetailedStatus('ns', 'web')

			expect(status).toEqual(expect.objectContaining({ phase: 'running', image: 'registry.example.com:5000/team/app', imageTag: '1.4', desiredReplicas: 2, readyReplicas: 2, problem: null }))
		})

		it('reports pending while a rollout has not been observed or old pods remain', async () => {
			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus({ generation: 3 }))
			expect((await service.getDetailedStatus('ns', 'web')).phase).toBe('pending')

			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus({ status: { replicas: 3, updatedReplicas: 1 } }))
			expect((await service.getDetailedStatus('ns', 'web')).phase).toBe('pending')
		})

		it('reports stopped at zero replicas', async () => {
			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus({ replicas: 0 }))
			expect((await service.getDetailedStatus('ns', 'web')).phase).toBe('stopped')
		})

		it('explains why pending pods do not come up', async () => {
			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus({ status: { availableReplicas: 0 } }))
			mockListNamespacedPod.mockResolvedValue({ items: [{
				metadata: { name: 'web-1' },
				status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'pull access denied' } } }] },
			}] })

			expect((await service.getDetailedStatus('ns', 'web')).problem).toBe('ImagePullBackOff: pull access denied')
		})

		it('reports an unschedulable pod and an admission failure on the deployment', async () => {
			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus({ status: { availableReplicas: 0 } }))
			mockListNamespacedPod.mockResolvedValue({ items: [{ status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available' }] } }] })
			expect((await service.getDetailedStatus('ns', 'web')).problem).toBe('Unschedulable: 0/3 nodes are available')

			mockReadNamespacedDeployment.mockResolvedValue(makeDeploymentStatus({ status: { availableReplicas: 0, conditions: [{ type: 'ReplicaFailure', status: 'True', message: 'violates PodSecurity "baseline:latest"' }] } }))
			mockListNamespacedPod.mockResolvedValue({ items: [] })
			expect((await service.getDetailedStatus('ns', 'web')).problem).toBe('violates PodSecurity "baseline:latest"')
		})
	})

	describe('getPodLogs', () => {
		it('reads the logs of a running pod', async () => {
			mockListNamespacedPod.mockResolvedValue({ items: [{ metadata: { name: 'web-old' }, status: { phase: 'Failed' } }, { metadata: { name: 'web-1' }, status: { phase: 'Running' } }] })
			mockReadNamespacedPodLog.mockResolvedValue('line 1\nline 2\n')

			await expect(service.getPodLogs('ns', 'web', 100)).resolves.toEqual(['line 1', 'line 2'])
			expect(mockReadNamespacedPodLog).toHaveBeenCalledWith({ name: 'web-1', namespace: 'ns', tailLines: 100 })
		})

		it('throws PodNotFoundError without pods', async () => {
			await expect(service.getPodLogs('ns', 'web', 100)).rejects.toThrow(KubernetesTypes.PodNotFoundError)
		})
	})
})
