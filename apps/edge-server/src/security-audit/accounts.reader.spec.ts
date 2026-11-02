import { readFileSync } from 'fs'
import { join } from 'path'

import { AccountsReader } from './accounts.reader'
import { HostFs } from './host-fs'

const FIXTURES = join(__dirname, 'fixtures')

describe('AccountsReader', () => {
	const reader = new AccountsReader(new HostFs())
	const passwd = readFileSync(join(FIXTURES, 'debian-12/etc/passwd'), 'utf8')

	it('keeps only the accounts with UID 0, a login shell or a privileged group, and the privileged groups', () => {
		const group = 'root:x:0:\nadm:x:4:syslog\nsudo:x:27:deploy\nwheel:x:10:\ndocker:x:996:deploy,www-data\nusers:x:100:alice\nalice:x:1001:\n'
		expect(reader.parse(passwd, group)).toEqual({
			accounts: [
				{ name: 'root', uid: 0, loginShell: true },
				{ name: 'www-data', uid: 33, loginShell: false },
				{ name: 'deploy', uid: 1000, loginShell: true },
				{ name: 'alice', uid: 1001, loginShell: true },
				{ name: 'postgres', uid: 105, loginShell: true },
			],
			groups: [
				{ name: 'sudo', members: ['deploy'] },
				{ name: 'wheel', members: [] },
				{ name: 'docker', members: ['deploy', 'www-data'] },
			],
		})
	})

	it('counts a primary group as a membership and finds a second UID 0', () => {
		const result = reader.parse('root:x:0:0::/root:/bin/bash\ntoor:x:0:0::/root:/bin/sh\nops:x:1002:27::/home/ops:/usr/sbin/nologin\n# comment\nbroken\n', 'sudo:x:27:\n')
		expect(result.accounts).toEqual([
			{ name: 'root', uid: 0, loginShell: true },
			{ name: 'toor', uid: 0, loginShell: true },
			{ name: 'ops', uid: 1002, loginShell: false },
		])
		expect(result.groups).toEqual([{ name: 'sudo', members: ['ops'] }])
	})

	it('reads the files of the host', async () => {
		const result = await new AccountsReader(new HostFs(join(FIXTURES, 'ubuntu-24.04'))).read()
		expect(result.accounts.map((a) => a.name)).toEqual(['root', 'ubuntu'])
	})
})
