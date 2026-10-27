export namespace HostDirsTypes {
	/** Empty: nothing may be mounted or backed up. An api that sends no list counts as empty. */
	export interface Dirs {
		volumesDirs: string[]
		backupsDirs: string[]
	}

	export enum Kind {
		volumes = 'volumes',
		backups = 'backups',
	}

	/** Its message is shown with the service in Enver, so it names the setting to change. */
	export class PathRefusedError extends Error { public code = 'host_path_refused' }
}
