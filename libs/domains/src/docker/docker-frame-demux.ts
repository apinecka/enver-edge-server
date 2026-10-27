import { Transform, TransformCallback } from 'stream'

const HEADER_SIZE = 8
const STREAM_TYPE_STDERR = 2

/** Demultiplexes Docker's exec/attach stdout+stderr framing (an 8-byte header - stream type byte,
 *  3 padding bytes, then a big-endian uint32 payload length - repeated per frame) into a single
 *  Transform whose readable side is stdout only, with stderr collected separately.
 *
 *  This exists instead of dockerode's own `modem.demuxStream` because that implementation attaches
 *  a raw `'data'` listener and calls `stdout.write()`/`stderr.write()` without ever checking the
 *  return value or waiting for `'drain'` - i.e. no backpressure. For a large pg_dump/pg_restore this
 *  lets the source stream run far ahead of a slower disk write, piling the whole output up in the
 *  writable's internal buffer until the process runs out of memory. Piping through a real Transform
 *  (`source.pipe(demux).pipe(dest)`) lets Node's built-in pipe() backpressure do its job instead:
 *  each stage pauses the one behind it when it can't keep up, so memory stays bounded regardless of
 *  dump size. */
export class DockerFrameDemux extends Transform {
	public readonly stderrChunks: Buffer[] = []

	private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
	private currentStreamType: number | null = null
	private currentPayloadRemaining = 0
	private rawPassthrough = false

	_transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
		if (this.rawPassthrough) {
			this.push(chunk)
			callback()
			return
		}

		let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
		this.pending = Buffer.alloc(0)

		while (buf.length > 0) {
			if (this.currentStreamType === null) {
				if (buf.length < HEADER_SIZE) { this.pending = buf; break }

				const streamType = buf.readUInt8(0)
				const payloadLength = buf.readUInt32BE(4)
				if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
					// Not actually multiplexed (e.g. a TTY-attached exec) - stop parsing and pass
					// everything through raw from here on, mirroring docker-modem's own fallback.
					this.rawPassthrough = true
					this.push(buf)
					callback()
					return
				}

				this.currentStreamType = streamType
				this.currentPayloadRemaining = payloadLength
				buf = buf.subarray(HEADER_SIZE)
				continue
			}

			const take = Math.min(this.currentPayloadRemaining, buf.length)
			const payload = buf.subarray(0, take)
			if (this.currentStreamType === STREAM_TYPE_STDERR) {
				this.stderrChunks.push(Buffer.from(payload))
			} else {
				this.push(payload)
			}
			buf = buf.subarray(take)
			this.currentPayloadRemaining -= take
			if (this.currentPayloadRemaining === 0) this.currentStreamType = null
		}
		callback()
	}
}
