import fs from 'fs'
import webpack from 'webpack'

import init from '../../webpack.common.mjs'

const { output, plugins: commonPlugins } = init('edge-server')
export { output }

// launcher.js is the stable process systemd/launchd runs; it starts main.js of the current version
// (see src/launcher). Both land in dist/apps/edge-server/.
export const entry = {
	main: './apps/edge-server/src/main.ts',
	launcher: './apps/edge-server/src/launcher/main.ts',
}

// The release version is baked in, so every version directory knows what it is without reading
// files. Local builds report "dev" and never self-update.
// The release key every self-update must be signed by: the public repository keeps it at its root,
// this monorepo in the export's template.
const signingKeyFile = ['enver-signing-key.gpg', 'scripts/oss/edge-server/public/enver-signing-key.gpg'].find((file) => fs.existsSync(file))

export const plugins = [
	...commonPlugins,
	new webpack.DefinePlugin({
		'process.env.ENVER_BUILD_VERSION': JSON.stringify(process.env.ENVER_BUILD_VERSION || 'dev'),
		'process.env.ENVER_PINNED_SIGNING_KEY': JSON.stringify(signingKeyFile ? fs.readFileSync(signingKeyFile).toString('base64') : ''),
	}),
]

// The agent is open source and runs on its users' machines, so the shipped bundle stays readable:
// anyone can compare it with the published source and read its stack traces.
export const mode = 'none'
export const optimization = { nodeEnv: false }
