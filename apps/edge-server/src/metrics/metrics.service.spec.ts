import { readFileSync, statfsSync } from 'fs'
import * as os from 'os'

import { MetricsService } from './metrics.service'

jest.mock('fs', () => ({
	readFileSync: jest.fn(),
	statfsSync: jest.fn(),
}))

jest.mock('os')

const mockReadFileSync = readFileSync as jest.Mock
const mockStatfsSync = statfsSync as jest.Mock
const mockOs = os as jest.Mocked<typeof os>

function makeCpu(idle: number, user: number): os.CpuInfo {
	return { model: 'x', speed: 1, times: { idle, user, nice: 0, sys: 0, irq: 0 } }
}

describe('MetricsService', () => {
	let service: MetricsService

	beforeEach(() => {
		jest.clearAllMocks()
		mockOs.totalmem.mockReturnValue(16_000_000_000)
		mockOs.freemem.mockReturnValue(4_000_000_000)
		mockOs.uptime.mockReturnValue(12345.6)
		mockOs.cpus.mockReturnValue([makeCpu(1000, 0)])
		mockReadFileSync.mockReturnValue('MemTotal:       16000000 kB\nSwapTotal:       2000000 kB\nSwapFree:         500000 kB\n')
		mockStatfsSync.mockReturnValue({ bsize: 4096, blocks: 1_000_000, bfree: 400_000, bavail: 400_000 } as never)
		service = new MetricsService()
	})

	it('reports 0% cpu on the very first collection (no prior sample to diff against)', () => {
		const result = service.collect()
		expect(result.cpuPercent).toBe(0)
	})

	it('computes cpu percent as a delta since the previous collection', () => {
		service.collect() // seeds the baseline
		mockOs.cpus.mockReturnValue([makeCpu(1000 + 50, 0 + 50)]) // 100 total ticks elapsed, half idle
		const result = service.collect()
		expect(result.cpuPercent).toBe(50)
	})

	it('reports memory used as total minus free', () => {
		const result = service.collect()
		expect(result.memoryTotalBytes).toBe(16_000_000_000)
		expect(result.memoryUsedBytes).toBe(12_000_000_000)
	})

	it('parses swap totals from /proc/meminfo, converting kB to bytes', () => {
		const result = service.collect()
		expect(result.swapTotalBytes).toBe(2_000_000 * 1024)
		expect(result.swapUsedBytes).toBe((2_000_000 - 500_000) * 1024)
	})

	it('falls back to zero swap when /proc/meminfo is unreadable (non-Linux)', () => {
		mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT') })
		const result = service.collect()
		expect(result.swapTotalBytes).toBe(0)
		expect(result.swapUsedBytes).toBe(0)
	})

	it('computes disk usage from statfs block counts', () => {
		const result = service.collect()
		expect(result.diskTotalBytes).toBe(4096 * 1_000_000)
		expect(result.diskUsedBytes).toBe(4096 * (1_000_000 - 400_000))
	})

	it('falls back to zero disk usage when statfs fails', () => {
		mockStatfsSync.mockImplementation(() => { throw new Error('EPERM') })
		const result = service.collect()
		expect(result.diskTotalBytes).toBe(0)
		expect(result.diskUsedBytes).toBe(0)
	})

	it('reports rounded-down OS uptime in seconds', () => {
		const result = service.collect()
		expect(result.uptimeSeconds).toBe(12345)
	})

	it('stamps recordedAt as a valid ISO timestamp', () => {
		const result = service.collect()
		expect(new Date(result.recordedAt).toISOString()).toBe(result.recordedAt)
	})
})
