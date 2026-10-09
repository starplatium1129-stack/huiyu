import { afterEach, expect, it, vi } from 'vitest'
import { recognizeWithAsr } from './voiceApi'
import type { SpeechInputConfig } from './speechInputConfig'

const config = { endpoint: 'https://asr.example.test/v1', model: 'whisper-1', apiKey: '', language: '' } as SpeechInputConfig
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(['headers', 'body'])('times out an ASR request stalled at %s and releases its timer', async phase => {
  vi.useFakeTimers()
  let requestSignal!: AbortSignal
  const blocked = () => new Promise<never>((_resolve, reject) => {
    requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    requestSignal = init.signal!
    return phase === 'headers' ? blocked() : Promise.resolve({ ok: true, json: blocked })
  }))
  const caller = new AbortController()
  const pending = recognizeWithAsr(config, new Uint8Array([1]), caller.signal).catch(error => error)
  try {
    await vi.advanceTimersByTimeAsync(120_000)
    expect(requestSignal.aborted).toBe(true)
    expect(await pending).toMatchObject({ kind: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  } finally { caller.abort(); await pending }
})

it('keeps explicit cancellation distinct from timeout while reading the response body', async () => {
  vi.useFakeTimers()
  let reading!: () => void
  const started = new Promise<void>(resolve => { reading = resolve })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, json: () => {
    reading()
    return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
  } })))
  const caller = new AbortController()
  const pending = recognizeWithAsr(config, new Uint8Array([1]), caller.signal).catch(error => error)
  await started; caller.abort()
  expect(await pending).toMatchObject({ kind: 'canceled' })
  expect(vi.getTimerCount()).toBe(0)
})

it('returns the recognized text and clears the deadline after a successful response', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ text: '  a short transcript  ' }) })))
  expect(await recognizeWithAsr(config, new Uint8Array([1]))).toMatchObject({ text: 'a short transcript' })
  expect(vi.getTimerCount()).toBe(0)
})
