export namespace JobProcessorTypes {
	export type ActionError = { message: string; at: number }

	export type ImageRef = { ref: string; id: string }

	export type Backoff = { failures: number; nextAttemptAt: number }

	/** Delays before the reconcile loop retries a service whose last action failed: a pull that keeps
	 *  failing every few seconds gets the host's IP rate-limited by the registry (Docker Hub's 429). */
	export const RECONCILE_BACKOFF_BASE_MS = 30_000
	export const RECONCILE_BACKOFF_MAX_MS = 15 * 60_000

	/** A failed action's message stops being reported after this long, or once the container started
	 *  after the failure - whichever comes first. A failing retry records it again. */
	export const ACTION_ERROR_TTL_MS = 60 * 60_000
}
