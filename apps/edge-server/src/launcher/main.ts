import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile, rename, writeFile } from 'fs/promises'
import { resolve } from 'path'

import { UpdateStateStore } from '../self-update/update-state.store'
import { Launcher } from './launcher'

// Bundled to dist/apps/edge-server/launcher.js of the installed base, three levels below its root.
const homeDir = resolve(__dirname, '../../..')
const store = new UpdateStateStore(homeDir, { readFile, writeFile, rename })
const launcher = new Launcher(homeDir, store, {
	spawn,
	exists: existsSync,
	exit: (code) => process.exit(code),
	log: (message) => console.log(`[enver-launcher] ${message}`),
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: (timer) => clearTimeout(timer),
	env: process.env,
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
	process.on(signal, () => launcher.stop(signal))
}

launcher.start().catch((err: unknown) => {
	console.error('[enver-launcher] Failed to start', err)
	process.exit(1)
})
