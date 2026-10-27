import type { ChildProcess, SpawnOptions } from 'child_process'

export namespace LauncherTypes {
	export interface Deps {
		spawn(command: string, args: string[], options: SpawnOptions): ChildProcess
		exists(path: string): boolean
		exit(code: number): void
		log(message: string): void
		setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
		clearTimeout(timer: ReturnType<typeof setTimeout>): void
		env: NodeJS.ProcessEnv
	}
}
