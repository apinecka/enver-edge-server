import { InstanceLocator } from './instance-locator'

const HUB = 'https://hub.example'
const TOKEN = '11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222'

describe('InstanceLocator', () => {
	let fetchMock: jest.Mock

	beforeEach(() => {
		jest.clearAllMocks()
		fetchMock = jest.fn()
		global.fetch = fetchMock
	})

	const respond = (status: number, body: unknown) => fetchMock.mockResolvedValue(new Response(body === undefined ? 'Not Found' : JSON.stringify(body), { status }))

	it('connects to the instance the hub names, asking with the agent token', async () => {
		respond(200, { apiUrl: 'https://eu1.example/' })
		const locator = new InstanceLocator(HUB, TOKEN)

		expect(await locator.locate()).toEqual({ apiUrl: 'https://eu1.example' })
		expect(locator.apiUrl).toBe('https://eu1.example')
		expect(fetchMock).toHaveBeenCalledWith(`${HUB}/v1/edge-servers/instance`, { headers: { Authorization: `Bearer ${TOKEN}` } })
	})

	it('refuses an instance the hub names without https', async () => {
		respond(200, { apiUrl: 'http://eu1.example' })
		const locator = new InstanceLocator(HUB, TOKEN)

		expect(await locator.locate()).toBeNull()
		expect(() => locator.apiUrl).toThrow()
	})

	it.each([
		['https://hub.example', true],
		['http://localhost:3000', true],
		['http://127.0.0.1:3000', true],
		['http://[::1]:3000', true],
		['http://hub.example', false],
		['ws://hub.example', false],
		['not a url', false],
	])('isSecure(%s) is %p', (url, secure) => {
		expect(InstanceLocator.isSecure(url)).toBe(secure)
	})

	it('stays with an API_URL that is an instance rather than the hub', async () => {
		respond(404, { statusCode: 404, message: 'Cannot GET /v1/edge-servers/instance' })
		const locator = new InstanceLocator(HUB, TOKEN)

		expect(await locator.locate()).toEqual({ apiUrl: HUB })
	})

	it.each([
		['the hub doesn\'t know the edge server yet', 404, { code: 'edge_server_not_found' }],
		['the token has no guid to route by', 401, { code: 'legacy_edge_server_token' }],
		['the hub fails', 502, undefined],
	])('retries later when %s', async (_case, status, body) => {
		respond(status, body)
		const locator = new InstanceLocator(HUB, TOKEN)

		expect(await locator.locate()).toBeNull()
		expect(() => locator.apiUrl).toThrow()
	})

	it('retries later when the hub is unreachable', async () => {
		fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

		expect(await new InstanceLocator(HUB, TOKEN).locate()).toBeNull()
	})

	it('asks the hub again once the account moved, and keeps the token', async () => {
		respond(200, { apiUrl: 'https://free.example' })
		const locator = new InstanceLocator(HUB, TOKEN)
		await locator.locate()

		respond(200, { apiUrl: 'https://eu1.example' })
		await Promise.all([locator.relocate(), locator.relocate()])

		expect(locator.apiUrl).toBe('https://eu1.example')
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(fetchMock).toHaveBeenLastCalledWith(`${HUB}/v1/edge-servers/instance`, { headers: { Authorization: `Bearer ${TOKEN}` } })
	})
})
