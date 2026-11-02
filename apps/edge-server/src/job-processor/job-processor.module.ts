import { Module } from '@nestjs/common'

import { BackupsService } from '../backups/backups.service'
import { EnvFilesService } from '../env-files/env-files.service'
import { HostDirsService } from '../host-dirs/host-dirs.service'
import { SecurityAuditModule } from '../security-audit/security-audit.module'
import { JobProcessorService } from './job-processor.service'

@Module({
	imports: [SecurityAuditModule],
	providers: [JobProcessorService, BackupsService, EnvFilesService, HostDirsService],
	exports: [JobProcessorService, HostDirsService, SecurityAuditModule],
})
export class JobProcessorModule {}
