import { afterEach, expect, it, vi } from 'vitest'
import { VoicePcmStream } from './voicePcmStream'

const fetchAudio = vi.hoisted(() => vi.fn())
vi.mock('../platform/runtimeUrl.ts', () => ({ runtimeFetch: fetchAudio }))
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function fixture() {
  let input!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { input = controller } })
  fetchAudio.mockImplementation((_url, { signal }: { signal: AbortSignal }) => {
    signal.addEventListener('abort', () => input.error(new DOMException('aborted', 'AbortError')))
    return Promise.resolve(new Response(body, { headers: {
      'X-Audio-Sample-Rate': '48000', 'X-Audio-Channels': '1', 'X-Audio-Format': 'pcm_s16le',
    } }))
  })
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = []
  const samples: Float32Array[] = []
  const context = {
    currentTime: 0,
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length); samples.push(data)
      return { getChannelData: () => data, duration: length / rate }
    },
    createBufferSource: () => {
      const source = { buffer: null, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), onended: null }
      sources.push(source)
      return source
    },
  } as unknown as AudioContext
  return { input, sources, samples, context }
}
afterEach(() => { vi.clearAllMocks() })

it('plays the first samples before EOF, handles split PCM samples and retains a complete WAV for replay', async () => {
  const f = fixture(), stream = new VoicePcmStream('/api/tts-stream'), started = vi.fn()
  const wave = stream.start() // Prefetch and playback share one request.
  let ended = false
  const playback = stream.play(f.context, {} as AudioNode, started).then(() => { ended = true })
  f.input.enqueue(new Uint8Array([0, 64, 0]))
  await flush()
  expect(f.sources[0]!.start).toHaveBeenCalled()
  expect(f.samples[0]![0]).toBe(.5)
  expect(started).toHaveBeenCalledOnce()
  expect(ended).toBe(false)
  expect(fetchAudio).toHaveBeenCalledOnce()
  f.input.enqueue(new Uint8Array([192])); f.input.close()
  const blob = await wave
  expect(f.samples[1]![0]).toBe(-.5)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
  expect(Array.from(bytes.slice(44))).toEqual([0, 64, 0, 192])
  f.sources.forEach(source => source.onended?.())
  await playback
  expect(ended).toBe(true)
})

it('cancels the request and scheduled audio without retaining a partial replay clip', async () => {
  const f = fixture(), stream = new VoicePcmStream('/api/tts-stream')
  const wave = stream.start()
  const playback = stream.play(f.context, {} as AudioNode, vi.fn())
  f.input.enqueue(new Uint8Array([0, 64])); await flush()
  stream.cancel()
  await playback
  await expect(wave).rejects.toMatchObject({ name: 'AbortError' })
  expect(fetchAudio.mock.calls[0]![1].signal.aborted).toBe(true)
  expect(f.sources[0]!.stop).toHaveBeenCalledOnce()
  expect(f.sources[0]!.disconnect).toHaveBeenCalledOnce()
  expect(stream.playing).toBe(false)
})
