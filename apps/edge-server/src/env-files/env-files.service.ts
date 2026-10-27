import { EdgeProtocol } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { readFile, realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import { parseEnv } from 'util'

import { config } from '../app.config'
import { EnvFilesTypes } from './env-files.types'

/** Reads a service's env file on this host, so its values go straight into the container and
 *  never through Enver. Only files inside `config.envFiles.dir` are readable - otherwise anyone
 *  who may edit a service in Enver could hand any file of this host (a kubeconfig, say) to a pod. */
@Injectable()
export class EnvFilesService {
	async read(name: string): Promise<EnvFilesTypes.Variable[]> {
		if (name.length > EdgeProtocol.ENV_FILE_MAX_LENGTH || !EdgeProtocol.ENV_FILE_REGEX.test(name)) {
			throw new EnvFilesTypes.InvalidEnvFileNameError(name)
		}
		const { dir: configuredDir, maxBytes } = config.envFiles
		const dir = await this.resolve(configuredDir, () => new EnvFilesTypes.EnvFileNotFoundError(name, configuredDir), name)
		// Resolving symlinks before the check keeps a link inside the directory from pointing out of it.
		const file = await this.resolve(join(dir, name), () => new EnvFilesTypes.EnvFileNotFoundError(name, configuredDir), name)
		if (!file.startsWith(dir + sep)) throw new EnvFilesTypes.EnvFileOutsideDirError(name, configuredDir)

		const info = await stat(file)
		if (!info.isFile()) throw new EnvFilesTypes.EnvFileNotFoundError(name, configuredDir)
		if (info.size > maxBytes) throw new EnvFilesTypes.EnvFileTooLargeError(name, maxBytes)

		let content: string
		try {
			content = await readFile(file, 'utf8')
		} catch (err) {
			throw new EnvFilesTypes.EnvFileUnreadableError(name, this.errorCode(err))
		}
		return Object.entries(parseEnv(content)).map(([key, value]) => ({ name: key, value: value ?? '' }))
	}

	/** The file's values win over the ones Enver sent, so the server's operator has the last word. */
	merge(env: EnvFilesTypes.Variable[] | undefined, fileVariables: EnvFilesTypes.Variable[]): EnvFilesTypes.Variable[] {
		const fileNames = new Set(fileVariables.map((v) => v.name))
		return [...(env ?? []).filter((v) => !fileNames.has(v.name)), ...fileVariables]
	}

	private async resolve(path: string, notFound: () => Error, name: string): Promise<string> {
		try {
			return await realpath(path)
		} catch (err) {
			if (this.errorCode(err) === 'ENOENT') throw notFound()
			throw new EnvFilesTypes.EnvFileUnreadableError(name, this.errorCode(err))
		}
	}

	private errorCode(err: unknown): string {
		return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
			? (err as { code: string }).code
			: 'unknown error'
	}
}
