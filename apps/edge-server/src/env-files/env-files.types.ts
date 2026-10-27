export namespace EnvFilesTypes {
	export type Variable = { name: string; value: string }

	/** Messages name the file and never its contents: they reach Enver as the service's error. */
	export class InvalidEnvFileNameError extends Error {
		public code = 'invalid_env_file_name'
		constructor(name: string) { super(`Env file "${name}" is not a valid name inside the env-files directory`) }
	}

	export class EnvFileNotFoundError extends Error {
		public code = 'env_file_not_found'
		constructor(name: string, dir: string) { super(`Env file "${name}" not found in ${dir} on the edge server`) }
	}

	export class EnvFileOutsideDirError extends Error {
		public code = 'env_file_outside_dir'
		constructor(name: string, dir: string) { super(`Env file "${name}" resolves outside ${dir} on the edge server`) }
	}

	export class EnvFileTooLargeError extends Error {
		public code = 'env_file_too_large'
		constructor(name: string, maxBytes: number) { super(`Env file "${name}" is larger than ${maxBytes} bytes`) }
	}

	export class EnvFileUnreadableError extends Error {
		public code = 'env_file_unreadable'
		constructor(name: string, reason: string) { super(`Env file "${name}" can't be read by the edge server: ${reason}`) }
	}
}
