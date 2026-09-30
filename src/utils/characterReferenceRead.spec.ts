import { afterEach, expect, it, vi } from 'vitest'
import { readCharacterReference } from './characterReferenceRead'
afterEach(() => vi.useRealTimers())
it('aborts a stalled read at its deadline even if it ignores the signal', async () => {
  vi.useFakeTimers()
  let signal!: AbortSignal
  const pending = readCharacterReference(readSignal => { signal = readSignal; return new Promise(() => {}) }).catch(error => error)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(await pending).toMatchObject({ name: 'TimeoutError' })
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('releases the deadline and caller listener on success and cancellation', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const add = vi.spyOn(controller.signal, 'addEventListener')
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  expect(await readCharacterReference(async () => 'ready', controller.signal)).toBe('ready')
  expect(vi.getTimerCount()).toBe(0)
  let signal!: AbortSignal
  const pending = readCharacterReference(readSignal => { signal = readSignal; return new Promise(() => {}) }, controller.signal).catch(error => error)
  await Promise.resolve()
  controller.abort()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(signal.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(add).toHaveBeenCalledTimes(2)
  for (const [event, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(event, listener)
})
it('does not invoke the read when cancellation wins before it starts', async () => {
  const controller = new AbortController()
  const read = vi.fn(async () => 'unexpected')
  const pending = readCharacterReference(read, controller.signal).catch(error => error)
  controller.abort()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  expect(read).not.toHaveBeenCalled()
})
