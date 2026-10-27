import { Module } from '@nestjs/common'

import { BackupsService } from '../backups/backups.service'
import { EnvFilesService } from '../env-files/env-files.service'
import { HostDirsService } from '../host-dirs/host-dirs.service'
import { JobProcessorService } from './job-processor.service'

@Module({
	providers: [JobProcessorService, BackupsService, EnvFilesService, HostDirsService],
	exports: [JobProcessorService, HostDirsService],
})
export class JobProcessorModule {}
