import { runtimeFetch } from '../platform/runtimeUrl.ts'

/** One PCM request owns its decoder, playback nodes and cancellation. */
export class VoicePcmStream {
  private abort = new AbortController()
  private task: Promise<Blob> | null = null
  private rate = 48000
  private parts: ArrayBuffer[] = []
  private buffers: Float32Array[] = []
  private sources = new Set<AudioBufferSourceNode>()
  private context: AudioContext | null = null
  private destination: AudioNode | null = null
  private nextTime = 0
  private complete = false
  private cancelled = false
  private started = false
  private onStarted: (() => void) | null = null
  private resolvePlayback: (() => void) | null = null
  private rejectPlayback: ((error: unknown) => void) | null = null

  constructor(private url: string) {}

  get playing() { return this.sources.size > 0 }

  start(): Promise<Blob> {
    if (!this.task) {
      this.task = this.read()
      // A prefetched request may fail before it is selected for playback.
      void this.task.catch(() => {})
    }
    return this.task
  }

  private async read(): Promise<Blob> {
    const timer = setTimeout(() => this.abort.abort(), 180_000)
    try {
      const response = await runtimeFetch(this.url, { signal: this.abort.signal })
      if (!response.ok) {
        const value = await response.json().catch(() => null)
        throw new Error(value?.error || `语音请求失败 (${response.status})`)
      }
      this.rate = Number(response.headers.get('X-Audio-Sample-Rate'))
      if (response.headers.get('X-Audio-Format') !== 'pcm_s16le'
        || response.headers.get('X-Audio-Channels') !== '1'
        || !Number.isInteger(this.rate) || this.rate < 8000 || this.rate > 96000 || !response.body) {
        throw new Error('语音分片格式无效')
      }
      const reader = response.body.getReader()
      let tail: number | null = null, bytes = 0
      try {
        while (!this.cancelled) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value?.length) continue
          bytes += value.length
          if (bytes > 128 * 1024 * 1024) throw new Error('语音分片超过播放上限')
          this.parts.push(Uint8Array.from(value).buffer)
          const raw: Uint8Array<ArrayBuffer> = new Uint8Array(value.length + (tail === null ? 0 : 1))
          if (tail === null) raw.set(value)
          else { raw[0] = tail; raw.set(value, 1) }
          const length: number = raw.length - raw.length % 2
          tail = length === raw.length ? null : raw[length]!
          const view = new DataView(raw.buffer, 0, length)
          const samples = new Float32Array(length / 2)
          for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768
          if (samples.length) { this.buffers.push(samples); this.schedule() }
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      if (this.cancelled) throw new DOMException('aborted', 'AbortError')
      if (!bytes || tail !== null) throw new Error('语音分片不完整')
      this.complete = true
      this.finishIfIdle()
      const wave = this.wave(bytes)
      this.parts = []
      return wave
    } finally { clearTimeout(timer) }
  }

  play(context: AudioContext, destination: AudioNode, onStarted: () => void): Promise<void> {
    if (this.cancelled) return Promise.resolve()
    this.context = context; this.destination = destination; this.onStarted = onStarted
    const result = new Promise<void>((resolve, reject) => {
      this.resolvePlayback = resolve; this.rejectPlayback = reject
    })
    this.schedule()
    void this.start().then(() => this.finishIfIdle(), error => {
      this.rejectPlayback?.(error)
      this.cancel()
    })
    return result
  }

  private schedule() {
    if (!this.context || !this.destination || this.cancelled) return
    while (this.buffers.length) {
      const samples = this.buffers.shift()!
      const buffer = this.context.createBuffer(1, samples.length, this.rate)
      buffer.getChannelData(0).set(samples)
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.destination)
      source.onended = () => {
        source.disconnect(); this.sources.delete(source); this.finishIfIdle()
      }
      this.sources.add(source)
      this.nextTime = Math.max(this.nextTime, this.context.currentTime + .02)
      source.start(this.nextTime)
      this.nextTime += buffer.duration
      if (!this.started) { this.started = true; this.onStarted?.() }
    }
    this.finishIfIdle()
  }

  private finishIfIdle() {
    if (this.complete && !this.buffers.length && !this.sources.size) this.resolvePlayback?.()
  }

  cancel() {
    this.cancelled = true; this.abort.abort()
    for (const source of this.sources) {
      source.onended = null
      try { source.stop() } catch {}
      source.disconnect()
    }
    this.sources.clear(); this.buffers = []; this.parts = []
    this.resolvePlayback?.(); this.resolvePlayback = null; this.rejectPlayback = null
    this.context = null; this.destination = null; this.onStarted = null
  }

  private wave(bytes: number): Blob {
    const header = new ArrayBuffer(44), view = new DataView(header)
    const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
    tag(0, 'RIFF'); view.setUint32(4, bytes + 36, true); tag(8, 'WAVE'); tag(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, this.rate, true); view.setUint32(28, this.rate * 2, true)
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, bytes, true)
    return new Blob([header, ...this.parts], { type: 'audio/wav' })
  }
}
