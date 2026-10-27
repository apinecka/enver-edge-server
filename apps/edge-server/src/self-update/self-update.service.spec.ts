import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import * as openpgp from 'openpgp'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { setTimeout as sleep } from 'timers/promises'

import { SelfUpdateService } from './self-update.service'
import { SelfUpdateTypes } from './self-update.types'

jest.mock('child_process', () => ({ execFile: jest.fn() }))
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFile: mockExecFile } = require('child_process') as { execFile: jest.Mock }

const API = 'https://api.test'
const PACKAGE = Buffer.from('fake deb package')
const SHA = createHash('sha256').update(PACKAGE).digest('hex')

function makeRelease(overrides: Record<string, unknown> = {}) {
	return {
		version: '1.0.5',
		linux: {
			arch: 'amd64', sha256: SHA, sizeBytes: PACKAGE.length, signatureAvailable: false,
			downloadPath: '/v1/edge-servers/installer', signaturePath: '/v1/edge-servers/installer.asc',
		},
		macos: null,
		signingKeyAvailable: false,
		...overrides,
	}
}

/** Lets real file I/O started by a fake timer finish. */
/** Waits in real time (timers/promises isn't faked), since the service does real file I/O. */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	for (let waited = 0; !condition() && waited < timeoutMs; waited += 10) await sleep(10)
}

function response(body: Buffer | object | null, status = 200) {
	const buf = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
	return new Response(status === 404 ? null : new Uint8Array(buf), { status })
}

