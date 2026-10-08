import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useVoice } from './useVoice'
import { VoicePcmStream } from './voicePcmStream'

const api = vi.hoisted(() => ({ getStatus: vi.fn(), prepare: vi.fn(), translate: vi.fn() }))
vi.mock('@/api/voiceApi', () => ({ voiceApi: api }))
const audios: FakeAudio[] = []
class FakeAudio extends EventTarget {
  volume = 1
  paused = true
  ended = false
  readyState = 0
  networkState = 0
  src: string
  pause = vi.fn(() => { this.paused = true })
  load = vi.fn()
  removeAttribute = vi.fn(() => { this.src = '' })
  play = vi.fn(() => { this.paused = false; return Promise.resolve() })
  constructor(src: string) { super(); this.src = src; audios.push(this) }
}
let voice: ReturnType<typeof useVoice>
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => {
  vi.useFakeTimers(); audios.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  api.getStatus.mockResolvedValue({ online: true, voices: { nene: true, natsume: true } })
  api.prepare.mockResolvedValue({})
  api.translate.mockResolvedValue({ translation: '今日はお天気ですね。' })
})
afterEach(() => { voice?.destroy(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
async function setup() {
  const onError = vi.fn(), onStatus = vi.fn(), onSpeaking = vi.fn(), onAudioReady = vi.fn(), onAudioCleared = vi.fn()
  voice = useVoice({ enabled: () => true, onError, onStatus, onSpeaking, onAudioReady, onAudioCleared })
  await voice.refreshAvailability()
  return { onError, onStatus, onSpeaking, onAudioReady, onAudioCleared }
}
async function speak(mid = 'first') {
  voice.startTurn({ mid, voice: 'nene', character: 'nene' })
  voice.append('今天我们一起去公园散步吧。'); voice.finishTurn(); await flush()
}
it('interruption removes old callbacks and timers before a new character speaks', async () => {
  const callbacks = await setup()
  await speak()
  const old = audios[0]
  voice.stop({ preserveMessageAudio: true })
  await speak('second')
  callbacks.onError.mockClear(); callbacks.onSpeaking.mockClear()
  old.dispatchEvent(new Event('error')); old.dispatchEvent(new Event('ended'))
  await vi.advanceTimersByTimeAsync(90_001)
  // Only the new player's timeout is allowed to report an error.
  expect(callbacks.onError).toHaveBeenCalledTimes(1)
  expect(old.load).toHaveBeenCalled()
  expect(audios).toHaveLength(2)
})
it('stopping replay settles its promise and cannot advance to old clips', async () => {
  await setup(); await speak()
  const replay = voice.playMessage('first')
  await flush()
  voice.stop({ preserveMessageAudio: true })
  await expect(replay).resolves.toBe(false)
  expect(voice.isActive()).toBe(false)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(audios).toHaveLength(2)
})
it('late translation and failed synthesis cannot leak into a later turn', async () => {
  const { onError } = await setup()
  let reject!: (error: Error) => void
  api.translate.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
  await speak()
  voice.stop()
  await speak('new')
  reject(new Error('late translation failure')); await flush()
  expect(audios).toHaveLength(1)
  expect(onError).not.toHaveBeenCalled()
})
it('an A-B-A warmup race cannot publish the stale A response', async () => {
  const { onStatus } = await setup()
  let resolve!: () => void
  api.prepare.mockImplementationOnce(() => new Promise<void>(yes => { resolve = yes }))
  const first = voice.prepare('nene')
  voice.stop()
  await voice.prepare('natsume')
  onStatus.mockClear()
  resolve(); await expect(first).resolves.toBe(false)
  expect(voice.availability.value.activeVoice).toBe('natsume')
  expect(onStatus).not.toHaveBeenCalled()
})

it('a mid-playback error never restarts the same sentence, and the next turn can play', async () => {
  await setup(); await speak()
  audios[0].dispatchEvent(new Event('playing'))
  audios[0].dispatchEvent(new Event('error'))
  await flush()
  expect(audios).toHaveLength(1)
  await speak('next')
  expect(audios).toHaveLength(2)
})

it.each(['http', 'network', 'format', 'incomplete', 'aborted'])('retains manual replay only for an owned non-abort PCM %s failure', async failure => {
  vi.stubGlobal('AudioContext', class {
    state = 'running'; destination = {}
    close = vi.fn().mockResolvedValue(undefined)
    createAnalyser = () => ({ connect: vi.fn() })
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
    createMediaElementSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  })
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (failure === 'network') throw new TypeError('connection lost')
    if (failure === 'aborted') throw new DOMException('aborted', 'AbortError')
    if (failure === 'http') return Response.json({ error: 'unavailable' }, { status: 503 })
    return new Response(new Uint8Array([1]), { headers: failure === 'format' ? {} : {
      'X-Audio-Sample-Rate': '48000', 'X-Audio-Channels': '1', 'X-Audio-Format': 'pcm_s16le',
    } })
  }))
  api.getStatus.mockResolvedValue({ online: true, voices: { nene: true }, streamingPcm: true })
  const { onError, onAudioReady, onAudioCleared } = await setup()
  await speak()
  const retryable = failure !== 'aborted'
  expect(voice.hasAudio('first')).toBe(retryable)
  expect(onError).toHaveBeenCalledTimes(retryable ? 1 : 0)
  expect(onAudioReady).toHaveBeenCalledTimes(retryable ? 1 : 0)
  expect(audios).toHaveLength(0) // No automatic whole-clip restart.
  const replay = voice.playMessage('first')
  if (retryable) {
    expect(audios[0]!.src).toContain('/api/tts?voice=nene&text=')
    audios[0]!.dispatchEvent(new Event('ended'))
  }
  await expect(replay).resolves.toBe(retryable)
  voice.clearMessages(['first'])
  expect(voice.hasAudio('first')).toBe(false)
  expect(onAudioCleared).toHaveBeenCalledTimes(retryable ? 1 : 0)
})

