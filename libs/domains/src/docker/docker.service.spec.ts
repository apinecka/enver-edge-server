import { DockerService } from './docker.service'
import { DockerTypes } from './docker.types'

const mockStop = jest.fn()
const mockRemove = jest.fn()
const mockInspect = jest.fn()
const mockLogs = jest.fn()
const mockExec = jest.fn()
const mockGetContainer = jest.fn(() => ({ stop: mockStop, remove: mockRemove, inspect: mockInspect, logs: mockLogs, exec: mockExec }))
const mockCreateContainer = jest.fn()
const mockImageRemove = jest.fn()
const mockGetImage = jest.fn(() => ({ remove: mockImageRemove }))
const mockListImages = jest.fn()
const mockPull = jest.fn()
const mockListContainers = jest.fn()
const mockFollowProgress = jest.fn((_stream: unknown, cb: (err: Error | null) => void) => cb(null))

jest.mock('dockerode', () => jest.fn().mockImplementation(() => ({
	getContainer: mockGetContainer,
	getImage: mockGetImage,
	listImages: mockListImages,
	listContainers: mockListContainers,
	pull: mockPull,
	createContainer: mockCreateContainer,
	modem: { followProgress: mockFollowProgress },
})))

function makeService(): DockerService {
	return new DockerService(new DockerTypes.Options({}))
}

function inspectInfo(overrides: { labels?: Record<string, string>; networkMode?: string; networks?: string[] } = {}) {
	return {
		Config: { Image: 'nginx:1', Labels: overrides.labels ?? { [DockerTypes.MANAGED_LABEL]: 'true' } },
		HostConfig: { NetworkMode: overrides.networkMode ?? 'bridge' },
		NetworkSettings: { Networks: Object.fromEntries((overrides.networks ?? []).map((n) => [n, {}])) },
		State: { Status: 'running', StartedAt: '0001-01-01T00:00:00Z' },
		Image: 'sha256:abc',
	}
}

function makeDockerError(message: string, statusCode: number): Error {
	return Object.assign(new Error(message), { statusCode })
}

