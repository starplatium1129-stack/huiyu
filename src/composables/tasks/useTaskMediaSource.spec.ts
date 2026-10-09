import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useTaskMediaSource } from './useTaskMediaSource'

const mocks = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({ getRuntimeTask: mocks.get, isRuntimeResultPath: (path: string) => path.startsWith('/api/runtime/') }))
vi.mock('@/platform/desktop/runtime', () => ({
  desktopRuntimeFetch: mocks.fetch,
  onDesktopRuntime: (listener: (state: { connection: string; bootstrap: null }) => void) => {
    mocks.subscribe(listener)
    listener({ connection: 'ready', bootstrap: null })
    return mocks.unsubscribe
  },
}))
vi.mock('@/platform/runtimeUrl', () => ({ resolveRuntimeUrl: (url: string) => url }))

it('stops renewal and prevents a late capability response from scheduling it again', async () => {
  vi.useFakeTimers()
  mocks.get.mockReset().mockResolvedValue({ resultRefs: [{ index: 0, alias: 'fixture' }] })
  let finish!: (value: { url: string; expiresAt: number }) => void
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: () => new Promise(resolve => { finish = resolve }) })
  let media!: ReturnType<typeof useTaskMediaSource>
  const wrapper = mount(defineComponent({ setup() { media = useTaskMediaSource(() => '/api/runtime/tasks/fixture/results/0'); return () => null } }))
  try {
    await flushPromises()
    media.stopRenewal()
    finish({ url: '/media/late', expiresAt: Date.now() + 30_000 }); await flushPromises()
    expect(media.url.value).toBe('')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.get).toHaveBeenCalledOnce()
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ url: '/media/retry', expiresAt: Date.now() + 30_000 }) })
    await media.refresh()
    expect(media.url.value).toBe('/media/retry')
    expect(vi.getTimerCount()).toBe(1)
  } finally { wrapper.unmount(); vi.useRealTimers(); vi.resetAllMocks() }
})

it('a superseded task lookup cannot borrow the new request signal or request a stale capability', async () => {
  let finish!: (value: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ resultRefs: [{ index: 0, alias: 'new' }] })
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ url: '/media/new', expiresAt: Date.now() + 60_000 }) })
  const path = ref('/api/runtime/tasks/old/results/0')
  let media!: ReturnType<typeof useTaskMediaSource>
  const wrapper = mount(defineComponent({ setup() { media = useTaskMediaSource(() => path.value); return () => null } }))
  expect(mocks.get).toHaveBeenCalledOnce()
  const oldSignal = mocks.get.mock.calls[0][1] as AbortSignal
  path.value = '/api/runtime/tasks/new/results/0'
  await flushPromises()
  expect(oldSignal.aborted).toBe(true)
  const newSignal = mocks.get.mock.calls[1][1] as AbortSignal
  expect(mocks.fetch.mock.calls[0][1].signal).toBe(newSignal)
  finish({ resultRefs: [{ index: 0, alias: 'old' }] })
  await flushPromises()
  expect(mocks.fetch).toHaveBeenCalledTimes(1)
  expect(media.url.value).toBe('/media/new')
  const runtimeChanged = mocks.subscribe.mock.calls[0][0]
  runtimeChanged({ connection: 'ready', bootstrap: null })
  await flushPromises()
  expect(mocks.get).toHaveBeenCalledTimes(2)
  runtimeChanged({ connection: 'starting', bootstrap: null })
  runtimeChanged({ connection: 'ready', bootstrap: null })
  await flushPromises()
  expect(mocks.get).toHaveBeenCalledTimes(3)
  expect(mocks.fetch).toHaveBeenCalledTimes(2)
  const renewedSignal = mocks.get.mock.calls[2][1] as AbortSignal
  wrapper.unmount()
  expect(newSignal.aborted).toBe(true)
  expect(renewedSignal.aborted).toBe(true)
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})

it('clears the previous clip error while the newly selected clip is still loading', async () => {
  mocks.get.mockReset().mockRejectedValueOnce(new Error('previous clip unavailable'))
  mocks.fetch.mockReset().mockResolvedValue({ ok: true, json: async () => ({ url: '/media/current', expiresAt: Date.now() + 60_000 }) })
  const path = ref('/api/runtime/tasks/old/results/0')
  let media!: ReturnType<typeof useTaskMediaSource>, finish!: (value: unknown) => void
  const wrapper = mount(defineComponent({ setup() { media = useTaskMediaSource(() => path.value); return () => null } }))
  try {
    await flushPromises()
    expect(media.error.value).toBe('previous clip unavailable')
    mocks.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    path.value = '/api/runtime/tasks/current/results/0'; await flushPromises()
    expect(media.error.value).toBe('')
    expect(media.url.value).toBe('')
    finish({ resultRefs: [{ index: 0, alias: 'current' }] }); await flushPromises()
    expect(media.url.value).toBe('/media/current')
    expect(media.error.value).toBe('')
  } finally { wrapper.unmount() }
})
