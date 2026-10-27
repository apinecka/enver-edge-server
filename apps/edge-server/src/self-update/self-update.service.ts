import { EdgeProtocol, Semver } from '@enver/edge-protocol'
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { createWriteStream, existsSync } from 'fs'
import { access, chmod, constants, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import * as openpgp from 'openpgp'
import { basename, dirname, join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { promisify } from 'util'

import { SelfUpdateTypes } from './self-update.types'
import { UpdateStateStore } from './update-state.store'

const execFileAsync = promisify(execFile)

/** Checks the api for a newer agent release, installs it next to the running one under
 *  `versions/<v>`, switches `versions/state.json` to it and exits for the launcher to restart into
 *  it. Everything happens inside the install directory the agent's own user owns: no root, no
 *  package manager, no service-manager changes. */
@Injectable()
export class SelfUpdateService implements OnApplicationBootstrap, OnApplicationShutdown {
	private logger = new Logger(SelfUpdateService.name)
	private store: UpdateStateStore | null
	private support = SelfUpdateTypes.Support.noLauncher
	private autoUpdate: boolean
	private state = SelfUpdateTypes.UpdateState.idle
	private lastCheckAt: string | null = null
	private lastError: string | null = null
	private rolledBackVersion: string | null = null
	private checking = false
	private connected = false
	private detected = false
	private checkTimer: ReturnType<typeof setTimeout> | null = null
	private confirmTimer: ReturnType<typeof setTimeout> | null = null
	private listener: ((status: EdgeProtocol.AgentStatusMessage['payload']) => void) | null = null
	private restartHandler: (() => Promise<void>) | null = null

	constructor(@Inject(SelfUpdateTypes.OPTIONS) private options: SelfUpdateTypes.Options) {
		this.autoUpdate = options.autoUpdate
		this.store = options.homeDir ? new UpdateStateStore(options.homeDir, { readFile, writeFile, rename }) : null
	}

	/** The websocket may already be up by now (bootstrap hooks run side by side), so the detected
	 *  support is reported and a pending confirmation scheduled from here too. */
	async onApplicationBootstrap(): Promise<void> {
		this.support = await this.detectSupport()
		this.detected = true
		if (this.support !== SelfUpdateTypes.Support.supported) {
			this.logger.log(`Self-update unavailable (${this.support}), running ${this.options.version}`)
			this.emit()
			return
		}
		const state = await this.requireStore().read()
		const lastFailed = state.failed.at(-1)
		if (lastFailed && Semver.isNewer(lastFailed, this.options.version)) this.rolledBackVersion = lastFailed
		this.emit()
		if (this.connected) this.scheduleConfirm()
		this.scheduleCheck(this.randomBetween(SelfUpdateTypes.FIRST_CHECK_DELAY_MIN_MS, SelfUpdateTypes.FIRST_CHECK_DELAY_MAX_MS))
	}

	onApplicationShutdown(): void {
		if (this.checkTimer) clearTimeout(this.checkTimer)
		if (this.confirmTimer) clearTimeout(this.confirmTimer)
	}

	onStatusChange(listener: (status: EdgeProtocol.AgentStatusMessage['payload']) => void): void {
		this.listener = listener
	}

	/** Closes the app and exits with `RESTART_EXIT_CODE`; set by main.ts, which owns the app. */
	setRestartHandler(handler: () => Promise<void>): void {
		this.restartHandler = handler
	}

	setAutoUpdate(enabled: boolean): void {
		this.autoUpdate = enabled
	}

	status(): EdgeProtocol.AgentStatusMessage['payload'] {
		return {
			version: this.options.version,
			platform: `${this.options.platform}-${this.options.arch}`,
			selfUpdate: this.support,
			state: this.state,
			lastCheckAt: this.lastCheckAt,
			lastError: this.lastError,
			rolledBackVersion: this.rolledBackVersion,
		}
	}

	/** A version on trial confirms itself once its api connection has stayed up a while. */
	/** Reports the status on every (re)connect, once support is known. */
	onConnected(): void {
		this.connected = true
		this.emit()
		this.scheduleConfirm()
	}

	onDisconnected(): void {
		this.connected = false
		if (this.confirmTimer) clearTimeout(this.confirmTimer)
		this.confirmTimer = null
	}

	/** `force` (the "Update now" job) ignores the auto-update setting and retries a version that was rolled back. */
	async checkNow(force: boolean): Promise<void> {
		if (this.checking) return
		if (this.support !== SelfUpdateTypes.Support.supported) {
			if (force) this.logger.warn(`Update requested, but self-update is unavailable (${this.support})`)
			return
		}
		this.checking = true
		this.setState(SelfUpdateTypes.UpdateState.checking)
		try {
			const release = await this.fetchRelease()
			this.lastCheckAt = new Date().toISOString()
			if (!release || !Semver.isNewer(release.version, this.options.version)) {
				this.lastError = null
				this.setState(SelfUpdateTypes.UpdateState.idle)
				return
			}
			const store = this.requireStore()
			const state = await store.read()
			if (!force && state.failed.includes(release.version)) {
				this.setState(SelfUpdateTypes.UpdateState.idle)
				return
			}
			if (!store.isVersionName(release.version)) throw new SelfUpdateTypes.PackageError(`Invalid release version ${release.version}`)
			const pkg = this.pickPackage(release)

			this.logger.log(`Updating from ${this.options.version} to ${release.version}`)
			this.setState(SelfUpdateTypes.UpdateState.downloading)
			await this.install(release.version, pkg)

			await store.write(store.beginTrial(await store.read(), release.version, this.runningVersionDir()))
			this.lastError = null
			this.setState(SelfUpdateTypes.UpdateState.restarting)
			this.logger.log(`Version ${release.version} installed, restarting into it`)
			await this.requestRestart()
		} catch (err) {
			this.lastError = err instanceof Error ? err.message : 'Unknown error'
			this.logger.error({ err }, 'Self-update failed')
			await this.cleanStaging()
			this.setState(SelfUpdateTypes.UpdateState.idle)
		} finally {
			this.checking = false
		}
	}

	private scheduleConfirm(): void {
		if (this.support !== SelfUpdateTypes.Support.supported) return
		if (this.confirmTimer) clearTimeout(this.confirmTimer)
		this.confirmTimer = setTimeout(() => void this.confirmIfPending(), SelfUpdateTypes.CONFIRM_AFTER_MS)
	}

	private async confirmIfPending(): Promise<void> {
		this.confirmTimer = null
		const running = this.runningVersionDir()
		if (!running) return
		try {
			const store = this.requireStore()
			const state = await store.read()
			if (state.pending?.version !== running) return
			const confirmed = store.confirm(state, running)
			await store.write(confirmed)
			this.logger.log(`Version ${running} confirmed`)
			this.rolledBackVersion = null
			await this.prune(confirmed)
			this.emit()
		} catch (err) {
			this.logger.error({ err }, 'Failed to confirm the running version')
		}
	}

	private async install(version: string, pkg: EdgeProtocol.AgentReleasePackage): Promise<void> {
		const store = this.requireStore()
		const staging = join(store.versionsDir, SelfUpdateTypes.STAGING_DIR)
		await rm(staging, { recursive: true, force: true })
		await mkdir(staging, { recursive: true })

		const file = join(staging, 'package')
		const sha256 = await this.download(pkg.downloadPath, file, pkg.sizeBytes)
		if (sha256 !== pkg.sha256.toLowerCase()) throw new SelfUpdateTypes.VerificationError('SHA-256 of the downloaded package does not match the release')
		await this.verifySignature(file, pkg)

		const extracted = await this.extract(file, staging)
		await this.validate(extracted, version)

		const target = store.versionDir(version)
		await rm(target, { recursive: true, force: true })
		await rename(extracted, target)
		await rm(staging, { recursive: true, force: true })
	}

	/** Streams to disk and hashes on the way, refusing anything larger than the release announced. */
	private async download(path: string, dest: string, expectedSize: number): Promise<string> {
		const res = await fetch(`${this.options.apiUrl}${path}`)
		if (!res.ok || !res.body) throw new SelfUpdateTypes.PackageError(`Download failed: HTTP ${res.status}`)
		const hash = createHash('sha256')
		let size = 0
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				size += chunk.length
				if (size > expectedSize) {
					callback(new SelfUpdateTypes.VerificationError('Downloaded package is larger than the release announced'))
					return
				}
				hash.update(chunk)
				callback(null, chunk)
			},
		})
		await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(dest))
		if (size !== expectedSize) throw new SelfUpdateTypes.VerificationError('Downloaded package is smaller than the release announced')
		return hash.digest('hex')
	}

	/** A release build carries the release key, so every update must carry a detached signature by it;
	 *  removing a file can't turn that off. A build without the key (local, or from before the key was
	 *  baked in) still honours a key its installer pinned. Verified in-process, so a host without
	 *  GnuPG (stock macOS) is held to it too. */
	private async verifySignature(file: string, pkg: EdgeProtocol.AgentReleasePackage): Promise<void> {
		const key = await this.signingKey()
		if (!key) return
		if (!pkg.signatureAvailable) throw new SelfUpdateTypes.VerificationError('The release is not signed, but this agent requires a signature')

		const res = await fetch(`${this.options.apiUrl}${pkg.signaturePath}`)
		if (!res.ok) throw new SelfUpdateTypes.VerificationError(`Signature download failed: HTTP ${res.status}`)
		const armoredSignature = await res.text()

		try {
			const verificationKeys = await openpgp.readKeys({ binaryKeys: key })
			await openpgp.verify({
				message: await openpgp.createMessage({ binary: await readFile(file) }),
				signature: await openpgp.readSignature({ armoredSignature }),
				verificationKeys,
				format: 'binary',
				expectSigned: true,
			})
		} catch {
			throw new SelfUpdateTypes.VerificationError('The package signature does not verify against the pinned key')
		}
	}

	private async signingKey(): Promise<Uint8Array | null> {
		if (this.options.signingKey) return this.options.signingKey
		const keyFile = join(this.options.ownDir, SelfUpdateTypes.SIGNING_KEY_FILE)
		return existsSync(keyFile) ? await readFile(keyFile) : null
	}

	/** Unpacks the very installer a fresh install uses: `dpkg-deb -x` needs no root, and the macOS
	 *  bundle is a plain tarball with one Node.js runtime per architecture. */
	private async extract(file: string, staging: string): Promise<string> {
		const out = join(staging, 'extracted')
		await mkdir(out, { recursive: true })
		if (this.options.platform === 'linux') {
			await this.run('dpkg-deb', ['-x', file, out])
			return join(out, 'opt', 'enver', 'edge-server')
		}
		await this.run('tar', ['-xzf', file, '-C', out])
		const bundle = join(out, 'enver-edge-server')
		const app = join(bundle, 'app')
		const node = join(app, SelfUpdateTypes.NODE_BIN)
		await mkdir(dirname(node), { recursive: true })
		await copyFile(join(bundle, 'node', `darwin-${this.options.arch}`, 'bin', 'node'), node)
		await chmod(node, 0o755)
		return app
	}

	/** The package must be the release it claims to be, and its Node.js must run on this machine. */
	private async validate(dir: string, version: string): Promise<void> {
		let packaged: string
		try {
			packaged = (await readFile(join(dir, SelfUpdateTypes.VERSION_FILE), 'utf8')).trim()
		} catch {
			throw new SelfUpdateTypes.PackageError('The package has no VERSION file')
		}
		if (packaged !== version) throw new SelfUpdateTypes.PackageError(`The package is version ${packaged}, not ${version}`)
		if (!existsSync(join(dir, SelfUpdateTypes.ENTRYPOINT))) throw new SelfUpdateTypes.PackageError('The package has no agent entrypoint')
		await this.run(join(dir, SelfUpdateTypes.NODE_BIN), ['--version'])
	}

	private pickPackage(release: EdgeProtocol.AgentRelease): EdgeProtocol.AgentReleasePackage {
		if (this.options.platform === 'darwin' && release.macos) return release.macos
		if (this.options.platform === 'linux' && release.linux && release.linux.arch === this.debianArch()) return release.linux
		throw new SelfUpdateTypes.NoPackageError(`No package of ${release.version} for ${this.options.platform}-${this.options.arch}`)
	}

	private debianArch(): string {
		if (this.options.arch === 'x64') return 'amd64'
		return this.options.arch
	}

	private async fetchRelease(): Promise<EdgeProtocol.AgentRelease | null> {
		const res = await fetch(`${this.options.apiUrl}/v1/edge-servers/installer/release`)
		if (res.status === 404) return null
		if (!res.ok) throw new Error(`Release check failed: HTTP ${res.status}`)
		return await res.json() as EdgeProtocol.AgentRelease
	}

	private async prune(state: SelfUpdateTypes.State): Promise<void> {
		const store = this.requireStore()
		const keep = store.keep(state)
		for (const entry of await readdir(store.versionsDir)) {
			if (keep.has(entry) || !store.isVersionName(entry)) continue
			await rm(join(store.versionsDir, entry), { recursive: true, force: true })
		}
		await this.cleanStaging()
	}

	private async cleanStaging(): Promise<void> {
		if (!this.store) return
		await rm(join(this.store.versionsDir, SelfUpdateTypes.STAGING_DIR), { recursive: true, force: true }).catch(() => undefined)
	}

	private async detectSupport(): Promise<SelfUpdateTypes.Support> {
		if (!this.store) return SelfUpdateTypes.Support.noLauncher
		try {
			await mkdir(this.store.versionsDir, { recursive: true })
			await access(this.store.versionsDir, constants.W_OK)
			return SelfUpdateTypes.Support.supported
		} catch {
			return SelfUpdateTypes.Support.notWritable
		}
	}

	/** Null when running from the installed base rather than from `versions/<v>`. */
	private runningVersionDir(): string | null {
		if (!this.store) return null
		return dirname(this.options.ownDir) === this.store.versionsDir ? basename(this.options.ownDir) : null
	}

	private scheduleCheck(delayMs: number): void {
		if (this.checkTimer) clearTimeout(this.checkTimer)
		this.checkTimer = setTimeout(() => void this.scheduledCheck(), delayMs)
	}

	private async scheduledCheck(): Promise<void> {
		if (this.autoUpdate) await this.checkNow(false)
		this.scheduleCheck(SelfUpdateTypes.CHECK_INTERVAL_MS + this.randomBetween(-SelfUpdateTypes.CHECK_JITTER_MS, SelfUpdateTypes.CHECK_JITTER_MS))
	}

	private async requestRestart(): Promise<void> {
		if (!this.restartHandler) throw new Error('No restart handler registered')
		await this.restartHandler()
	}

	private async run(command: string, args: string[]): Promise<void> {
		try {
			await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 })
		} catch (err) {
			throw new SelfUpdateTypes.PackageError(`${basename(command)} failed: ${(err as Error).message}`)
		}
	}

	private requireStore(): UpdateStateStore {
		if (!this.store) throw new Error('Self-update is not available without the launcher')
		return this.store
	}

	private setState(state: SelfUpdateTypes.UpdateState): void {
		this.state = state
		this.emit()
	}

	private emit(): void {
		if (!this.detected) return
		this.listener?.(this.status())
	}

	private randomBetween(min: number, max: number): number {
		return min + Math.floor(Math.random() * (max - min))
	}
}