describe('DockerService', () => {
	let service: DockerService

	beforeEach(() => {
		jest.clearAllMocks()
		mockFollowProgress.mockImplementation((_stream: unknown, cb: (err: Error | null) => void) => cb(null))
		mockPull.mockResolvedValue({})
		mockInspect.mockResolvedValue(inspectInfo())
		service = makeService()
	})

	describe('pullImage', () => {
		it('pulls without an authconfig when no auth is given', async () => {
			await service.pullImage('nginx:latest')
			expect(mockPull).toHaveBeenCalledWith('nginx:latest', {})
		})

		it('passes the auth as dockerode authconfig when given', async () => {
			const auth = { username: 'me', password: 'token', serveraddress: 'https://index.docker.io/v1/' }
			await service.pullImage('myapp/api:latest', auth)
			expect(mockPull).toHaveBeenCalledWith('myapp/api:latest', { authconfig: auth })
		})
	})

	describe('removeContainer', () => {
		it('stops then removes the container', async () => {
			mockStop.mockResolvedValue(undefined)
			mockRemove.mockResolvedValue(undefined)

			await expect(service.removeContainer('c1')).resolves.toBeUndefined()

			expect(mockStop).toHaveBeenCalled()
			expect(mockRemove).toHaveBeenCalled()
		})

		it('tolerates stop() failing (already stopped or not running)', async () => {
			mockStop.mockRejectedValue(new Error('already stopped'))
			mockRemove.mockResolvedValue(undefined)

			await expect(service.removeContainer('c1')).resolves.toBeUndefined()
		})

		it('throws ContainerNotFoundError on a 404 from remove()', async () => {
			mockStop.mockResolvedValue(undefined)
			mockRemove.mockRejectedValue(makeDockerError('(HTTP code 404) no such container - no such container: c1', 404))

			await expect(service.removeContainer('c1')).rejects.toThrow(DockerTypes.ContainerNotFoundError)
		})

		it('throws ContainerRemovalInProgressError on a 409 "already in progress" from remove()', async () => {
			mockStop.mockResolvedValue(undefined)
			mockRemove.mockRejectedValue(makeDockerError('(HTTP code 409) unexpected - removal of container c1 is already in progress ', 409))

			await expect(service.removeContainer('c1')).rejects.toThrow(DockerTypes.ContainerRemovalInProgressError)
		})

		it('rethrows a 409 that is not a removal-in-progress race', async () => {
			mockStop.mockResolvedValue(undefined)
			const err = makeDockerError('(HTTP code 409) conflict - You cannot remove a running container', 409)
			mockRemove.mockRejectedValue(err)

			await expect(service.removeContainer('c1')).rejects.toThrow(err.message)
		})

		it('rethrows unrelated errors', async () => {
			mockStop.mockResolvedValue(undefined)
			mockRemove.mockRejectedValue(new Error('socket error'))

			await expect(service.removeContainer('c1')).rejects.toThrow('socket error')
		})
	})

	describe('containers Enver does not manage', () => {
		const foreign = () => mockInspect.mockResolvedValue(inspectInfo({ labels: {} }))

		it.each([
			['removeContainer', (s: DockerService) => s.removeContainer('db')],
			['startContainer', (s: DockerService) => s.startContainer('db')],
			['restartContainer', (s: DockerService) => s.restartContainer('db')],
			['getDetailedStatus', (s: DockerService) => s.getDetailedStatus('db')],
			['getLogs', (s: DockerService) => s.getLogs('db', 10)],
			['execFromString', (s: DockerService) => s.execFromString('db', ['sh'], 'select 1')],
		])('refuses %s on a container without the label or an Enver network', async (_name, act) => {
			foreign()
			await expect(act(service)).rejects.toThrow(DockerTypes.ContainerNotManagedError)
			expect(mockStop).not.toHaveBeenCalled()
			expect(mockRemove).not.toHaveBeenCalled()
			expect(mockLogs).not.toHaveBeenCalled()
			expect(mockExec).not.toHaveBeenCalled()
		})

		it('refuses to replace a foreign container that has the same name', async () => {
			foreign()
			await expect(service.createContainer({ name: 'db', image: 'postgres', ports: [], volumes: [] })).rejects.toThrow(DockerTypes.ContainerNotManagedError)
			expect(mockCreateContainer).not.toHaveBeenCalled()
		})

		it.each([
			['its network mode', { labels: {}, networkMode: 'enver-env1' }],
			['an attached network', { labels: {}, networks: ['bridge', 'enver-env1'] }],
		])('accepts a container created before the label by %s', async (_name, overrides) => {
			mockInspect.mockResolvedValue(inspectInfo(overrides))
			mockStop.mockResolvedValue(undefined)
			mockRemove.mockResolvedValue(undefined)
			await expect(service.removeContainer('db')).resolves.toBeUndefined()
		})

		it('reports a missing container as not found', async () => {
			mockInspect.mockRejectedValue(makeDockerError('no such container', 404))
			await expect(service.getLogs('db', 10)).rejects.toThrow(DockerTypes.ContainerNotFoundError)
		})
	})

	describe('listBindMounts', () => {
		it('lists the bind sources of managed containers only, stopped ones included', async () => {
			mockListContainers.mockResolvedValue([
				{ Id: '1', Names: ['/web'], Labels: { [DockerTypes.MANAGED_LABEL]: 'true' }, HostConfig: { NetworkMode: 'bridge' }, Mounts: [{ Type: 'bind', Source: '/opt/data/web' }, { Type: 'volume', Source: '/var/lib/docker/volumes/x' }] },
				{ Id: '2', Names: ['/legacy'], Labels: {}, HostConfig: { NetworkMode: 'enver-env1' }, Mounts: [{ Type: 'bind', Source: '/opt/data/legacy' }] },
				{ Id: '3', Names: ['/other'], Labels: {}, HostConfig: { NetworkMode: 'bridge' }, Mounts: [{ Type: 'bind', Source: '/' }] },
			])

			await expect(service.listBindMounts()).resolves.toEqual([
				{ containerName: 'web', sources: ['/opt/data/web'] },
				{ containerName: 'legacy', sources: ['/opt/data/legacy'] },
			])
			expect(mockListContainers).toHaveBeenCalledWith({ all: true })
		})
	})

	describe('createContainer', () => {
		beforeEach(() => {
			mockInspect.mockRejectedValue(makeDockerError('no such container', 404))
		})

		it('labels the container and publishes ports on all interfaces by default', async () => {
			await service.createContainer({ name: 'web', image: 'nginx', ports: [{ internalPort: 80, exposedPort: 8080 }], volumes: [{ externalPath: '/opt/enver/volumes/web', internalPath: '/data' }] })
			expect(mockCreateContainer).toHaveBeenCalledWith(expect.objectContaining({
				Labels: { [DockerTypes.MANAGED_LABEL]: 'true' },
				HostConfig: expect.objectContaining({
					PortBindings: { '80/tcp': [{ HostPort: '8080' }] },
					Binds: ['/opt/enver/volumes/web:/data'],
				}),
			}))
		})

		it('publishes ports on the configured host address', async () => {
			await service.createContainer({ name: 'web', image: 'nginx', ports: [{ internalPort: 80, exposedPort: 8080 }], volumes: [], portsHostIp: '10.0.0.5' })
			expect(mockCreateContainer).toHaveBeenCalledWith(expect.objectContaining({
				HostConfig: expect.objectContaining({ PortBindings: { '80/tcp': [{ HostPort: '8080', HostIp: '10.0.0.5' }] } }),
			}))
		})
	})

	describe('removeImage', () => {
		it('removes the image by ref', async () => {
			mockImageRemove.mockResolvedValue(undefined)

			await expect(service.removeImage('myapp:old')).resolves.toBeUndefined()

			expect(mockGetImage).toHaveBeenCalledWith('myapp:old')
			expect(mockImageRemove).toHaveBeenCalled()
		})

		it('swallows a 404 (no such image)', async () => {
			mockImageRemove.mockRejectedValue(makeDockerError('(HTTP code 404) no such image', 404))

			await expect(service.removeImage('myapp:old')).resolves.toBeUndefined()
		})

		it('swallows a 409 (still referenced by a container)', async () => {
			mockImageRemove.mockRejectedValue(makeDockerError('(HTTP code 409) conflict - image is being used', 409))

			await expect(service.removeImage('myapp:old')).resolves.toBeUndefined()
		})

		it('rethrows unrelated errors', async () => {
			mockImageRemove.mockRejectedValue(new Error('socket error'))

			await expect(service.removeImage('myapp:old')).rejects.toThrow('socket error')
		})
	})

	describe('removeUnusedImages', () => {
		it('attempts to remove every locally cached image', async () => {
			mockListImages.mockResolvedValue([{ Id: 'sha256:a' }, { Id: 'sha256:b' }])
			mockImageRemove.mockResolvedValue(undefined)

			await service.removeUnusedImages()

			expect(mockGetImage).toHaveBeenCalledWith('sha256:a')
			expect(mockGetImage).toHaveBeenCalledWith('sha256:b')
		})

		it('keeps images still referenced by a container (409) while removing the rest', async () => {
			mockListImages.mockResolvedValue([{ Id: 'sha256:in-use' }, { Id: 'sha256:unused' }])
			mockImageRemove.mockImplementation((_ref: unknown) => {
				throw makeDockerError('(HTTP code 409) conflict - image is being used', 409)
			})

			await expect(service.removeUnusedImages()).resolves.toBeUndefined()
		})
	})
})
