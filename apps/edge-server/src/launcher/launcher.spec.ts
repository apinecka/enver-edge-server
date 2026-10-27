import { EventEmitter } from 'events'

import { SelfUpdateTypes } from '../self-update/self-update.types'
import { UpdateStateStore } from '../self-update/update-state.store'
import { Launcher } from './launcher'

const HOME = '/opt/enver/edge-server'
const STATE_PATH = `${HOME}/versions/state.json`

class FakeChild extends EventEmitter {
	kill = jest.fn((signal: string) => {
		this.signal = signal
		return true
	})
	signal: string | null = null
}

function makeFs(state?: SelfUpdateTypes.State) {
	const files: Record<string, string> = state ? { [STATE_PATH]: JSON.stringify(state) } : {}
	return {
		files,
		readFile: jest.fn((path: string) => path in files ? Promise.resolve(files[path]) : Promise.reject(new Error('ENOENT'))),
		writeFile: jest.fn((path: string, data: string) => {
			files[path] = data
			return Promise.resolve()
		}),
		rename: jest.fn((from: string, to: string) => {
			files[to] = files[from]
			delete files[from]
			return Promise.resolve()
		}),
	}
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('Launcher', () => {
	let children: FakeChild[]
	let timers: { fn: () => void; ms: number }[]
	let installed: Set<string>
	const mockDeps = {
		spawn: jest.fn(),
		exists: jest.fn(),
		exit: jest.fn(),
		log: jest.fn(),
		setTimeout: jest.fn(),
		clearTimeout: jest.fn(),
		env: { EDGE_SERVER_TOKEN: 'tok' } as NodeJS.ProcessEnv,
	}

	function makeLauncher(state?: SelfUpdateTypes.State) {
		const fs = makeFs(state)
		const store = new UpdateStateStore(HOME, fs)
		return { fs, store, launcher: new Launcher(HOME, store, mockDeps) }
	}

	const readState = (fs: ReturnType<typeof makeFs>) => JSON.parse(fs.files[STATE_PATH]) as SelfUpdateTypes.State
	const lastSpawnedEntry = () => mockDeps.spawn.mock.calls.at(-1)?.[1][0] as string

	beforeEach(() => {
		jest.clearAllMocks()
		children = []
		timers = []
		installed = new Set(['1.0.1', '1.0.2'])
		mockDeps.spawn.mockImplementation(() => {
			const child = new FakeChild()
			children.push(child)
			return child
		})
		mockDeps.exists.mockImplementation((path: string) => [...installed].some((v) => path.startsWith(`${HOME}/versions/${v}/`)))
		mockDeps.setTimeout.mockImplementation((fn: () => void, ms: number) => {
			timers.push({ fn, ms })
			return timers.length as unknown as ReturnType<typeof setTimeout>
		})
	})

	it('starts the installed base with the launcher environment', async () => {
		const { launcher } = makeLauncher()
		await launcher.start()
		expect(mockDeps.spawn).toHaveBeenCalledWith(
			`${HOME}/node/bin/node`,
			[`${HOME}/dist/apps/edge-server/main.js`],
			expect.objectContaining({ env: expect.objectContaining({ EDGE_SERVER_TOKEN: 'tok', ENVER_EDGE_SERVER_HOME: HOME, ENVER_EDGE_SERVER_LAUNCHER: '1' }) }),
		)
	})

	it('lets the agent write its TLS session keys when SSLKEYLOGFILE is set', async () => {
		mockDeps.env = { EDGE_SERVER_TOKEN: 'tok', SSLKEYLOGFILE: '/tmp/keys.log' }
		try {
			const { launcher } = makeLauncher()
			await launcher.start()
			expect(mockDeps.spawn).toHaveBeenCalledWith(`${HOME}/node/bin/node`, ['--tls-keylog=/tmp/keys.log', `${HOME}/dist/apps/edge-server/main.js`], expect.anything())
		} finally {
			mockDeps.env = { EDGE_SERVER_TOKEN: 'tok' }
		}
	})

	it('starts the current version from its own directory, with its own Node.js', async () => {
		const { launcher } = makeLauncher({ current: '1.0.2', previous: null, pending: null, failed: [] })
		await launcher.start()
		expect(mockDeps.spawn).toHaveBeenCalledWith(`${HOME}/versions/1.0.2/node/bin/node`, [`${HOME}/versions/1.0.2/dist/apps/edge-server/main.js`], expect.anything())
	})

	it('restarts into the new version when the child asks for it', async () => {
		const { fs, launcher } = makeLauncher()
		await launcher.start()
		fs.files[STATE_PATH] = JSON.stringify({ current: '1.0.2', previous: null, pending: { version: '1.0.2', starts: 0, since: '' }, failed: [] })

		children[0].emit('exit', SelfUpdateTypes.RESTART_EXIT_CODE)
		await flush()

		expect(lastSpawnedEntry()).toBe(`${HOME}/versions/1.0.2/dist/apps/edge-server/main.js`)
		expect(readState(fs).pending?.starts).toBe(1)
		expect(timers.at(-1)?.ms).toBe(SelfUpdateTypes.TRIAL_TIMEOUT_MS)
		expect(mockDeps.exit).not.toHaveBeenCalled()
	})

	it('rolls back when the version on trial crashes', async () => {
		const { fs, launcher } = makeLauncher({ current: '1.0.2', previous: '1.0.1', pending: { version: '1.0.2', starts: 0, since: '' }, failed: [] })
		await launcher.start()

		children[0].emit('exit', 1)
		await flush()

		expect(readState(fs)).toEqual({ current: '1.0.1', previous: null, pending: null, failed: ['1.0.2'] })
		expect(lastSpawnedEntry()).toBe(`${HOME}/versions/1.0.1/dist/apps/edge-server/main.js`)
	})

	it('rolls back when the version on trial cannot even be started', async () => {
		const { fs, launcher } = makeLauncher({ current: '1.0.2', previous: null, pending: { version: '1.0.2', starts: 0, since: '' }, failed: [] })
		await launcher.start()

		children[0].emit('error', new Error('EACCES'))
		await flush()

		expect(readState(fs).current).toBeNull()
		expect(lastSpawnedEntry()).toBe(`${HOME}/dist/apps/edge-server/main.js`)
	})

	it('rolls back a version on trial that never confirms', async () => {
		const { fs, launcher } = makeLauncher({ current: '1.0.2', previous: '1.0.1', pending: { version: '1.0.2', starts: 0, since: '' }, failed: [] })
		await launcher.start()

		timers[0].fn()
		await flush()
		expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
		expect(readState(fs).current).toBe('1.0.1')

		children[0].emit('exit', null)
		await flush()
		expect(lastSpawnedEntry()).toBe(`${HOME}/versions/1.0.1/dist/apps/edge-server/main.js`)
	})

	it('keeps a version that confirmed before the trial timeout', async () => {
		const { fs, launcher } = makeLauncher({ current: '1.0.2', previous: '1.0.1', pending: { version: '1.0.2', starts: 0, since: '' }, failed: [] })
		await launcher.start()
		fs.files[STATE_PATH] = JSON.stringify({ current: '1.0.2', previous: '1.0.1', pending: null, failed: [] })

		timers[0].fn()
		await flush()

		expect(children[0].kill).not.toHaveBeenCalled()
		expect(readState(fs).current).toBe('1.0.2')
	})

	it('exits with the child\'s code when a confirmed version crashes, for the service manager to restart', async () => {
		const { launcher } = makeLauncher({ current: '1.0.2', previous: '1.0.1', pending: null, failed: [] })
		await launcher.start()

		children[0].emit('exit', 3)
		await flush()

		expect(mockDeps.exit).toHaveBeenCalledWith(3)
		expect(mockDeps.spawn).toHaveBeenCalledTimes(1)
	})

	it('forwards a stop signal and exits once the child is gone', async () => {
		const { launcher } = makeLauncher({ current: '1.0.2', previous: null, pending: { version: '1.0.2', starts: 0, since: '' }, failed: [] })
		await launcher.start()

		launcher.stop('SIGTERM')
		expect(children[0].kill).toHaveBeenCalledWith('SIGTERM')
		children[0].emit('exit', null)
		await flush()

		expect(mockDeps.exit).toHaveBeenCalledWith(0)
		expect(mockDeps.spawn).toHaveBeenCalledTimes(1)
	})
})
