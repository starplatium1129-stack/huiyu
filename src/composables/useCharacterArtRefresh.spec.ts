import { defineComponent, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { useCharacterArtRefresh } from './useCharacterArtRefresh'
import { setRuntimeOrigin } from '@/platform/runtimeUrl'

const calls = vi.hoisted(() => ({ get: vi.fn(), clear: vi.fn(), local: true }))
vi.mock('@/api/characterArtApi', () => ({ characterArtApi: { get: calls.get }, CHARACTER_ART_CHANNEL: 'test-art' }))
vi.mock('@/platform/characterArtState', () => ({ clearCharacterArtManifest: calls.clear, remapCharacterArt: (value: string) => value }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => calls.local }))
let wrapper: ReturnType<typeof mount> | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined; setRuntimeOrigin(null); vi.unstubAllGlobals(); vi.clearAllMocks(); calls.local = true })

it('refreshes on focus and cross-window invalidation and releases channels and inflight requests', async () => {
  const channels: Array<{ onmessage?: () => void; close: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('BroadcastChannel', class {
    onmessage?: () => void
    close = vi.fn()
    constructor() { channels.push(this) }
  })
  calls.get.mockResolvedValue({ version: '0', entries: {} })
  wrapper = mount(defineComponent({ setup() { useCharacterArtRefresh(); return () => null } }))
  await flushPromises()
  expect(calls.get).toHaveBeenCalledTimes(1)
  const initialSignal = calls.get.mock.calls[0][0].signal as AbortSignal
  window.dispatchEvent(new Event('focus'))
  await flushPromises()
  expect(initialSignal.aborted).toBe(true)
  expect(calls.get).toHaveBeenCalledTimes(2)
  channels[0].onmessage?.()
  await flushPromises()
  expect(calls.get).toHaveBeenCalledTimes(3)
  const finalSignal = calls.get.mock.calls[2][0].signal as AbortSignal
  wrapper.unmount(); wrapper = undefined
  expect(finalSignal.aborted).toBe(true)
  expect(channels[0].close).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event('focus'))
  expect(calls.get).toHaveBeenCalledTimes(3)
})

it('clears old-runtime overrides before refreshing after a reconnect and skips remote hosts', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  calls.get.mockResolvedValue({ version: '0', entries: {} })
  wrapper = mount(defineComponent({ setup() { useCharacterArtRefresh(); return () => null } }))
  await flushPromises()
  setRuntimeOrigin('http://127.0.0.1:7999', true, 'new-session')
  await nextTick()
  expect(calls.clear).toHaveBeenCalledOnce()
  expect(calls.get).toHaveBeenCalledTimes(2)
  calls.local = false
  window.dispatchEvent(new Event('focus'))
  expect(calls.clear).toHaveBeenCalledTimes(2)
  expect(calls.get).toHaveBeenCalledTimes(2)
})
