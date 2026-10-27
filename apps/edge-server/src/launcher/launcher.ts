import type { ChildProcess, SpawnOptions } from 'child_process'
import { join } from 'path'

import { SelfUpdateTypes } from '../self-update/self-update.types'
import { UpdateStateStore } from '../self-update/update-state.store'
import { LauncherTypes } from './launcher.types'

/** The stable process the service manager (systemd, launchd) runs. It starts the current agent
 *  version as a child, switches when the child asks for it and rolls a new version back when it
 *  dies or never confirms. It never updates itself, so it stays as the installer left it. */
export class Launcher {
	private child: ChildProcess | null = null
	private plan: SelfUpdateTypes.StartPlan | null = null
	private trialTimer: ReturnType<typeof setTimeout> | null = null
	private killTimer: ReturnType<typeof setTimeout> | null = null
	private stopping = false
	private restartAfterExit = false
	private exited = false

	constructor(
		private homeDir: string,
		private store: UpdateStateStore,
		private deps: LauncherTypes.Deps,
	) {}

	async start(): Promise<void> {
		const state = await this.store.read()
		const plan = this.store.planStart(state, (version) => this.isInstalled(version))
		if (JSON.stringify(plan.state) !== JSON.stringify(state)) await this.store.write(plan.state)
		this.spawn(plan)
	}

	/** SIGTERM/SIGINT from the service manager: pass it on and leave once the child is gone. */
	stop(signal: NodeJS.Signals): void {
		this.stopping = true
		if (!this.child) {
			this.deps.exit(0)
			return
		}
		this.child.kill(signal)
	}

	private spawn(plan: SelfUpdateTypes.StartPlan): void {
		const dir = plan.version ? this.store.versionDir(plan.version) : this.homeDir
		this.plan = plan
		this.exited = false
		this.deps.log(`Starting ${plan.version ? `version ${plan.version}` : 'the installed version'}${plan.trial ? ' (on trial)' : ''}`)
		const options: SpawnOptions = {
			stdio: 'inherit',
			env: { ...this.deps.env, [SelfUpdateTypes.ENV_HOME]: this.homeDir, [SelfUpdateTypes.ENV_LAUNCHER]: '1' },
		}
		const keylog = this.deps.env[SelfUpdateTypes.ENV_TLS_KEYLOG]
		if (keylog) this.deps.log(`Writing the agent's TLS session keys to ${keylog} - remove ${SelfUpdateTypes.ENV_TLS_KEYLOG} once you are done inspecting its traffic`)
		const args = [...(keylog ? [`--tls-keylog=${keylog}`] : []), join(dir, SelfUpdateTypes.ENTRYPOINT)]
		const child = this.deps.spawn(join(dir, SelfUpdateTypes.NODE_BIN), args, options)
		this.child = child
		if (plan.trial && plan.version) {
			const version = plan.version
			this.trialTimer = this.deps.setTimeout(() => void this.onTrialTimeout(version), SelfUpdateTypes.TRIAL_TIMEOUT_MS)
		}
		child.on('exit', (code) => void this.onExit(code))
		child.on('error', (err) => {
			this.deps.log(`Failed to start the agent: ${err.message}`)
			void this.onExit(1)
		})
	}

	private async onExit(code: number | null): Promise<void> {
		if (this.exited) return
		this.exited = true
		this.clearTimers()
		this.child = null
		if (this.stopping) {
			this.deps.exit(0)
			return
		}
		const plan = this.plan
		if (!plan) return

		if (this.restartAfterExit) {
			this.restartAfterExit = false
			await this.start()
			return
		}
		const state = await this.store.read()
		const decision = this.store.afterExit(state, plan, code)
		if (decision.state !== state) {
			this.deps.log(`Version ${plan.version} exited with ${code} before confirming, rolling back`)
			await this.store.write(decision.state)
		}
		if (decision.action === 'restart') await this.start()
		else this.deps.exit(code ?? 1)
	}

	private async onTrialTimeout(version: string): Promise<void> {
		this.trialTimer = null
		const state = await this.store.read()
		if (state.pending?.version !== version) return
		this.deps.log(`Version ${version} didn't confirm within ${SelfUpdateTypes.TRIAL_TIMEOUT_MS / 60_000} minutes, rolling back`)
		await this.store.write(this.store.rollback(state))
		this.restartAfterExit = true
		this.child?.kill('SIGTERM')
		this.killTimer = this.deps.setTimeout(() => this.child?.kill('SIGKILL'), SelfUpdateTypes.KILL_GRACE_MS)
	}

	private clearTimers(): void {
		if (this.trialTimer) this.deps.clearTimeout(this.trialTimer)
		if (this.killTimer) this.deps.clearTimeout(this.killTimer)
		this.trialTimer = null
		this.killTimer = null
	}

	private isInstalled(version: string): boolean {
		const dir = this.store.versionDir(version)
		return this.deps.exists(join(dir, SelfUpdateTypes.ENTRYPOINT)) && this.deps.exists(join(dir, SelfUpdateTypes.NODE_BIN))
	}
}
