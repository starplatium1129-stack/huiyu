import { afterEach, expect, it, vi } from 'vitest'
import { withChatTurn } from './chatTurnOwnership'
afterEach(() => vi.unstubAllGlobals())
it('keeps the existing writer and declines a competing send without running it', async () => {
  let held = false
  vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, fn: (lock: unknown) => Promise<void>) => {
    if (held) return fn(null)
    held = true
    try { await fn({}) } finally { held = false }
  } } })
  let finish!: () => void
  const pending = withChatTurn(() => new Promise<void>(resolve => { finish = resolve }), vi.fn())
  const other = vi.fn(), unavailable = vi.fn()
  await withChatTurn(other, unavailable)
  expect(other).not.toHaveBeenCalled()
  expect(unavailable).toHaveBeenCalledOnce()
  finish(); await pending
  await withChatTurn(other, unavailable)
  expect(other).toHaveBeenCalledOnce()
})