it('prefetches only the next PCM sentence during playback and cancels both requests on stop', async () => {
  const requests: Array<{ signal: AbortSignal; input: ReadableStreamDefaultController<Uint8Array> }> = []
  const sources: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('fetch', vi.fn((_url, { signal }) => {
    const body = new ReadableStream<Uint8Array>({ start(input) {
      requests.push({ signal, input })
      signal.addEventListener('abort', () => input.error(new DOMException('aborted', 'AbortError')))
    } })
    return Promise.resolve(new Response(body, { headers: {
      'X-Audio-Sample-Rate': '48000', 'X-Audio-Channels': '1', 'X-Audio-Format': 'pcm_s16le',
    } }))
  }))
  vi.stubGlobal('AudioContext', class {
    state = 'running'; currentTime = 0; destination = {}
    close = vi.fn().mockResolvedValue(undefined)
    createAnalyser = () => ({ connect: vi.fn(), getByteTimeDomainData: vi.fn() })
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
    createBuffer = (_channels: number, length: number, rate: number) => ({ duration: length / rate, getChannelData: () => new Float32Array(length) })
    createBufferSource = () => {
      const source = { start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), buffer: null, onended: null }
      sources.push(source); return source
    }
  })
  api.getStatus.mockResolvedValue({ online: true, voices: { nene: true }, streamingPcm: true })
  const { onSpeaking, onAudioReady } = await setup()
  voice.startTurn({ mid: 'streaming', voice: 'nene', character: 'nene' })
  voice.append('今天我们一起去公园散步吧。然后再去买一点喜欢的甜点。最后坐下来一起喝杯热茶吧。')
  voice.finishTurn(); await flush(); await flush()
  expect(requests).toHaveLength(2)
  expect(voice.hasAudio('streaming')).toBe(false)
  requests[0]!.input.enqueue(new Uint8Array([0, 64])); await flush()
  expect(sources[0]!.start).toHaveBeenCalled()
  expect(onSpeaking).toHaveBeenCalledWith(true, 'streaming')
  voice.stop({ preserveMessageAudio: true }); await flush()
  expect(requests.every(request => request.signal.aborted)).toBe(true)
  expect(sources[0]!.stop).toHaveBeenCalled()
  expect(voice.hasAudio('streaming')).toBe(false)
  expect(onAudioReady).not.toHaveBeenCalled()
  expect(voice.isActive()).toBe(false)
})

