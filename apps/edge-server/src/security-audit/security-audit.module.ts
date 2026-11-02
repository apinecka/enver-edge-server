import { Module } from '@nestjs/common'

import { AccountsReader } from './accounts.reader'
import { CommandRunner } from './command-runner'
import { AptParser } from './debian/apt.parser'
import { DebianCollector } from './debian/debian.collector'
import { HostFs } from './host-fs'
import { LoginAnalyzer } from './login-analyzer'
import { LoginsReader } from './logins-reader'
import { NetworkReader } from './network.reader'
import { OsReleaseParser } from './os-release.parser'
import { PersistenceReader } from './persistence.reader'
import { ProcessesReader } from './processes.reader'
import { SecurityAuditService } from './security-audit.service'
import { SecurityAuditTypes } from './security-audit.types'
import { SshLogParser } from './ssh-log.parser'
import { SshdConfigParser } from './sshd-config.parser'

@Module({
	providers: [
		SecurityAuditService,
		{ provide: HostFs, useValue: new HostFs() },
		CommandRunner,
		OsReleaseParser,
		SshdConfigParser,
		SshLogParser,
		LoginAnalyzer,
		LoginsReader,
		AptParser,
		NetworkReader,
		AccountsReader,
		PersistenceReader,
		ProcessesReader,
		DebianCollector,
		{ provide: SecurityAuditTypes.COLLECTORS, useFactory: (debian: DebianCollector) => [debian], inject: [DebianCollector] },
	],
	exports: [SecurityAuditService],
})
export class SecurityAuditModule {}
