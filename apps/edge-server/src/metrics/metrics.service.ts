import { EdgeProtocol } from '@enver/edge-protocol'
import { Injectable } from '@nestjs/common'
import { readFileSync, statfsSync } from 'fs'
import * as os from 'os'

@Injectable()
export class MetricsService {
	private lastCpuTimes = this.totalCpuTimes()

	/** Snapshots current host metrics. CPU usage is a delta since the previous call (a single
	 *  `os.cpus()` read is a cumulative counter since boot, not a point-in-time percentage) - the
	 *  first call after startup reports 0. */
	collect(): EdgeProtocol.MetricsReportPayload {
		const cpuPercent = this.sampleCpuPercent()
		const memoryTotalBytes = os.totalmem()
		const memoryUsedBytes = memoryTotalBytes - os.freemem()
		const { swapTotalBytes, swapUsedBytes } = this.readSwap()
		const { diskTotalBytes, diskUsedBytes } = this.readDisk()

		return {
			recordedAt: new Date().toISOString(),
			cpuPercent,
			memoryUsedBytes,
			memoryTotalBytes,
			swapUsedBytes,
			swapTotalBytes,
			diskUsedBytes,
			diskTotalBytes,
			uptimeSeconds: Math.floor(os.uptime()),
		}
	}

	private sampleCpuPercent(): number {
		const current = this.totalCpuTimes()
		const idleDelta = current.idle - this.lastCpuTimes.idle
		const totalDelta = current.total - this.lastCpuTimes.total
		this.lastCpuTimes = current
		if (totalDelta <= 0) return 0
		return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
	}

	private totalCpuTimes(): { idle: number; total: number } {
		let idle = 0
		let total = 0
		for (const cpu of os.cpus()) {
			idle += cpu.times.idle
			total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq
		}
		return { idle, total }
	}

	/** Linux-only - `os` has no cross-platform swap API, so macOS installs report 0. */
	private readSwap(): { swapTotalBytes: number; swapUsedBytes: number } {
		try {
			const meminfo = readFileSync('/proc/meminfo', 'utf8')
			const totalKb = Number(/SwapTotal:\s*(\d+)/.exec(meminfo)?.[1] ?? 0)
			const freeKb = Number(/SwapFree:\s*(\d+)/.exec(meminfo)?.[1] ?? 0)
			return { swapTotalBytes: totalKb * 1024, swapUsedBytes: (totalKb - freeKb) * 1024 }
		} catch {
			return { swapTotalBytes: 0, swapUsedBytes: 0 }
		}
	}

	private readDisk(): { diskTotalBytes: number; diskUsedBytes: number } {
		try {
			const stats = statfsSync('/')
			const diskTotalBytes = stats.blocks * stats.bsize
			const diskUsedBytes = diskTotalBytes - stats.bfree * stats.bsize
			return { diskTotalBytes, diskUsedBytes }
		} catch {
			return { diskTotalBytes: 0, diskUsedBytes: 0 }
		}
	}
}