async function setupReplayCache(blob = new Blob(['wave'])) {
  let id = 0
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:replay-${++id}`)
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const start = vi.spyOn(VoicePcmStream.prototype, 'start').mockResolvedValue(blob)
  const play = vi.spyOn(VoicePcmStream.prototype, 'play').mockResolvedValue()
  vi.stubGlobal('AudioContext', class {
    state = 'running'; destination = {}
    close = vi.fn().mockResolvedValue(undefined)
    createAnalyser = () => ({ connect: vi.fn() })
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })
    createMediaElementSource = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  })
  api.getStatus.mockResolvedValue({ online: true, voices: { nene: true }, streamingPcm: true })
  const callbacks = await setup()
  return { create, revoke, start, play, ...callbacks }
}

it('retains eight recent WAV messages and replays evicted messages through the original TTS URL', async () => {
  const { revoke, onAudioReady } = await setupReplayCache()
  for (let i = 0; i < 9; i++) await speak(`message-${i}`)
  expect(revoke.mock.calls).toEqual([['blob:replay-1']])
  expect(onAudioReady).toHaveBeenCalledTimes(9)
  expect(voice.hasAudio('message-0')).toBe(true)
  const replay = voice.playMessage('message-0')
  expect(audios[0]!.src).toContain('/api/tts?voice=nene&text=')
  voice.stop({ preserveMessageAudio: true }); await replay
  const recent = voice.playMessage('message-8')
  expect(audios[1]!.src).toBe('blob:replay-9')
  // Clearing a playing message defers revocation until its player releases it.
  voice.clearMessages(['message-8'])
  expect(revoke).not.toHaveBeenCalledWith('blob:replay-9')
  audios[1]!.dispatchEvent(new Event('ended')); await recent
  expect(revoke).toHaveBeenCalledWith('blob:replay-9')
  voice.destroy()
  expect(revoke).toHaveBeenCalledTimes(9)
  expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(9)
})

it('bounds WAV bytes even within one message and skips caching an oversized clip', async () => {
  const { create, revoke, start } = await setupReplayCache(new Blob([new Uint8Array(9 * 1024 * 1024)]))
  await speak('large')
  await speak('large')
  expect(revoke.mock.calls).toEqual([['blob:replay-1']])
  start.mockResolvedValueOnce(new Blob([new Uint8Array(17 * 1024 * 1024)]))
  await speak('oversized')
  expect(create).toHaveBeenCalledTimes(2)
  const replay = voice.playMessage('oversized')
  expect(audios[0]!.src).toContain('/api/tts?')
  voice.stop({ preserveMessageAudio: true }); await replay
})

it.each(['stopped', 'cleared'])('does not publish late PCM completion or failure for a %s message', async invalidation => {
  const { create, start, play, onAudioReady } = await setupReplayCache()
  for (const failed of [false, true]) {
    let complete!: (blob: Blob) => void, fail!: (error: Error) => void
    const result = new Promise<Blob>((resolve, reject) => { complete = resolve; fail = reject })
    start.mockReturnValueOnce(result)
    play.mockReturnValueOnce(result.then(() => {}))
    await speak('late')
    if (invalidation === 'stopped') voice.stop({ preserveMessageAudio: true })
    else voice.clearMessages(['late'])
    if (failed) fail(new Error('late stream failure'))
    else complete(new Blob(['late wave']))
    await flush()
    expect(create).not.toHaveBeenCalled()
    expect(onAudioReady).not.toHaveBeenCalled()
    expect(voice.hasAudio('late')).toBe(false)
  }
})

it.each(['unavailable', 'attachment-fails', 'attached'])('keeps mute and volume effective with %s Web Audio, including replay', async mode => {
  const ramp = vi.fn()
  vi.stubGlobal('AudioContext', mode === 'unavailable' ? undefined : class {
    state = 'running'; destination = {}; currentTime = 0
    close = vi.fn().mockResolvedValue(undefined)
    createAnalyser = () => ({ connect: vi.fn() })
    createGain = () => ({ gain: { value: 1, linearRampToValueAtTime: ramp }, connect: vi.fn(), disconnect: vi.fn() })
    createMediaElementSource = () => {
      if (mode === 'attachment-fails') throw new Error('analysis unavailable')
      return { connect: vi.fn(), disconnect: vi.fn() }
    }
  })
  await setup()
  voice.setVolume(0); await speak()
  expect(audios[0].volume).toBe(mode === 'attached' ? 1 : 0)
  voice.setVolume(0.5)
  expect(audios[0].volume).toBe(mode === 'attached' ? 1 : 0.5)
  const replay = voice.playMessage('first'); await flush()
  expect(audios[1].volume).toBe(mode === 'attached' ? 1 : 0.5)
  voice.setVolume(0)
  expect(audios[1].volume).toBe(mode === 'attached' ? 1 : 0)
  if (mode === 'attached') expect(ramp).toHaveBeenLastCalledWith(0, 0.05)
  voice.stop(); await expect(replay).resolves.toBe(false)
})
