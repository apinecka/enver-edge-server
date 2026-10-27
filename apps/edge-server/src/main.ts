import { EdgeProtocol } from '@enver/edge-protocol'
import { ConsoleLogger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'

import { config } from './app.config'
import { AppModule } from './app.module'
import { HostDirsService } from './host-dirs/host-dirs.service'
import { InstanceLocator } from './instance-locator'
import { JobProcessorService } from './job-processor/job-processor.service'
import { SelfUpdateService } from './self-update/self-update.service'
import { SelfUpdateTypes } from './self-update/self-update.types'
import { SettingsClient } from './settings-client'

const SETTINGS_RETRY_INTERVAL_MS = 5_000
const LOCATE_RETRY_INTERVAL_MS = 5_000

/** Asks the hub which instance to connect to, until it knows - the hub learns of a new edge server a
 *  few seconds after it was created. */
async function awaitInstance(locator: InstanceLocator, logger: ConsoleLogger): Promise<void> {
	while (!await locator.locate()) {
		logger.warn(`Instance not located yet, retrying in ${LOCATE_RETRY_INTERVAL_MS / 1000}s...`)
		await new Promise((resolve) => setTimeout(resolve, LOCATE_RETRY_INTERVAL_MS))
	}
}

/** Blocks bootstrap until the API is reachable and the token is valid - the Docker/Kubernetes
 *  clients built at Nest bootstrap need an initial value, so there's no useful degraded mode
 *  before this resolves. Never resolves to 'unchanged' - there's no previous ETag yet on a fresh client. */
async function awaitInitialSettings(client: SettingsClient, logger: ConsoleLogger): Promise<EdgeProtocol.Settings> {
	for (;;) {
		const result = await client.fetch()
		if (result && result !== 'unchanged') {
			logger.log(`Connected as edge server: ${result.edgeServerGuid} (${result.name}), agent ${config.version}`)
			return result
		}
		logger.warn(`Settings not available yet, retrying in ${SETTINGS_RETRY_INTERVAL_MS / 1000}s...`)
		await new Promise((resolve) => setTimeout(resolve, SETTINGS_RETRY_INTERVAL_MS))
	}
}

async function bootstrap() {
	const logger = new ConsoleLogger({ prefix: 'EDGE-SERVER' })

	if (!config.token) {
		logger.error('EDGE_SERVER_TOKEN is not set')
		process.exit(1)
	}

	if (!InstanceLocator.isSecure(config.hubUrl)) {
		logger.error(`API_URL must be an https:// address (http only for localhost): ${config.hubUrl}`)
		process.exit(1)
	}

	const locator = new InstanceLocator(config.hubUrl, config.token)
	await awaitInstance(locator, logger)

	const settingsClient = new SettingsClient(locator)
	const initialSettings = await awaitInitialSettings(settingsClient, logger)

	const app = await NestFactory.create(AppModule.forRoot(initialSettings, settingsClient, locator), { logger })
	// Before listen(), which starts the connection: the first jobs already obey these settings.
	app.get(HostDirsService).configure(initialSettings)
	app.get(JobProcessorService).setImageCleanupMode(initialSettings.imageCleanupMode)
	app.get(SelfUpdateService).setRestartHandler(async () => {
		await app.close()
		process.exit(SelfUpdateTypes.RESTART_EXIT_CODE)
	})
	await app.listen(config.port, () => console.log(`Edge server listening on port ${config.port}`))
}
void bootstrap()
