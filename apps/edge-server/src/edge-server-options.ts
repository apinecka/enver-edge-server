import { DockerTypes } from '@enver/domains/docker/docker.types'
import { KubernetesTypes } from '@enver/domains/kubernetes/kubernetes.types'
import { EdgeProtocol } from '@enver/edge-protocol'

import { config } from './app.config'

/** Maps settings fetched from the enver API to DockerService's connection options - local env
 *  overrides win when set (dev/air-gapped escape hatch, see app.config.ts). */
export function toDockerOptions(settings: EdgeProtocol.Settings): DockerTypes.Options {
	return new DockerTypes.Options({
		socketPath: config.overrides.dockerSocketPath ?? settings.dockerSocketPath ?? undefined,
	})
}

/** Maps settings fetched from the enver API to KubernetesService's connection options - local env
 *  overrides win when set (dev/air-gapped escape hatch, see app.config.ts). */
export function toKubernetesOptions(settings: EdgeProtocol.Settings): KubernetesTypes.Options {
	return new KubernetesTypes.Options({
		apiUrl: settings.kubernetesApiUrl ?? undefined,
		token: settings.kubernetesToken ?? undefined,
		caCert: settings.kubernetesCaCert ?? undefined,
		skipTlsVerify: settings.kubernetesSkipTlsVerify,
		kubeconfigPath: config.overrides.kubeconfigPath,
		ingressClassName: settings.kubernetesIngressClassName ?? undefined,
		certIssuerName: settings.kubernetesCertIssuerName ?? undefined,
	})
}
