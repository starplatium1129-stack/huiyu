import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useVoice } from './useVoice'

const api = vi.hoisted(() => ({ getStatus: vi.fn(), prepare: vi.fn(), translate: vi.fn() }))
vi.mock('@/api/voiceApi', () => ({ voiceApi: api }))
const audios: FakeAudio[] = []
class FakeAudio extends EventTarget {
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
  const onError = vi.fn(), onStatus = vi.fn(), onSpeaking = vi.fn()
  voice = useVoice({ enabled: () => true, onError, onStatus, onSpeaking })
  await voice.refreshAvailability()
  return { onError, onStatus, onSpeaking }
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
