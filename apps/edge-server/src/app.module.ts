import { DockerModule } from '@enver/domains/docker/docker.module'
import { KubernetesModule } from '@enver/domains/kubernetes/kubernetes.module'
import { EdgeProtocol } from '@enver/edge-protocol'
import { DynamicModule, Module } from '@nestjs/common'

import { config } from './app.config'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { toDockerOptions, toKubernetesOptions } from './edge-server-options'
import { InstanceLocator } from './instance-locator'
import { JobProcessorModule } from './job-processor/job-processor.module'
import { MetricsService } from './metrics/metrics.service'
import { SelfUpdateService } from './self-update/self-update.service'
import { SelfUpdateTypes } from './self-update/self-update.types'
import { SettingsClient } from './settings-client'

@Module({})
export class AppModule {
	/** `initialSettings` seeds the Docker/Kubernetes clients built at Nest bootstrap - both are
	 *  reconfigured at runtime as fresh settings are polled (see AppService), so this only matters
	 *  for the very first connection attempt. `settingsClient` is the same instance main.ts already
	 *  used for that initial fetch, so its ETag carries over into AppService's periodic polling.
	 *  `instance` already located the instance (main.ts). */
	static forRoot(initialSettings: EdgeProtocol.Settings, settingsClient: SettingsClient, instance: InstanceLocator): DynamicModule {
		return {
			module: AppModule,
			imports: [
				DockerModule.forRoot(toDockerOptions(initialSettings)),
				KubernetesModule.forRoot(toKubernetesOptions(initialSettings)),
				JobProcessorModule,
			],
			controllers: [AppController],
			providers: [
				AppService,
				MetricsService,
				SelfUpdateService,
				{ provide: SettingsClient, useValue: settingsClient },
				{ provide: InstanceLocator, useValue: instance },
				{
					provide: SelfUpdateTypes.OPTIONS,
					useValue: {
						version: config.version,
						// Read on every use: the agent follows its account to another instance.
						get apiUrl() { return instance.apiUrl },
						autoUpdate: initialSettings.autoUpdate !== false,
						homeDir: config.homeDir,
						ownDir: config.ownDir,
						signingKey: config.signingKey,
						platform: process.platform,
						arch: process.arch,
					} satisfies SelfUpdateTypes.Options,
				},
			],
		}
	}
}
