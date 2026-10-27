import fs from 'fs'
import GeneratePackageJsonPlugin from 'generate-package-json-webpack-plugin'
import path from 'path'

const packageRaw = fs.readFileSync('package.json')
const packageJson = JSON.parse(packageRaw)

export default (appName, version = '1.0.0') => ({
	plugins: [
		new GeneratePackageJsonPlugin({
			'name': `envar/${appName}`,
			'version': version,
			'main': './main.js',
			'engines': packageJson.engines,
		})
	],
	output: {
		path: path.resolve(`dist/apps/${appName}`),
	}
})