describe('SelfUpdateService', () => {
	let home: string
	let fetchMock: jest.Mock
	let restart: jest.Mock
	let routes: Record<string, () => Response>
	let packagedVersion: string

	function makeService(overrides: Partial<SelfUpdateTypes.Options> = {}) {
		const service = new SelfUpdateService({
			version: '1.0.4',
			apiUrl: API,
			autoUpdate: true,
			homeDir: home,
			ownDir: home,
			signingKey: null,
			platform: 'linux',
			arch: 'x64',
			...overrides,
		})
		service.setRestartHandler(restart)
		return service
	}

	const statePath = () => join(home, 'versions', 'state.json')
	const readState = () => JSON.parse(readFileSync(statePath(), 'utf8')) as SelfUpdateTypes.State
	const writeState = (state: Partial<SelfUpdateTypes.State>) => {
		mkdirSync(dirname(statePath()), { recursive: true })
		writeFileSync(statePath(), JSON.stringify({ ...SelfUpdateTypes.EMPTY_STATE, ...state }))
	}

	beforeEach(() => {
		jest.clearAllMocks()
		jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
		home = mkdtempSync(join(tmpdir(), 'enver-self-update-'))
		restart = jest.fn().mockResolvedValue(undefined)
		packagedVersion = '1.0.5'
		routes = {
			'/v1/edge-servers/installer/release': () => response(makeRelease()),
			'/v1/edge-servers/installer': () => response(PACKAGE),
		}
		fetchMock = jest.fn((url: string) => {
			const route = routes[url.replace(API, '')]
			return Promise.resolve(route ? route() : response(null, 404))
		})
		global.fetch = fetchMock as unknown as typeof fetch

		// dpkg-deb -x lays the package out like a fresh install would.
		mockExecFile.mockImplementation((cmd: string, args: string[], ...rest: unknown[]) => {
			const callback = rest.at(-1) as (err: Error | null, out?: { stdout: string; stderr: string }) => void
			if (cmd === 'dpkg-deb') {
				const root = join(args[2], 'opt', 'enver', 'edge-server')
				mkdirSync(join(root, 'dist', 'apps', 'edge-server'), { recursive: true })
				mkdirSync(join(root, 'node', 'bin'), { recursive: true })
				writeFileSync(join(root, SelfUpdateTypes.ENTRYPOINT), '// agent')
				writeFileSync(join(root, SelfUpdateTypes.NODE_BIN), '#!node')
				writeFileSync(join(root, SelfUpdateTypes.VERSION_FILE), `${packagedVersion}\n`)
			}
			callback(null, { stdout: '', stderr: '' })
		})
	})

	afterEach(() => {
		jest.useRealTimers()
		rmSync(home, { recursive: true, force: true })
	})

	describe('support', () => {
		it('is unavailable without the launcher', async () => {
			const service = makeService({ homeDir: null })
			await service.onApplicationBootstrap()
			expect(service.status().selfUpdate).toBe(SelfUpdateTypes.Support.noLauncher)

			await service.checkNow(true)
			expect(fetchMock).not.toHaveBeenCalled()
		})

		it('is unavailable when the versions directory cannot be created', async () => {
			writeFileSync(join(home, 'versions'), 'a file in the way')
			const service = makeService()
			await service.onApplicationBootstrap()
			expect(service.status().selfUpdate).toBe(SelfUpdateTypes.Support.notWritable)
		})

		it('reports a version that was rolled back from', async () => {
			writeState({ failed: ['1.0.3', '1.0.5'] })
			const service = makeService()
			await service.onApplicationBootstrap()
			expect(service.status()).toEqual(expect.objectContaining({ selfUpdate: SelfUpdateTypes.Support.supported, rolledBackVersion: '1.0.5', platform: 'linux-x64' }))
		})
	})

	describe('checkNow', () => {
		it('does nothing when no newer version is published', async () => {
			routes['/v1/edge-servers/installer/release'] = () => response(makeRelease({ version: '1.0.4' }))
			const service = makeService()
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(fetchMock).toHaveBeenCalledTimes(1)
			expect(restart).not.toHaveBeenCalled()
			expect(service.status()).toEqual(expect.objectContaining({ state: SelfUpdateTypes.UpdateState.idle, lastError: null, lastCheckAt: expect.any(String) }))
		})

		it('installs a newer version next to the running one, puts it on trial and restarts', async () => {
			const service = makeService()
			const statuses: string[] = []
			service.onStatusChange((s) => statuses.push(s.state))
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(mockExecFile).toHaveBeenCalledWith('dpkg-deb', ['-x', join(home, 'versions', '.staging', 'package'), expect.any(String)], expect.anything(), expect.any(Function))
			expect(existsSync(join(home, 'versions', '1.0.5', SelfUpdateTypes.ENTRYPOINT))).toBe(true)
			expect(existsSync(join(home, 'versions', '.staging'))).toBe(false)
			expect(readState()).toEqual({ current: '1.0.5', previous: null, pending: { version: '1.0.5', starts: 0, since: expect.any(String) }, failed: [] })
			expect(restart).toHaveBeenCalled()
			expect(statuses).toEqual(['idle', 'checking', 'downloading', 'restarting'])
		})

		it('remembers the version directory it ran from as the rollback target', async () => {
			mkdirSync(join(home, 'versions', '1.0.4'), { recursive: true })
			const service = makeService({ ownDir: join(home, 'versions', '1.0.4') })
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(readState()).toEqual(expect.objectContaining({ current: '1.0.5', previous: '1.0.4' }))
		})

		it('refuses a package whose SHA-256 does not match', async () => {
			routes['/v1/edge-servers/installer'] = () => response(Buffer.from('tampered package'))
			const service = makeService()
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(restart).not.toHaveBeenCalled()
			expect(existsSync(statePath())).toBe(false)
			expect(existsSync(join(home, 'versions', '1.0.5'))).toBe(false)
			expect(service.status()).toEqual(expect.objectContaining({ state: SelfUpdateTypes.UpdateState.idle, lastError: expect.stringContaining('SHA-256') }))
		})

		it('refuses a package larger than announced', async () => {
			routes['/v1/edge-servers/installer'] = () => response(Buffer.concat([PACKAGE, Buffer.from('more')]))
			const service = makeService()
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(service.status().lastError).toContain('larger')
			expect(restart).not.toHaveBeenCalled()
		})

		it('refuses a package that claims another version', async () => {
			packagedVersion = '1.0.6'
			const service = makeService()
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(service.status().lastError).toContain('1.0.6')
			expect(restart).not.toHaveBeenCalled()
		})

		it('reports a missing package for this architecture', async () => {
			const service = makeService({ arch: 'arm64' })
			await service.onApplicationBootstrap()

			await service.checkNow(false)

			expect(service.status().lastError).toBe('No package of 1.0.5 for linux-arm64')
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('skips a version it rolled back from, unless forced', async () => {
			writeState({ failed: ['1.0.5'] })
			const service = makeService()
			await service.onApplicationBootstrap()

			await service.checkNow(false)
			expect(restart).not.toHaveBeenCalled()

			await service.checkNow(true)
			expect(restart).toHaveBeenCalled()
			expect(readState().failed).toEqual([])
		})

		it('refuses a release version that is not a plain version name', async () => {
			routes['/v1/edge-servers/installer/release'] = () => response(makeRelease({ version: '9.0.0-x/../../etc' }))
			const service = makeService()
			await service.onApplicationBootstrap()

			await service.checkNow(true)

			expect(restart).not.toHaveBeenCalled()
		})

		describe('with a pinned signing key', () => {
			const signedRelease = () => makeRelease({ linux: { ...makeRelease().linux, signatureAvailable: true } })
			const sign = async (privateKey: openpgp.PrivateKey, data: Buffer) => openpgp.sign({
				message: await openpgp.createMessage({ binary: data }),
				signingKeys: privateKey,
				detached: true,
			})

			let signingKey: openpgp.PrivateKey
			let otherKey: openpgp.PrivateKey

			beforeAll(async () => {
				const generate = async () => openpgp.readPrivateKey({ binaryKey: (await openpgp.generateKey({ userIDs: [{ name: 'Enver test' }], format: 'binary' })).privateKey })
				signingKey = await generate()
				otherKey = await generate()
			})

			beforeEach(() => {
				writeFileSync(join(home, SelfUpdateTypes.SIGNING_KEY_FILE), signingKey.toPublic().write())
			})

			it('refuses an unsigned release', async () => {
				const service = makeService()
				await service.onApplicationBootstrap()

				await service.checkNow(false)

				expect(service.status().lastError).toContain('not signed')
				expect(restart).not.toHaveBeenCalled()
			})

			it('installs a package signed by the pinned key', async () => {
				const signature = await sign(signingKey, PACKAGE)
				routes['/v1/edge-servers/installer/release'] = () => response(signedRelease())
				routes['/v1/edge-servers/installer.asc'] = () => response(Buffer.from(signature))
				const service = makeService()
				await service.onApplicationBootstrap()

				await service.checkNow(false)

				expect(service.status().lastError).toBeNull()
				expect(restart).toHaveBeenCalled()
			})

			it.each([
				['another key', async () => sign(otherKey, PACKAGE)],
				['a different package', async () => sign(signingKey, Buffer.from('tampered package'))],
				['garbage', () => Promise.resolve('not a signature')],
			])('refuses a package whose signature is by %s', async (_label, makeSignature) => {
				const signature = await makeSignature()
				routes['/v1/edge-servers/installer/release'] = () => response(signedRelease())
				routes['/v1/edge-servers/installer.asc'] = () => response(Buffer.from(signature))
				const service = makeService()
				await service.onApplicationBootstrap()

				await service.checkNow(false)

				expect(service.status().lastError).toContain('does not verify')
				expect(restart).not.toHaveBeenCalled()
			})

			it('requires a signature by the baked-in key even when the key file is gone', async () => {
				rmSync(join(home, SelfUpdateTypes.SIGNING_KEY_FILE))
				const service = makeService({ signingKey: signingKey.toPublic().write() })
				await service.onApplicationBootstrap()

				await service.checkNow(false)

				expect(service.status().lastError).toContain('not signed')
				expect(restart).not.toHaveBeenCalled()
			})

			it('trusts the baked-in key over a key file someone replaced', async () => {
				writeFileSync(join(home, SelfUpdateTypes.SIGNING_KEY_FILE), otherKey.toPublic().write())
				const signature = await sign(otherKey, PACKAGE)
				routes['/v1/edge-servers/installer/release'] = () => response(signedRelease())
				routes['/v1/edge-servers/installer.asc'] = () => response(Buffer.from(signature))
				const service = makeService({ signingKey: signingKey.toPublic().write() })
				await service.onApplicationBootstrap()

				await service.checkNow(false)

				expect(service.status().lastError).toContain('does not verify')
				expect(restart).not.toHaveBeenCalled()
			})
		})
	})

	describe('scheduled checks', () => {
		it('checks only while auto-update is on', async () => {
			const service = makeService({ autoUpdate: false })
			await service.onApplicationBootstrap()

			await jest.advanceTimersByTimeAsync(SelfUpdateTypes.FIRST_CHECK_DELAY_MAX_MS)
			expect(fetchMock).not.toHaveBeenCalled()

			service.setAutoUpdate(true)
			await jest.advanceTimersByTimeAsync(SelfUpdateTypes.CHECK_INTERVAL_MS + SelfUpdateTypes.CHECK_JITTER_MS)
			expect(fetchMock).toHaveBeenCalled()
			service.onApplicationShutdown()
		})
	})

	describe('confirmation', () => {
		it('confirms the version on trial after its connection stayed up, and prunes old versions', async () => {
			for (const v of ['1.0.3', '1.0.4', '1.0.5']) mkdirSync(join(home, 'versions', v), { recursive: true })
			writeState({ current: '1.0.5', previous: '1.0.4', pending: { version: '1.0.5', starts: 1, since: '' }, failed: ['1.0.5'] })
			const service = makeService({ version: '1.0.5', ownDir: join(home, 'versions', '1.0.5') })
			const emitted = jest.fn()
			service.onStatusChange(emitted)
			await service.onApplicationBootstrap()

			service.onConnected()
			await jest.advanceTimersByTimeAsync(SelfUpdateTypes.CONFIRM_AFTER_MS)
			await waitFor(() => emitted.mock.calls.length >= 3)

			expect(readState()).toEqual(expect.objectContaining({ current: '1.0.5', previous: '1.0.4', pending: null }))
			expect(existsSync(join(home, 'versions', '1.0.3'))).toBe(false)
			expect(existsSync(join(home, 'versions', '1.0.4'))).toBe(true)
			service.onApplicationShutdown()
		})

		it('confirms when the connection came up before self-update support was detected', async () => {
			mkdirSync(join(home, 'versions', '1.0.5'), { recursive: true })
			writeState({ current: '1.0.5', pending: { version: '1.0.5', starts: 1, since: '' } })
			const service = makeService({ version: '1.0.5', ownDir: join(home, 'versions', '1.0.5') })
			const reported: string[] = []
			service.onStatusChange((s) => reported.push(s.selfUpdate))

			service.onConnected()
			await service.onApplicationBootstrap()
			await jest.advanceTimersByTimeAsync(SelfUpdateTypes.CONFIRM_AFTER_MS)
			await waitFor(() => reported.length >= 2)

			expect(readState().pending).toBeNull()
			expect(reported).toContain(SelfUpdateTypes.Support.supported)
			service.onApplicationShutdown()
		})

		it('does not confirm when the connection dropped too early', async () => {
			mkdirSync(join(home, 'versions', '1.0.5'), { recursive: true })
			writeState({ current: '1.0.5', pending: { version: '1.0.5', starts: 1, since: '' } })
			const service = makeService({ version: '1.0.5', ownDir: join(home, 'versions', '1.0.5') })
			await service.onApplicationBootstrap()

			service.onConnected()
			service.onDisconnected()
			await jest.advanceTimersByTimeAsync(SelfUpdateTypes.CONFIRM_AFTER_MS)

			expect(readState().pending).not.toBeNull()
			service.onApplicationShutdown()
		})
	})
})
