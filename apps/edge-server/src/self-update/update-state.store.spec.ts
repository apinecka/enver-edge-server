import { SelfUpdateTypes } from './self-update.types'
import { UpdateStateStore } from './update-state.store'

const NOW = new Date('2026-10-10T10:00:00.000Z')

function makeFs(files: Record<string, string> = {}) {
	return {
		files,
		readFile: jest.fn((path: string) => path in files ? Promise.resolve(files[path]) : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))),
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

function makeState(partial: Partial<SelfUpdateTypes.State> = {}): SelfUpdateTypes.State {
	return { ...SelfUpdateTypes.EMPTY_STATE, ...partial }
}

const STATE_PATH = '/opt/enver/edge-server/versions/state.json'

describe('UpdateStateStore', () => {
	let fs: ReturnType<typeof makeFs>
	let store: UpdateStateStore

	beforeEach(() => {
		jest.clearAllMocks()
		fs = makeFs()
		store = new UpdateStateStore('/opt/enver/edge-server', fs, () => NOW)
	})

	describe('read/write', () => {
		it('treats a missing file as the installed base', async () => {
			expect(await store.read()).toEqual(SelfUpdateTypes.EMPTY_STATE)
		})

		it('treats a damaged file as the installed base', async () => {
			fs.files[STATE_PATH] = '{not json'
			expect(await store.read()).toEqual(SelfUpdateTypes.EMPTY_STATE)
		})

		it('writes through a temp file and renames it over', async () => {
			const state = makeState({ current: '1.0.2' })
			await store.write(state)
			expect(fs.writeFile).toHaveBeenCalledWith(`${STATE_PATH}.tmp`, expect.any(String))
			expect(fs.rename).toHaveBeenCalledWith(`${STATE_PATH}.tmp`, STATE_PATH)
			expect(await store.read()).toEqual(state)
		})

		it('drops version names that could escape the versions directory', async () => {
			fs.files[STATE_PATH] = JSON.stringify({ current: '../../etc', previous: '1.0.1', pending: { version: '1.0.2/../x', starts: 1 }, failed: ['1.0.0', '/tmp/x'] })
			expect(await store.read()).toEqual({ current: null, previous: '1.0.1', pending: null, failed: ['1.0.0'] })
		})
	})

	describe('planStart', () => {
		const installed = (...versions: string[]) => (v: string) => versions.includes(v)

		it('runs the base without any state', () => {
			expect(store.planStart(makeState(), installed())).toEqual({ version: null, trial: false, state: makeState() })
		})

		it('runs a confirmed current version', () => {
			const state = makeState({ current: '1.0.2', previous: '1.0.1' })
			expect(store.planStart(state, installed('1.0.1', '1.0.2'))).toEqual({ version: '1.0.2', trial: false, state })
		})

		it('counts one more start of a pending version', () => {
			const state = makeState({ current: '1.0.2', pending: { version: '1.0.2', starts: 0, since: NOW.toISOString() } })
			const plan = store.planStart(state, installed('1.0.2'))
			expect(plan).toEqual(expect.objectContaining({ version: '1.0.2', trial: true }))
			expect(plan.state.pending?.starts).toBe(1)
		})

		it('rolls back a pending version that used up its starts', () => {
			const state = makeState({ current: '1.0.2', previous: '1.0.1', pending: { version: '1.0.2', starts: SelfUpdateTypes.MAX_TRIAL_STARTS, since: NOW.toISOString() } })
			expect(store.planStart(state, installed('1.0.1', '1.0.2'))).toEqual({
				version: '1.0.1',
				trial: false,
				state: { current: '1.0.1', previous: null, pending: null, failed: ['1.0.2'] },
			})
		})

		it('falls back to the base when the current version directory is gone', () => {
			const state = makeState({ current: '1.0.2', pending: { version: '1.0.2', starts: 0, since: NOW.toISOString() } })
			expect(store.planStart(state, installed())).toEqual({ version: null, trial: false, state: makeState({ current: null, pending: null }) })
		})

		it('falls back to the base when a rollback target is gone', () => {
			const state = makeState({ current: '1.0.2', previous: '1.0.1', pending: { version: '1.0.2', starts: 99, since: NOW.toISOString() } })
			expect(store.planStart(state, installed('1.0.2')).version).toBeNull()
		})

		it('drops a pending entry that does not match the current version', () => {
			const state = makeState({ current: '1.0.2', pending: { version: '1.0.3', starts: 0, since: NOW.toISOString() } })
			expect(store.planStart(state, installed('1.0.2'))).toEqual(expect.objectContaining({ version: '1.0.2', trial: false }))
		})
	})

	describe('afterExit', () => {
		const trialState = makeState({ current: '1.0.2', previous: '1.0.1', pending: { version: '1.0.2', starts: 1, since: NOW.toISOString() } })
		const trialPlan = { version: '1.0.2', trial: true, state: trialState }

		it('restarts into the new current version on the restart exit code', () => {
			expect(store.afterExit(trialState, trialPlan, SelfUpdateTypes.RESTART_EXIT_CODE)).toEqual({ action: 'restart', state: trialState })
		})

		it('rolls back a version on trial that crashed', () => {
			expect(store.afterExit(trialState, trialPlan, 1)).toEqual({
				action: 'restart',
				state: { current: '1.0.1', previous: null, pending: null, failed: ['1.0.2'] },
			})
		})

		it('leaves a confirmed version that crashed to the service manager', () => {
			const state = makeState({ current: '1.0.2', previous: '1.0.1' })
			expect(store.afterExit(state, { version: '1.0.2', trial: false, state }, 1)).toEqual({ action: 'exit', state })
		})

		it('does not roll back a trial that confirmed before it crashed', () => {
			const confirmed = store.confirm(trialState, '1.0.2')
			expect(store.afterExit(confirmed, trialPlan, 1)).toEqual({ action: 'exit', state: confirmed })
		})
	})

	describe('beginTrial/confirm/rollback', () => {
		it('switches to a new version on trial and remembers the running one', () => {
			const state = makeState({ current: '1.0.1', failed: ['1.0.2', '1.0.0'] })
			expect(store.beginTrial(state, '1.0.2', '1.0.1')).toEqual({
				current: '1.0.2',
				previous: '1.0.1',
				pending: { version: '1.0.2', starts: 0, since: NOW.toISOString() },
				failed: ['1.0.0'],
			})
		})

		it('confirms only the pending version', () => {
			const state = store.beginTrial(makeState(), '1.0.2', null)
			expect(store.confirm(state, '1.0.3')).toBe(state)
			expect(store.confirm(state, '1.0.2')).toEqual({ ...state, pending: null })
		})

		it('keeps only the latest failed versions', () => {
			const failed = Array.from({ length: SelfUpdateTypes.MAX_FAILED_VERSIONS }, (_, i) => `1.0.${i}`)
			const state = makeState({ current: '2.0.0', pending: { version: '2.0.0', starts: 1, since: '' }, failed })
			const rolledBack = store.rollback(state)
			expect(rolledBack.failed).toHaveLength(SelfUpdateTypes.MAX_FAILED_VERSIONS)
			expect(rolledBack.failed.at(-1)).toBe('2.0.0')
			expect(rolledBack.failed).not.toContain('1.0.0')
		})

		it('keeps the current, previous and pending version directories', () => {
			const state = store.beginTrial(makeState(), '1.0.2', '1.0.1')
			expect([...store.keep(state)].sort()).toEqual(['1.0.1', '1.0.2'])
		})
	})
})
