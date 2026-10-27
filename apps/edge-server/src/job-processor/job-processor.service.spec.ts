import { DockerService } from '@enver/domains/docker/docker.service'
import { DockerTypes } from '@enver/domains/docker/docker.types'
import { KubernetesTypes } from '@enver/domains/kubernetes/kubernetes.types'
import { EdgeProtocol } from '@enver/edge-protocol'

import { JobProcessorService } from './job-processor.service'

jest.mock('../app.config', () => ({
	config: { kubernetes: { namespace: 'test-ns' }, logs: { maxLines: 250 }, docker: { portsHostIp: undefined } },
}))

// Prevents loading @kubernetes/client-node (ESM-only) during tests
jest.mock('@enver/domains/kubernetes/kubernetes.service', () => ({
	KubernetesService: class {},
}))

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockDockerService = {
	pullImage: jest.fn(),
	ensureNetwork: jest.fn(),
	createContainer: jest.fn(),
	startContainer: jest.fn(),
	removeContainer: jest.fn(),
	getDetailedStatus: jest.fn(),
	getLogs: jest.fn(),
	removeImage: jest.fn(),
	removeUnusedImages: jest.fn(),
	listBindMounts: jest.fn(() => Promise.resolve([])),
}

const mockKubernetesService = {
	ensureEnvironmentNamespace: jest.fn(),
	ensurePullSecret: jest.fn(),
	deployService: jest.fn(),
	stopDeployment: jest.fn(),
	getDetailedStatus: jest.fn(),
	getPodLogs: jest.fn(),
}

const mockEnvFilesService = {
	read: jest.fn(),
	merge: jest.fn((env: { name: string; value: string }[] | undefined, file: { name: string; value: string }[]) => [...(env ?? []), ...file]),
}

const mockHostDirs = {
	volumePath: jest.fn((externalPath: string) => Promise.resolve(`/opt/enver/volumes/${externalPath}`)),
	assertVolumesFit: jest.fn(),
	withMountLock: jest.fn((fn: () => Promise<unknown>) => fn()),
}

const mockBackupsService = {
	buildListResponse: jest.fn(),
	buildDeleteResponse: jest.fn(),
	handleCreate: jest.fn(),
	handleRestore: jest.fn(),
}

// ─── Factories ────────────────────────────────────────────────────────────────

function makeService(): JobProcessorService {
	return new JobProcessorService(
		mockDockerService as unknown as DockerService,
		mockKubernetesService as never,
		mockBackupsService as never,
		mockEnvFilesService as never,
		mockHostDirs as never,
	)
}

function makeDockerStatus(state: string): DockerTypes.DetailedStatus {
	return { state, image: 'nginx', imageTag: 'latest', imageDigest: 'sha256:abc', uptimeSeconds: 42 }
}

function makeDockerItem(overrides?: Partial<EdgeProtocol.ServiceStatusQueryItem>): EdgeProtocol.ServiceStatusQueryItem {
	return { environmentServiceGuid: 'svc-guid', environmentGuid: 'env-guid', deploymentType: 'docker', containerName: 'my-container', ...overrides }
}

function makeK8sStatus(phase: KubernetesTypes.DeploymentPhase): KubernetesTypes.DetailedStatus {
	return { phase, image: 'nginx', imageTag: 'latest', imageDigest: 'sha256:abc', uptimeSeconds: 60, desiredReplicas: 1, readyReplicas: 1, problem: null }
}

function makeK8sItem(overrides?: Partial<EdgeProtocol.ServiceStatusQueryItem>): EdgeProtocol.ServiceStatusQueryItem {
	return { environmentServiceGuid: 'svc-guid', environmentGuid: 'env-guid', deploymentType: 'kubernetes', containerName: 'my-deploy', ...overrides }
}

