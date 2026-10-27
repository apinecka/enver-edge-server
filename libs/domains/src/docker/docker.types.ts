export namespace DockerTypes {
	/** Set on every container Enver creates; it acts only on containers that carry it (or, created
	 *  before the label existed, sit on one of its `enver-<environmentGuid>` networks), so a container
	 *  name from a job can never stop, read or exec into another workload on the host. */
	export const MANAGED_LABEL = 'io.enver.managed'
	export const MANAGED_NETWORK_PREFIX = 'enver-'

	export class Options {
		declare socketPath?: string
		declare host?: string
		declare port?: number

		constructor(options: Options) {
			Object.assign(this, options)
		}
	}

	export interface PortMapping {
		internalPort: number
		exposedPort: number
	}

	export interface VolumeMapping {
		internalPath: string
		externalPath: string
	}

	export interface BindMounts {
		containerName: string
		sources: string[]
	}

	export interface RegistryAuth {
		username?: string
		password?: string
		serveraddress?: string
	}

	export interface ServiceConfig {
		name: string
		image: string
		ports: PortMapping[]
		volumes: VolumeMapping[]
		env?: Array<{ name: string; value: string }>
		command?: string[]
		restartPolicy?: 'no' | 'always' | 'on-failure' | 'unless-stopped'
		networkName?: string
		/** Host address the ports are published on; all interfaces when unset. */
		portsHostIp?: string
	}

	export interface ServiceStatus {
		state: string
		startedAt?: string
		exitCode?: number
	}

	export interface DetailedStatus {
		state: string
		image: string
		imageTag: string | null
		imageDigest: string
		uptimeSeconds: number | null
	}

	export class ContainerNotFoundError extends Error { public code = 'container_not_found' }
	export class ContainerRemovalInProgressError extends Error { public code = 'container_removal_in_progress' }
	export class ContainerNotManagedError extends Error {
		public code = 'container_not_managed'
		constructor(name: string) {
			super(`A container named ${name} exists on this host and is not managed by Enver - rename one of them`)
		}
	}

	/** A command exec'd inside a container exited non-zero - `stderr` is the command's own error
	 *  output (e.g. pg_dump/pg_restore's message), not a Docker-level failure. */
	export class ExecFailedError extends Error {
		public code = 'exec_failed'
		constructor(public exitCode: number, public stderr: string) {
			super(`Command exited with code ${exitCode}: ${stderr || '(no stderr output)'}`)
		}
	}
}
