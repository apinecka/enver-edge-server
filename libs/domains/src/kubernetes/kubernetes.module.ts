import { DynamicModule, Global, Module } from '@nestjs/common'

import { KubernetesService } from './kubernetes.service'
import { KubernetesTypes } from './kubernetes.types'

@Global()
@Module({})
export class KubernetesModule {
	static forRoot(options: KubernetesTypes.Options): DynamicModule {
		return {
			module: KubernetesModule,
			providers: [
				{
					provide: KubernetesTypes.Options,
					useValue: new KubernetesTypes.Options(options),
				},
				KubernetesService,
			],
			exports: [KubernetesService],
		}
	}
}