function makeActionPayload(overrides?: Partial<EdgeProtocol.ServiceActionJobPayload>): EdgeProtocol.ServiceActionJobPayload {
	return {
		environmentServiceGuid: 'svc-guid',
		environmentGuid: 'env-guid',
		action: 'start',
		deploymentType: 'docker',
		subdomain: 'sub',
		serviceName: 'my-service',
		image: 'nginx:latest',
		containerName: 'my-container',
		ports: [],
		volumes: [],
		replicas: 1,
		...overrides,
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('JobProcessorService', () => {
	let service: JobProcessorService

	beforeEach(() => {
		jest.clearAllMocks()
		// Default: no prior container - matches a first-ever start, so previousImageRef() doesn't
		// throw a TypeError on undefined in tests that don't care about image cleanup.
		mockDockerService.getDetailedStatus.mockRejectedValue(new DockerTypes.ContainerNotFoundError())
		service = makeService()
	})

	// ─── dockerStateToStatus ──────────────────────────────────────────────────

	describe('dockerStateToStatus', () => {
		it.each([
			['running', 'running'],
			['restarting', 'starting'],
			['exited', 'stopped'],
			['created', 'stopped'],
			['paused', 'stopped'],
			['dead', 'stopped'],
			['removing', 'stopped'],
		])('maps Docker state "%s" → "%s"', (dockerState, expected) => {
			expect(service['dockerStateToStatus'](dockerState)).toBe(expected)
		})
	})

	// ─── k8sPhaseToStatus ─────────────────────────────────────────────────────

	describe('k8sPhaseToStatus', () => {
		it.each([
			['running', 'running'],
			['pending', 'starting'],
			['stopped', 'stopped'],
			['unknown', 'stopped'],
		] as const)('maps k8s phase "%s" → "%s"', (phase, expected) => {
			expect(service['k8sPhaseToStatus'](phase)).toBe(expected)
		})
	})

	// ─── handleDockerAction (private, exercised via process/service.action) ──

	describe('handleDockerAction — docker deployments', () => {
		it('removes (does not just stop) the container on "stop", so the next start is fresh', async () => {
			await service['handleDockerAction'](makeActionPayload({ action: 'stop' }))

			expect(mockDockerService.removeContainer).toHaveBeenCalledWith('my-container')
		})

		it('tolerates ContainerNotFoundError on stop (already gone)', async () => {
			mockDockerService.removeContainer.mockRejectedValue(new DockerTypes.ContainerNotFoundError())

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'stop' }))).resolves.toBeUndefined()
		})

		it('tolerates ContainerRemovalInProgressError on stop (race with a concurrent removal) - the next reconcile poll retries', async () => {
			mockDockerService.removeContainer.mockRejectedValue(new DockerTypes.ContainerRemovalInProgressError())

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'stop' }))).resolves.toBeUndefined()
		})

		it('rethrows unexpected errors on stop', async () => {
			mockDockerService.removeContainer.mockRejectedValue(new Error('socket error'))

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'stop' }))).rejects.toThrow('socket error')
		})

		it.each(['start', 'restart'] as const)('pulls the image, ensures the network and (re)creates the container on "%s"', async (action) => {
			await service['handleDockerAction'](makeActionPayload({ action, image: 'nginx:1.2', containerName: 'c1' }))

			expect(mockDockerService.pullImage).toHaveBeenCalledWith('nginx:1.2', undefined)
			expect(mockDockerService.ensureNetwork).toHaveBeenCalled()
			expect(mockDockerService.createContainer).toHaveBeenCalledWith(expect.objectContaining({ name: 'c1', image: 'nginx:1.2' }))
			expect(mockDockerService.startContainer).toHaveBeenCalledWith('c1')
		})

		it('mounts volumes from inside the volumes directory', async () => {
			await service['handleDockerAction'](makeActionPayload({ action: 'start', volumes: [{ externalPath: 'web', internalPath: '/data' }] }))

			expect(mockHostDirs.volumePath).toHaveBeenCalledWith('web')
			expect(mockDockerService.createContainer).toHaveBeenCalledWith(expect.objectContaining({ volumes: [{ externalPath: '/opt/enver/volumes/web', internalPath: '/data' }] }))
		})

		it('resolves volumes again after the pull, right before creating the container', async () => {
			mockDockerService.pullImage.mockImplementationOnce(() => {
				mockHostDirs.volumePath.mockRejectedValueOnce(new Error('web leads outside the volumes directory'))
				return Promise.resolve()
			})

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'start', volumes: [{ externalPath: 'web', internalPath: '/data' }] }))).rejects.toThrow('leads outside')
			expect(mockDockerService.createContainer).not.toHaveBeenCalled()
		})

		it('checks the volumes against the other containers inside the mount lock', async () => {
			mockDockerService.listBindMounts.mockResolvedValueOnce([{ containerName: 'other', sources: ['/opt/enver/volumes/web/data'] }])
			mockHostDirs.assertVolumesFit.mockRejectedValueOnce(new Error('lie inside each other'))

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'start', containerName: 'c1', volumes: [{ externalPath: 'web', internalPath: '/data' }] }))).rejects.toThrow('lie inside each other')
			expect(mockHostDirs.withMountLock).toHaveBeenCalled()
			expect(mockHostDirs.assertVolumesFit).toHaveBeenCalledWith('c1', ['/opt/enver/volumes/web'], [{ containerName: 'other', sources: ['/opt/enver/volumes/web/data'] }])
			expect(mockDockerService.createContainer).not.toHaveBeenCalled()
		})

		it('starts nothing when a volume is refused', async () => {
			mockHostDirs.volumePath.mockRejectedValueOnce(new Error('/etc is outside the volumes directory'))

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'start', volumes: [{ externalPath: '/etc', internalPath: '/data' }] }))).rejects.toThrow('outside')
			expect(mockDockerService.pullImage).not.toHaveBeenCalled()
			expect(mockDockerService.createContainer).not.toHaveBeenCalled()
		})

		it('reports a container of the same name that Enver does not manage', async () => {
			mockDockerService.getDetailedStatus.mockRejectedValue(new DockerTypes.ContainerNotManagedError('my-container'))

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({ status: 'stopped', errorMessage: expect.stringContaining('not managed by Enver') }))
		})

		it('passes the resolved command through to createContainer', async () => {
			await service['handleDockerAction'](makeActionPayload({ action: 'start', command: ['npm', 'run', 'start'] }))

			expect(mockDockerService.createContainer).toHaveBeenCalledWith(expect.objectContaining({ command: ['npm', 'run', 'start'] }))
		})

		it('maps registryAuth to dockerode authconfig fields when pulling', async () => {
			await service['handleDockerAction'](makeActionPayload({
				action: 'start',
				registryAuth: { type: 'dockerhub', username: 'me', token: 'secret-tok', registryUrl: 'https://registry.example.com' },
			}))

			expect(mockDockerService.pullImage).toHaveBeenCalledWith('nginx:latest', {
				username: 'me', password: 'secret-tok', serveraddress: 'https://registry.example.com',
			})
		})

		it('pulls anonymously (no auth) when registryAuth is not set', async () => {
			await service['handleDockerAction'](makeActionPayload({ action: 'start' }))

			expect(mockDockerService.pullImage).toHaveBeenCalledWith('nginx:latest', undefined)
		})
	})

	// ─── image cleanup after swap ─────────────────────────────────────────────

	describe('image cleanup after swap', () => {
		it('does nothing when there was no prior container (first-ever start)', async () => {
			mockDockerService.getDetailedStatus.mockRejectedValue(new DockerTypes.ContainerNotFoundError())

			await service['handleDockerAction'](makeActionPayload({ action: 'start', image: 'nginx:1.2' }))

			expect(mockDockerService.removeImage).not.toHaveBeenCalled()
			expect(mockDockerService.removeUnusedImages).not.toHaveBeenCalled()
		})

		it('in \'swapped-only\' mode (the default), removes just the previous image tag once the swap succeeds', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))

			await service['handleDockerAction'](makeActionPayload({ action: 'restart', image: 'nginx:1.3', containerName: 'c1' }))

			expect(mockDockerService.removeImage).toHaveBeenCalledWith('nginx:latest')
			expect(mockDockerService.removeUnusedImages).not.toHaveBeenCalled()
		})

		it('does not remove the previous image when the swap re-deploys the same image:tag', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))

			await service['handleDockerAction'](makeActionPayload({ action: 'restart', image: 'nginx:latest', containerName: 'c1' }))

			expect(mockDockerService.removeImage).not.toHaveBeenCalled()
		})

		it('in \'all-unused\' mode, sweeps every unreferenced image instead of just the previous tag', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			service.setImageCleanupMode(EdgeProtocol.ImageCleanupMode.allUnused)

			await service['handleDockerAction'](makeActionPayload({ action: 'start', image: 'nginx:1.3' }))

			expect(mockDockerService.removeUnusedImages).toHaveBeenCalled()
			expect(mockDockerService.removeImage).not.toHaveBeenCalled()
		})

		it('never fails the swap itself if cleanup throws', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			mockDockerService.removeImage.mockRejectedValue(new Error('daemon unreachable'))

			await expect(service['handleDockerAction'](makeActionPayload({ action: 'restart', image: 'nginx:1.3' }))).resolves.toBeUndefined()
		})
	})

	describe('runPeriodicImageCleanup', () => {
		it('is a no-op in \'swapped-only\' mode (the default)', async () => {
			await service.runPeriodicImageCleanup()
			expect(mockDockerService.removeUnusedImages).not.toHaveBeenCalled()
		})

		it('sweeps unused images in \'all-unused\' mode', async () => {
			service.setImageCleanupMode(EdgeProtocol.ImageCleanupMode.allUnused)
			await service.runPeriodicImageCleanup()
			expect(mockDockerService.removeUnusedImages).toHaveBeenCalled()
		})
	})

	// ─── transition phase tracking ────────────────────────────────────────────

	describe('transition phase tracking', () => {
		it('tracks "pulling" while the image is being pulled, then "starting" for a start action', async () => {
			let resolvePull: () => void = () => undefined
			mockDockerService.pullImage.mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePull = resolve }))

			const actionPromise = service['handleDockerAction'](makeActionPayload({ action: 'start' }))
			await Promise.resolve()
			expect(service['transitions'].get('svc-guid')).toBe('pulling')

			resolvePull()
			await actionPromise

			expect(service['transitions'].get('svc-guid')).toBe('starting')
		})

		it('tracks "restarting" (not "starting") once the pull settles for a restart action', async () => {
			await service['handleDockerAction'](makeActionPayload({ action: 'restart' }))

			expect(service['transitions'].get('svc-guid')).toBe('restarting')
		})

		it('tracks "stopping" while the container is being removed', async () => {
			let resolveRemove: () => void = () => undefined
			mockDockerService.removeContainer.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveRemove = resolve }))

			const actionPromise = service['handleDockerAction'](makeActionPayload({ action: 'stop' }))
			await Promise.resolve()
			expect(service['transitions'].get('svc-guid')).toBe('stopping')

			resolveRemove()
			await actionPromise
		})

		it('tracks "starting"/"stopping"/"restarting" for Kubernetes actions (no pull phase)', async () => {
			await service['handleKubernetesAction'](makeActionPayload({ action: 'start', deploymentType: 'kubernetes', containerName: 'my-deploy' }))
			expect(service['transitions'].get('svc-guid')).toBe('starting')

			await service['handleKubernetesAction'](makeActionPayload({ action: 'restart', deploymentType: 'kubernetes', containerName: 'my-deploy' }))
			expect(service['transitions'].get('svc-guid')).toBe('restarting')

			await service['handleKubernetesAction'](makeActionPayload({ action: 'stop', deploymentType: 'kubernetes', containerName: 'my-deploy' }))
			expect(service['transitions'].get('svc-guid')).toBe('stopping')
		})

		it('clears the tracked transition after a successful action', async () => {
			await service['handleServiceAction'](makeActionPayload({ action: 'start' }))

			expect(service['transitions'].has('svc-guid')).toBe(false)
		})

		it('clears the tracked transition after a failed action', async () => {
			mockDockerService.pullImage.mockRejectedValue(new Error('boom'))

			await expect(service['handleServiceAction'](makeActionPayload({ action: 'start' }))).rejects.toThrow('boom')

			expect(service['transitions'].has('svc-guid')).toBe(false)
		})
	})

	// ─── env file ─────────────────────────────────────────────────────────────

	describe('env file', () => {
		beforeEach(() => {
			mockDockerService.pullImage.mockResolvedValue(undefined)
			mockDockerService.removeContainer.mockResolvedValue(undefined)
		})

		it.each(['docker', 'kubernetes'] as const)('lays the local env file over the sent variables on %s', async (deploymentType) => {
			mockEnvFilesService.read.mockResolvedValue([{ name: 'DB_PASSWORD', value: 'local' }])

			await service['handleServiceAction'](makeActionPayload({ deploymentType, envFile: 'app.env', env: [{ name: 'A', value: '1' }] }))

			expect(mockEnvFilesService.read).toHaveBeenCalledWith('app.env')
			const expectedEnv = [{ name: 'A', value: '1' }, { name: 'DB_PASSWORD', value: 'local' }]
			const deploy = deploymentType === 'docker' ? mockDockerService.createContainer : mockKubernetesService.deployService
			expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ env: expectedEnv }))
		})

		it('does not read the file for a stop', async () => {
			await service['handleServiceAction'](makeActionPayload({ action: 'stop', envFile: 'app.env' }))

			expect(mockEnvFilesService.read).not.toHaveBeenCalled()
		})

		it('reports an unreadable file as the service error and starts nothing', async () => {
			mockEnvFilesService.read.mockRejectedValue(new Error('Env file "app.env" not found'))

			await expect(service['handleServiceAction'](makeActionPayload({ envFile: 'app.env' }))).rejects.toThrow('not found')

			expect(mockDockerService.createContainer).not.toHaveBeenCalled()
			expect(service['lastActionErrors'].get('svc-guid')).toBe('Env file "app.env" not found')
		})
	})

	// ─── handleKubernetesAction (private, exercised via process/service.action) ──

	describe('handleKubernetesAction — kubernetes deployments', () => {
		it('prepares the environment namespace and applies the whole service spec on start', async () => {
			await service['handleKubernetesAction'](makeActionPayload({
				action: 'start',
				deploymentType: 'kubernetes',
				containerName: 'my-deploy',
				command: ['npm', 'run', 'start'],
				ports: [{ internalPort: 80, exposedPort: 8080, loadBalancer: true }],
				env: [{ name: 'A', value: '1' }],
				replicas: 3,
				ingressRules: [{ host: 'app.example.com', path: '/', internalPort: 80, tls: true }],
				resources: { cpuRequest: '100m', memoryLimit: '256Mi' },
			}))

			expect(mockKubernetesService.ensureEnvironmentNamespace).toHaveBeenCalledWith('env-env-guid', 'env-guid')
			expect(mockKubernetesService.deployService).toHaveBeenCalledWith({
				namespace: 'env-env-guid',
				environmentServiceGuid: 'svc-guid',
				name: 'my-deploy',
				image: 'nginx:latest',
				ports: [{ internalPort: 80, exposedPort: 8080, loadBalancer: true }],
				volumes: [],
				ingressRules: [{ host: 'app.example.com', path: '/', internalPort: 80, tls: true }],
				replicas: 3,
				env: [{ name: 'A', value: '1' }],
				command: ['npm', 'run', 'start'],
				cpuRequest: '100m',
				memoryLimit: '256Mi',
				imagePullSecretName: undefined,
				restart: false,
			})
		})

		it('forces a rollout on restart', async () => {
			await service['handleKubernetesAction'](makeActionPayload({ action: 'restart', deploymentType: 'kubernetes', containerName: 'my-deploy' }))

			expect(mockKubernetesService.deployService).toHaveBeenCalledWith(expect.objectContaining({ restart: true, ingressRules: [] }))
		})

		it('does not touch the pull secret when registryAuth is not set', async () => {
			await service['handleKubernetesAction'](makeActionPayload({ action: 'start', deploymentType: 'kubernetes', containerName: 'my-deploy' }))

			expect(mockKubernetesService.ensurePullSecret).not.toHaveBeenCalled()
		})

		it('upserts the pull secret and passes imagePullSecretName through when registryAuth is set', async () => {
			await service['handleKubernetesAction'](makeActionPayload({
				action: 'start',
				deploymentType: 'kubernetes',
				containerName: 'my-deploy',
				registryAuth: { type: 'registry', username: 'me', token: 'secret-tok', registryUrl: 'https://registry.example.com' },
			}))

			expect(mockKubernetesService.ensurePullSecret).toHaveBeenCalledWith('env-env-guid', 'my-deploy-pull-secret', {
				username: 'me', password: 'secret-tok', registryUrl: 'https://registry.example.com',
			})
			expect(mockKubernetesService.deployService).toHaveBeenCalledWith(expect.objectContaining({ imagePullSecretName: 'my-deploy-pull-secret' }))
		})

		it('scales to zero on stop and treats a missing deployment as stopped', async () => {
			mockKubernetesService.stopDeployment.mockRejectedValue(new KubernetesTypes.DeploymentNotFoundError())

			await expect(service['handleKubernetesAction'](makeActionPayload({ action: 'stop', deploymentType: 'kubernetes', containerName: 'my-deploy' }))).resolves.toBeUndefined()

			expect(mockKubernetesService.stopDeployment).toHaveBeenCalledWith('env-env-guid', 'my-deploy')
			expect(mockKubernetesService.deployService).not.toHaveBeenCalled()
		})
	})

	// ─── handleServiceAction — error capture ─────────────────────────────────

	describe('handleServiceAction — error capture', () => {
		it('records the error message on failure and rethrows', async () => {
			mockDockerService.pullImage.mockRejectedValue(new Error('pull failed: no such image'))

			await expect(service['handleServiceAction'](makeActionPayload({ action: 'start' })))
				.rejects.toThrow('pull failed: no such image')

			expect(service['lastActionErrors'].get('svc-guid')).toBe('pull failed: no such image')
		})

		it('clears any previously recorded error after a successful action', async () => {
			mockDockerService.pullImage.mockRejectedValueOnce(new Error('boom'))
			await expect(service['handleServiceAction'](makeActionPayload({ action: 'start' }))).rejects.toThrow('boom')
			expect(service['lastActionErrors'].has('svc-guid')).toBe(true)

			mockDockerService.pullImage.mockResolvedValueOnce(undefined)
			await service['handleServiceAction'](makeActionPayload({ action: 'start' }))

			expect(service['lastActionErrors'].has('svc-guid')).toBe(false)
		})

		it('does not record an error for an unrecognized deployment type', async () => {
			await service['handleServiceAction'](makeActionPayload({ deploymentType: 'unknown' as never }))

			expect(service['lastActionErrors'].has('svc-guid')).toBe(false)
		})

		it('does not record an error when a stop races a concurrent removal (expected, not a failure)', async () => {
			mockDockerService.removeContainer.mockRejectedValue(new DockerTypes.ContainerRemovalInProgressError())

			await expect(service['handleServiceAction'](makeActionPayload({ action: 'stop' }))).resolves.toBeUndefined()

			expect(service['lastActionErrors'].has('svc-guid')).toBe(false)
		})
	})

	// ─── extractErrorMessage ──────────────────────────────────────────────────

	describe('extractErrorMessage', () => {
		it('uses a plain Error message', () => {
			expect(service['extractErrorMessage'](new Error('plain failure'))).toBe('plain failure')
		})

		it('extracts the nested body.message from a Kubernetes-style ApiException', () => {
			const err = { message: 'HTTP request failed (verbose dump...)', body: { message: 'deployments.apps "x" already exists' } }
			expect(service['extractErrorMessage'](err)).toBe('deployments.apps "x" already exists')
		})

		it('returns a plain string error as-is', () => {
			expect(service['extractErrorMessage']('just a string')).toBe('just a string')
		})

		it('falls back to a generic message for anything else', () => {
			expect(service['extractErrorMessage'](42)).toBe('Unknown error')
		})
	})

	// ─── checkDockerStatus ────────────────────────────────────────────────────

	describe('checkDockerStatus', () => {
		it('returns running with image details when container is running', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({
				environmentServiceGuid: 'svc-guid',
				status: 'running',
				image: 'nginx',
				imageTag: 'latest',
				imageDigest: 'sha256:abc',
				uptimeSeconds: 42,
			}))
		})

		it('returns starting when container is restarting', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('restarting'))

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({ status: 'starting' }))
		})

		it('returns stopped when container has exited', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('exited'))

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({ status: 'stopped' }))
		})

		it('returns stopped with null image fields when container not found', async () => {
			mockDockerService.getDetailedStatus.mockRejectedValue(new DockerTypes.ContainerNotFoundError())

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual({
				environmentServiceGuid: 'svc-guid',
				status: 'stopped',
				image: null,
				imageTag: null,
				imageDigest: null,
				uptimeSeconds: null,
				errorMessage: null,
			})
		})

		it('rethrows unexpected errors', async () => {
			mockDockerService.getDetailedStatus.mockRejectedValue(new Error('socket error'))

			await expect(service['checkDockerStatus'](makeDockerItem())).rejects.toThrow('socket error')
		})

		it('includes the last action error message when present', async () => {
			mockDockerService.pullImage.mockRejectedValue(new Error('manifest for nginx:bogus not found'))
			await expect(service['handleServiceAction'](makeActionPayload({ action: 'start', image: 'nginx:bogus' })))
				.rejects.toThrow('manifest for nginx:bogus not found')

			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({ errorMessage: 'manifest for nginx:bogus not found' }))
		})

		it('reports the tracked transition phase instead of the raw Docker state while an action is in flight', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			service['transitions'].set('svc-guid', 'pulling')

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({ status: 'pulling' }))
		})

		it('reports the tracked transition phase even when the container does not exist yet', async () => {
			mockDockerService.getDetailedStatus.mockRejectedValue(new DockerTypes.ContainerNotFoundError())
			service['transitions'].set('svc-guid', 'pulling')

			const result = await service['checkDockerStatus'](makeDockerItem())

			expect(result).toEqual(expect.objectContaining({ status: 'pulling' }))
		})
	})

	// ─── checkKubernetesStatus ────────────────────────────────────────────────

	describe('checkKubernetesStatus', () => {
		it('returns running with image details when deployment is running', async () => {
			mockKubernetesService.getDetailedStatus.mockResolvedValue(makeK8sStatus('running'))

			const result = await service['checkKubernetesStatus'](makeK8sItem())

			expect(result).toEqual(expect.objectContaining({
				environmentServiceGuid: 'svc-guid',
				status: 'running',
				image: 'nginx',
				imageTag: 'latest',
				imageDigest: 'sha256:abc',
				uptimeSeconds: 60,
			}))
		})

		it('returns starting when deployment is pending', async () => {
			mockKubernetesService.getDetailedStatus.mockResolvedValue(makeK8sStatus('pending'))

			const result = await service['checkKubernetesStatus'](makeK8sItem())

			expect(result).toEqual(expect.objectContaining({ status: 'starting' }))
		})

		it('returns stopped with null image fields when deployment not found', async () => {
			mockKubernetesService.getDetailedStatus.mockRejectedValue(new KubernetesTypes.DeploymentNotFoundError())

			const result = await service['checkKubernetesStatus'](makeK8sItem())

			expect(result).toEqual({
				environmentServiceGuid: 'svc-guid',
				status: 'stopped',
				image: null,
				imageTag: null,
				imageDigest: null,
				uptimeSeconds: null,
				errorMessage: null,
			})
		})

		it('reports why the pods do not come up when no action failed', async () => {
			mockKubernetesService.getDetailedStatus.mockResolvedValue({ ...makeK8sStatus('pending'), problem: 'ImagePullBackOff: pull access denied' })

			const result = await service['checkKubernetesStatus'](makeK8sItem())

			expect(result).toEqual(expect.objectContaining({ status: 'starting', errorMessage: 'ImagePullBackOff: pull access denied' }))
		})

		it('reports the tracked transition phase instead of the raw pod phase while an action is in flight', async () => {
			mockKubernetesService.getDetailedStatus.mockResolvedValue(makeK8sStatus('running'))
			service['transitions'].set('svc-guid', 'restarting')

			const result = await service['checkKubernetesStatus'](makeK8sItem())

			expect(result).toEqual(expect.objectContaining({ status: 'restarting' }))
		})
	})

	// ─── buildStatusResponse ──────────────────────────────────────────────────

	describe('buildStatusResponse', () => {
		it('builds a correctly shaped response for a running docker container', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))

			const response = await service['buildStatusResponse']('query-1', [makeDockerItem()])

			expect(response).toEqual({
				type: 'status.response',
				queryId: 'query-1',
				results: [expect.objectContaining({ status: 'running', environmentServiceGuid: 'svc-guid' })],
			})
		})

		it('handles multiple services independently — one running, one not found', async () => {
			mockDockerService.getDetailedStatus
				.mockResolvedValueOnce(makeDockerStatus('running'))
				.mockRejectedValueOnce(new DockerTypes.ContainerNotFoundError())

			const items = [
				makeDockerItem({ environmentServiceGuid: 'svc-1', containerName: 'c1' }),
				makeDockerItem({ environmentServiceGuid: 'svc-2', containerName: 'c2' }),
			]
			const response = await service['buildStatusResponse']('q', items)

			expect(response.results).toEqual([
				expect.objectContaining({ environmentServiceGuid: 'svc-1', status: 'running' }),
				expect.objectContaining({ environmentServiceGuid: 'svc-2', status: 'stopped' }),
			])
		})
	})

	// ─── process — status.query ───────────────────────────────────────────────

	describe('process (status.query)', () => {
		it('sends status.response and updates watchedServices', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			const send = jest.fn()

			await service.process({
				edgeServerGuid: 'edge-1',
				type: 'status.query',
				payload: { queryId: 'q-1', services: [makeDockerItem()] },
			}, send)

			expect(send).toHaveBeenCalledWith(expect.objectContaining({
				type: 'status.response',
				queryId: 'q-1',
				results: [expect.objectContaining({ status: 'running' })],
			}))
		})

		it('pushAllStatuses uses last watched services from status.query', async () => {
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			const send = jest.fn()

			await service.process({
				edgeServerGuid: 'edge-1',
				type: 'status.query',
				payload: { queryId: 'q-1', services: [makeDockerItem()] },
			}, send)

			jest.clearAllMocks()
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('exited'))

			await service.pushAllStatuses(send)

			expect(send).toHaveBeenCalledWith(expect.objectContaining({
				results: [expect.objectContaining({ status: 'stopped' })],
			}))
		})
	})

	// ─── watch list after an environment rename ───────────────────────────────

	describe('watch list after an environment rename', () => {
		function makeSpec(overrides?: Partial<EdgeProtocol.DesiredStateServiceSpec>): EdgeProtocol.DesiredStateServiceSpec {
			return { ...makeActionPayload(), desiredState: 'running', ...overrides } as EdgeProtocol.DesiredStateServiceSpec
		}

		async function watchOldName(): Promise<void> {
			await service.process({
				edgeServerGuid: 'edge-1',
				type: 'status.query',
				payload: { queryId: '', services: [makeDockerItem({ containerName: 'dev-api' })] },
			}, jest.fn())
			jest.clearAllMocks()
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
		}

		it('desired-state.sync replaces the container name of an already watched service', async () => {
			await watchOldName()

			service.syncDesiredStates([makeSpec({ containerName: 'production-api' })])
			await service.pushAllStatuses(jest.fn())

			expect(mockDockerService.getDetailedStatus).toHaveBeenCalledTimes(1)
			expect(mockDockerService.getDetailedStatus).toHaveBeenCalledWith('production-api')
		})

		it('a start action switches the watched container name right away', async () => {
			await watchOldName()
			mockDockerService.pullImage.mockResolvedValue(undefined)

			await service.process({ edgeServerGuid: 'edge-1', type: 'service.action', payload: makeActionPayload({ containerName: 'production-api' }) }, jest.fn())
			jest.clearAllMocks()
			mockDockerService.getDetailedStatus.mockResolvedValue(makeDockerStatus('running'))
			await service.pushAllStatuses(jest.fn())

			expect(mockDockerService.getDetailedStatus).toHaveBeenCalledTimes(1)
			expect(mockDockerService.getDetailedStatus).toHaveBeenCalledWith('production-api')
		})
	})

	// ─── process — logs.query ─────────────────────────────────────────────────

	describe('process (logs.query)', () => {
		it('fetches docker logs and sends logs.response', async () => {
			mockDockerService.getLogs.mockResolvedValue(['line 1', 'line 2'])
			const send = jest.fn()

			await service.process({
				edgeServerGuid: 'edge-1',
				type: 'logs.query',
				payload: { queryId: 'q-1', environmentGuid: 'env-guid', deploymentType: 'docker', containerName: 'my-container' },
			}, send)

			expect(mockDockerService.getLogs).toHaveBeenCalledWith('my-container', 250)
			expect(send).toHaveBeenCalledWith({ type: 'logs.response', queryId: 'q-1', lines: ['line 1', 'line 2'] })
		})

		it('fetches kubernetes pod logs and sends logs.response', async () => {
			mockKubernetesService.getPodLogs.mockResolvedValue(['pod line 1'])
			const send = jest.fn()

			await service.process({
				edgeServerGuid: 'edge-1',
				type: 'logs.query',
				payload: { queryId: 'q-2', environmentGuid: 'env-guid', deploymentType: 'kubernetes', containerName: 'my-deploy' },
			}, send)

			expect(mockKubernetesService.getPodLogs).toHaveBeenCalledWith('env-env-guid', 'my-deploy', 250)
			expect(send).toHaveBeenCalledWith({ type: 'logs.response', queryId: 'q-2', lines: ['pod line 1'] })
		})

		it('sends empty lines when fetching logs fails', async () => {
			mockDockerService.getLogs.mockRejectedValue(new DockerTypes.ContainerNotFoundError())
			const send = jest.fn()

			await service.process({
				edgeServerGuid: 'edge-1',
				type: 'logs.query',
				payload: { queryId: 'q-3', environmentGuid: 'env-guid', deploymentType: 'docker', containerName: 'gone' },
			}, send)

			expect(send).toHaveBeenCalledWith({ type: 'logs.response', queryId: 'q-3', lines: [] })
		})
	})
})
