import { InstanceLocator } from './instance-locator'
import { SettingsClient } from './settings-client'

describe('SettingsClient', () => {
	let fetchMock: jest.Mock
	const settings = { edgeServerGuid: 'e1', name: 'edge' }

	beforeEach(() => {
		jest.clearAllMocks()
		fetchMock = jest.fn()
		global.fetch = fetchMock
	})

	it('follows the account to its new instance when the old one answers 421', async () => {
		const locator = { apiUrl: 'https://free.example', relocate: jest.fn(() => { locator.apiUrl = 'https://eu1.example'; return Promise.resolve() }) }
		fetchMock
			.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'account_moved' }), { status: 421 }))
			.mockResolvedValueOnce(new Response(JSON.stringify(settings), { status: 200 }))

		const result = await new SettingsClient(locator as unknown as InstanceLocator).fetch()

		expect(result).toEqual(settings)
		expect(locator.relocate).toHaveBeenCalledTimes(1)
		expect(fetchMock).toHaveBeenLastCalledWith('https://eu1.example/v1/edge-servers/settings', expect.anything())
	})

	it('gives up after following once', async () => {
		const locator = { apiUrl: 'https://free.example', relocate: jest.fn(() => Promise.resolve()) }
		fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: 'account_moved' }), { status: 421 })))

		expect(await new SettingsClient(locator as unknown as InstanceLocator).fetch()).toBeNull()
		expect(locator.relocate).toHaveBeenCalledTimes(1)
	})
})
