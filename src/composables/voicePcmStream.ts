import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { createPcm16MonoWavHeader } from '@/utils/pcmWav'

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
  private stopReason: Error | null = null
  private playbackTimer: ReturnType<typeof setTimeout> | null = null
  private started = false
  private onStarted: (() => void) | null = null
  private resolvePlayback: (() => void) | null = null
  private rejectPlayback: ((error: unknown) => void) | null = null
  private onContextStateChange = () => {
    if (this.context?.state === 'closed') { this.fail(new Error('声音播放已中断，请点击重播。')); return }
    if (this.context?.state === 'running') {
      try { this.schedule() } catch (error) { this.fail(error) }
    }
  }

  constructor(private url: string) {}

  get playing() { return this.sources.size > 0 }

  start(): Promise<Blob> {
    if (!this.task) {
      this.task = this.stopReason ? Promise.reject(this.stopReason) : this.read()
      // A prefetched request may fail before it is selected for playback.
      void this.task.catch(() => {})
    }
    return this.task
  }

  private async read(): Promise<Blob> {
    const timer = setTimeout(() => this.fail(new Error('语音生成超时，请点击重播再试。')), 180_000)
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
      if (this.stopReason) throw this.stopReason
      if (!bytes || tail !== null) throw new Error('语音分片不完整')
      const wave = this.wave(bytes)
      this.parts = []
      this.complete = true
      this.finishIfIdle()
      return wave
    } catch (error) {
      this.fail(error)
      throw this.stopReason
    } finally { clearTimeout(timer) }
  }

  play(context: AudioContext, destination: AudioNode, onStarted: () => void): Promise<void> {
    if (this.cancelled) return this.stopReason?.name === 'AbortError' ? Promise.resolve() : Promise.reject(this.stopReason)
    this.context = context; this.destination = destination; this.onStarted = onStarted
    context.addEventListener('statechange', this.onContextStateChange)
    const result = new Promise<void>((resolve, reject) => {
      this.resolvePlayback = resolve; this.rejectPlayback = reject
    })
    // resume() may remain pending under autoplay restrictions. The playback
    // deadline also bounds a suspended/interrupted context after download ends.
    this.playbackTimer = setTimeout(() => this.fail(new Error('语音播放超时，请点击重播再试。')), 270_000)
    const begin = () => {
      if (this.cancelled) return
      if (context.state !== 'running') { this.fail(new Error('浏览器尚未启用声音，请点击重播。')); return }
      try { this.schedule() } catch (error) { this.fail(error); return }
      void this.start().then(() => this.finishIfIdle(), error => this.fail(error))
    }
    if (context.state === 'running') begin()
    else void context.resume().then(begin, () => this.fail(new Error('浏览器阻止了声音播放，请点击重播。')))
    return result
  }

  private schedule() {
    if (!this.context || !this.destination || this.context.state !== 'running' || this.cancelled) return
    while (this.buffers.length) {
      const samples = this.buffers.shift()!
      const buffer = this.context.createBuffer(1, samples.length, this.rate)
      buffer.getChannelData(0).set(samples)
      const source = this.context.createBufferSource()
      this.sources.add(source)
      source.buffer = buffer
      source.connect(this.destination)
      source.onended = () => {
        source.disconnect(); this.sources.delete(source); this.finishIfIdle()
      }
      this.nextTime = Math.max(this.nextTime, this.context.currentTime + .02)
      source.start(this.nextTime)
      this.nextTime += buffer.duration
      if (!this.started) { this.started = true; this.onStarted?.() }
    }
    this.finishIfIdle()
  }

  private finishIfIdle() {
    if (this.complete && !this.buffers.length && !this.sources.size) this.finishPlayback()
  }

  private finishPlayback() {
    if (this.playbackTimer !== null) clearTimeout(this.playbackTimer)
    this.playbackTimer = null
    if (this.stopReason && this.stopReason.name !== 'AbortError') this.rejectPlayback?.(this.stopReason)
    else this.resolvePlayback?.()
    this.resolvePlayback = null; this.rejectPlayback = null
    this.context?.removeEventListener('statechange', this.onContextStateChange)
    this.context = null; this.destination = null; this.onStarted = null
  }

  private fail(error: unknown) {
    this.stopReason ??= error instanceof Error ? error : new Error(String(error))
    this.cancel()
  }

  cancel() {
    this.stopReason ??= new DOMException('aborted', 'AbortError')
    this.cancelled = true; this.abort.abort()
    for (const source of this.sources) {
      source.onended = null
      try { source.stop() } catch {}
      source.disconnect()
    }
    this.sources.clear(); this.buffers = []; this.parts = []
    this.finishPlayback()
  }

  private wave(bytes: number): Blob {
    return new Blob([createPcm16MonoWavHeader(bytes, this.rate), ...this.parts], { type: 'audio/wav' })
  }
}
