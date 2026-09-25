import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVoiceInput } from './useVoiceInput'
import { recognizeWithAsr, type AsrResult } from '@/utils/voiceApi'
import type { SpeechInputConfig } from '@/utils/speechInputConfig'

vi.mock('@/utils/voiceApi', () => ({
  resampleTo16k: (samples: Float32Array) => samples,
  encodeWav16k: () => new Uint8Array([1, 2]), recognizeWithAsr: vi.fn(),
}))
vi.mock('@/utils/vadSegmenter', async importOriginal => {
  const original = await importOriginal<typeof import('@/utils/vadSegmenter')>()
  return { ...original, createVadSegmenter: () => ({ push() {}, takeSegments: () => [new Float32Array([0.5])] }) }
})
const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []
const processors: Array<{ onaudioprocess: ((event: AudioProcessingEvent) => void) | null; disconnect: ReturnType<typeof vi.fn> }> = []
class AudioContextFixture {
  state = 'running'
  sampleRate = 16000
  destination = {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor() {
    const processor = { connect() {}, disconnect: vi.fn(), onaudioprocess: null as ((event: AudioProcessingEvent) => void) | null }
    processors.push(processor)
    return processor
  }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 0 } } }
  close() { this.state = 'closed'; return Promise.resolve() }
}
function deferred() {
  let resolve!: (result: AsrResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<AsrResult>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.stubGlobal('AudioContext', AudioContextFixture)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => {
    const track = { stop: vi.fn() }; tracks.push(track)
    return { getTracks: () => [track] }
  }) } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); tracks.length = 0; processors.length = 0 })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('voice session ownership', () => {
  for (const mode of ['manual', 'auto'] as const) for (const outcome of ['resolve', 'reject'] as const) {
    it(`canceled ${outcome} cannot change a new ${mode} session`, async () => {
      const old = deferred()
      vi.mocked(recognizeWithAsr).mockReturnValueOnce(old.promise)
      const onText = vi.fn(), onError = vi.fn()
      const voice = useVoiceInput({ config: () => ({} as SpeechInputConfig), onText, onError })
      await voice.start(); voice.stop()
      const signal = vi.mocked(recognizeWithAsr).mock.calls[0][2]!
      voice.cancel(); await voice.start(mode)
      expect(signal.aborted).toBe(true)
      if (outcome === 'resolve') old.resolve({ text: 'old transcript', latencyMs: 1 })
      else old.reject(new Error('old failure'))
      await settle()
      expect(voice.state.value).toBe('capturing')
      expect(onText).not.toHaveBeenCalled()
      expect(onError).not.toHaveBeenCalled()
      voice.release()
      expect(tracks.every(track => track.stop.mock.calls.length > 0)).toBe(true)
    })
  }
  it('still delivers the new session once and stops all tracks', async () => {
    const old = deferred(), fresh = deferred()
    vi.mocked(recognizeWithAsr).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const onText = vi.fn()
    const voice = useVoiceInput({ config: () => ({} as SpeechInputConfig), onText })
    await voice.start(); voice.stop(); voice.cancel()
    await voice.start(); voice.stop()
    old.resolve({ text: 'discarded', latencyMs: 1 })
    fresh.resolve({ text: 'new transcript', latencyMs: 1 })
    await settle()
    expect(onText).toHaveBeenCalledExactlyOnceWith('new transcript', 'manual')
    expect(voice.state.value).toBe('idle')
    voice.release()
  })
  it('release prevents late success and late error callbacks', async () => {
    const pending = deferred()
    vi.mocked(recognizeWithAsr).mockReturnValueOnce(pending.promise)
    const onText = vi.fn(), onError = vi.fn()
    const voice = useVoiceInput({ config: () => ({} as SpeechInputConfig), onText, onError })
    await voice.start(); voice.stop(); voice.release()
    pending.resolve({ text: 'disposed', latencyMs: 1 }); await settle()
    expect(onText).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(voice.state.value).toBe('idle')
  })
  it('reports document policy denial without asking the user to grant browser permission again', async () => {
    vi.stubGlobal('document', { featurePolicy: { allowsFeature: () => false } })
    const voice = useVoiceInput({ config: () => ({} as SpeechInputConfig) })
    await voice.start()
    expect(voice.errorMessage.value).toContain('页面的麦克风策略')
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    voice.release()
  })
})

function audioEvent(amplitude: number): AudioProcessingEvent {
  return { inputBuffer: { getChannelData: () => new Float32Array(4096).fill(amplitude) } } as unknown as AudioProcessingEvent
}
describe('microphone visual meter', () => {
  it('follows real PCM energy without requesting a second stream or processor', async () => {
    const voice = useVoiceInput({ config: () => ({} as SpeechInputConfig) })
    await voice.start()
    expect(voice.level.value).toBe(0)
    const processor = processors[0]
    processor.onaudioprocess?.(audioEvent(0.05))
    expect(voice.level.value).toBeCloseTo(0.175)
    processor.onaudioprocess?.(audioEvent(0.2))
    expect(voice.level.value).toBeCloseTo(0.7)
    processor.onaudioprocess?.(audioEvent(0.8))
    expect(voice.level.value).toBe(1)
    processor.onaudioprocess?.(audioEvent(0))
    expect(voice.level.value).toBe(0)
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
    expect(processors).toHaveLength(1)
    voice.release()
  })
  for (const operation of ['stop', 'cancel', 'release'] as const) {
    it(`${operation} clears the level and rejects already queued audio callbacks`, async () => {
      vi.mocked(recognizeWithAsr).mockResolvedValue({ text: '', latencyMs: 1 })
      const voice = useVoiceInput({ config: () => ({} as SpeechInputConfig) })
      await voice.start()
      const processor = processors[0]
      const queued = processor.onaudioprocess!
      queued(audioEvent(0.2))
      expect(voice.level.value).toBeGreaterThan(0)
      voice[operation]()
      expect(voice.level.value).toBe(0)
      expect(processor.onaudioprocess).toBeNull()
      queued(audioEvent(0.8))
      expect(voice.level.value).toBe(0)
      expect(processor.disconnect).toHaveBeenCalled()
      voice.release()
      await settle()
    })
  }
})
