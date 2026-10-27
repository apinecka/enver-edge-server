export namespace BackupsTypes {
	export const FILE_PREFIX = 'backup-'
	export const FILE_SUFFIX = '.dump'
	/** `backup-<ISO timestamp with : and . replaced by ->.dump`, as `handleCreate` names them. */
	export const FILE_NAME_REGEX = /^backup-[0-9A-Za-z-]{1,64}\.dump$/
}
