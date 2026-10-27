import { Logger } from '@nestjs/common'

export type InstanceLocateResult = { apiUrl: string } | null

const RELOCATE_RETRY_INTERVAL_MS = 5_000

/** `API_URL` points to the hub, which answers which instance the edge server's account lives on - the
 *  agent then talks only to that instance, as before. The answer is kept in memory only; the env file is
 *  never rewritten. An `API_URL` that still points to an instance (installed before the hub) has no
 *  such endpoint, so the agent stays with it. */
export class InstanceLocator {
	private logger = new Logger(InstanceLocator.name)
	private resolved: string | null = null
	private relocating: Promise<void> | null = null

	constructor(
		private hubUrl: string,
		private token: string,
	) {}

	/** The token and the decrypted secrets travel over these connections, so plain http is only for a
	 *  hub or instance on this machine (development). */
	static isSecure(url: string): boolean {
		try {
			const { protocol, hostname } = new URL(url)
			return protocol === 'https:' || (protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname))
		} catch {
			return false
		}
	}

	/** The instance's URL - only after `locate()` succeeded. */
	get apiUrl(): string {
		if (!this.resolved) throw new Error('The instance has not been located yet')
		return this.resolved
	}

	/** Asks the hub; `null` when it can't answer yet (unreachable, or the hub hasn't heard of a new
	 *  edge server from its instance) - the caller retries. */
	async locate(): Promise<InstanceLocateResult> {
		try {
			const res = await fetch(`${this.hubUrl}/v1/edge-servers/instance`, { headers: { Authorization: `Bearer ${this.token}` } })
			const body = await res.json().catch(() => null) as { apiUrl?: unknown, code?: unknown } | null
			if (res.ok && typeof body?.apiUrl === 'string') {
				if (InstanceLocator.isSecure(body.apiUrl)) return this.use(body.apiUrl.replace(/\/+$/, ''))
				this.logger.error(`The hub named an instance without https (${body.apiUrl}) - refusing to connect to it`)
				return null
			}
			if (res.status === 404 && body?.code !== 'edge_server_not_found') {
				this.logger.warn(`${this.hubUrl} is not a hub - connecting to it as the instance. Point API_URL to the hub.`)
				return this.use(this.hubUrl)
			}
			if (body?.code === 'legacy_edge_server_token')
				this.logger.error('The hub needs the token in the <edgeServerGuid>.<secret> form - copy EDGE_SERVER_TOKEN again from the edge server\'s page in Enver')
			else
				this.logger.warn(`The hub can't locate this edge server's instance yet: HTTP ${res.status}${typeof body?.code === 'string' ? ` ${body.code}` : ''}`)
			return null
		} catch (err) {
			this.logger.error({ err }, `Failed to reach the hub at ${this.hubUrl}`)
			return null
		}
	}

	/** The account moved to another instance (`421 account_moved`, or the socket closed with its code): asks
	 *  the hub again until it answers. Concurrent callers wait for the same answer. The token stays valid. */
	async relocate(): Promise<void> {
		this.relocating ??= (async () => {
			this.logger.warn('The account moved to another instance - asking the hub where')
			while (!await this.locate()) await new Promise((resolve) => setTimeout(resolve, RELOCATE_RETRY_INTERVAL_MS))
		})().finally(() => { this.relocating = null })
		await this.relocating
	}

	private use(apiUrl: string): InstanceLocateResult {
		if (apiUrl !== this.resolved) this.logger.log(`Instance: ${apiUrl}`)
		this.resolved = apiUrl
		return { apiUrl }
	}
}
