export namespace KubernetesTypes {
	export class Options {
		/** Reach the API server directly with a bearer token - used when settings are fetched from
		 *  the enver API rather than a local kubeconfig file (see kubernetes.service.ts reconfigure). */
		declare apiUrl?: string
		declare token?: string
		declare caCert?: string
		/** Without a CA certificate the API server's certificate is checked against the system CAs unless
		 *  this is true. Unset counts as false. */
		declare skipTlsVerify?: boolean
		/** Dev/air-gapped fallback - only consulted when apiUrl/token are unset. */
		declare kubeconfigPath?: string
		/** Unset leaves `ingressClassName` off the Ingress, so the cluster's default IngressClass serves it. */
		declare ingressClassName?: string
		declare certIssuerName?: string

		constructor(options: Options) {
			Object.assign(this, options)
		}
	}

	export const FIELD_MANAGER = 'enver-edge-server'
	export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by'
	export const MANAGED_BY_VALUE = 'enver'
	export const ENVIRONMENT_LABEL = 'enver.io/environment'
	export const ENVIRONMENT_SERVICE_LABEL = 'enver.io/environment-service'
	export const RESTARTED_AT_ANNOTATION = 'enver.io/restarted-at'
	export const ENV_CHECKSUM_ANNOTATION = 'enver.io/env-checksum'
	export const ISOLATION_POLICY_NAME = 'enver-isolate'
	/** Pod Security Standard enforced on every environment namespace. `baseline` forbids privileged
	 *  pods, host namespaces/ports and hostPath volumes, which is what lets one environment reach the
	 *  node and, through it, every other environment. */
	export const POD_SECURITY_LEVEL = 'baseline'
	export const VOLUME_CLAIM_SIZE = '1Gi'
	export const DELETE_WAIT_ATTEMPTS = 60
	export const DELETE_WAIT_INTERVAL_MS = 500
	/** The LoadBalancer Service and the pull/env Secrets append suffixes of up to 13 characters. */
	export const MAX_NAME_LENGTH = 50
	export const POD_PROBLEM_REASONS = new Set([
		'ImagePullBackOff',
		'ErrImagePull',
		'InvalidImageName',
		'CrashLoopBackOff',
		'CreateContainerConfigError',
		'CreateContainerError',
		'RunContainerError',
	])

	export type DeploymentPhase = 'running' | 'stopped' | 'pending' | 'unknown'

	export interface PortMapping {
		internalPort: number
		exposedPort: number
		/** Publishes the port on `exposedPort` through a LoadBalancer Service, for non-HTTP traffic. */
		loadBalancer?: boolean
	}

	export interface VolumeMapping {
		internalPath: string
		/** Name of the PersistentVolumeClaim in the environment namespace (sanitized to a DNS label). */
		externalPath: string
	}

	export interface IngressRule {
		host: string
		path: string
		internalPort: number
		tls: boolean
	}

	export interface RegistryAuth {
		username?: string
		password?: string
		registryUrl?: string
	}

	export interface ServiceConfig {
		namespace: string
		environmentServiceGuid: string
		name: string
		image: string
		ports: PortMapping[]
		volumes: VolumeMapping[]
		ingressRules: IngressRule[]
		replicas: number
		env?: Array<{ name: string; value: string }>
		command?: string[]
		cpuRequest?: string
		cpuLimit?: string
		memoryRequest?: string
		memoryLimit?: string
		imagePullSecretName?: string
		/** Rolls the pods even when nothing in the spec changed, like `kubectl rollout restart`. */
		restart?: boolean
	}

	export interface DetailedStatus {
		phase: DeploymentPhase
		image: string
		imageTag: string | null
		imageDigest: string | null
		uptimeSeconds: number | null
		desiredReplicas: number
		readyReplicas: number
		/** Why the pods don't come up (image pull, crash loop, scheduling, admission), if they don't. */
		problem: string | null
	}

	export class DeploymentNotFoundError extends Error { public code = 'deployment_not_found' }
	export class PodNotFoundError extends Error { public code = 'pod_not_found' }
	export class InvalidResourceNameError extends Error { public code = 'invalid_resource_name' }
}
