import { EdgeProtocol } from '@enver/edge-protocol'
import { Logger } from '@nestjs/common'

import { config } from './app.config'
import { InstanceLocator } from './instance-locator'

export type SettingsFetchResult = EdgeProtocol.Settings | 'unchanged' | null

/** Fetches edge server settings with ETag-based conditional requests - after the first successful
 *  fetch, subsequent calls send `If-None-Match` and the API responds 304 (no body, no decryption)
 *  until an admin actually changes something. One instance is shared between the blocking initial
 *  fetch in main.ts and AppService's periodic refresh, so the ETag carries over between them. */
export class SettingsClient {
	private etag: string | undefined
	private logger = new Logger(SettingsClient.name)

	constructor(private instance: InstanceLocator) {}

	/** Returns fresh settings, `'unchanged'` on a 304 (previous settings are still valid), or `null`
	 *  on failure (unreachable API, invalid token, ...). An account that moved to another instance (421) is
	 *  followed there once. */
	async fetch(followMove = true): Promise<SettingsFetchResult> {
		try {
			const res = await fetch(`${this.instance.apiUrl}/v1/edge-servers/settings`, {
				headers: {
					Authorization: `Bearer ${config.token}`,
					...(this.etag ? { 'If-None-Match': this.etag } : {}),
				},
			})
			if (res.status === 304) return 'unchanged'
			if (res.status === 421 && followMove) {
				await this.instance.relocate()
				return await this.fetch(false)
			}
			if (!res.ok) {
				this.logger.error(`Failed to fetch settings: ${res.status}`)
				return null
			}
			this.etag = res.headers.get('etag') ?? undefined
			return await res.json() as EdgeProtocol.Settings
		} catch (err) {
			this.logger.error({ err }, 'Failed to fetch settings from API')
			return null
		}
	}
}
