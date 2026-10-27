import { DynamicModule, Global, Module } from '@nestjs/common'

import { DockerService } from './docker.service'
import { DockerTypes } from './docker.types'

@Global()
@Module({})
export class DockerModule {
	static forRoot(options: DockerTypes.Options): DynamicModule {
		return {
			module: DockerModule,
			providers: [
				{
					provide: DockerTypes.Options,
					useValue: new DockerTypes.Options(options),
				},
				DockerService,
			],
			exports: [DockerService],
		}
	}
}
