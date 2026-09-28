import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { useTaskMediaSource } from './useTaskMediaSource'

const mocks = vi.hoisted(() => ({ get: vi.fn(), fetch: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('@/api/runtimeTasks', () => ({ getRuntimeTask: mocks.get, isRuntimeResultPath: (path: string) => path.startsWith('/api/runtime/') }))
vi.mock('@/platform/desktop/runtime', () => ({ desktopRuntimeFetch: mocks.fetch, onDesktopRuntime: () => mocks.unsubscribe }))
vi.mock('@/platform/runtimeUrl', () => ({ resolveRuntimeUrl: (url: string) => url }))

it('a superseded task lookup cannot borrow the new request signal or request a stale capability', async () => {
  let finish!: (value: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ resultRefs: [{ index: 0, alias: 'new' }] })
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ url: '/media/new', expiresAt: Date.now() + 60_000 }) })
  const path = ref('/api/runtime/tasks/old/results/0')
  let media!: ReturnType<typeof useTaskMediaSource>
  const wrapper = mount(defineComponent({ setup() { media = useTaskMediaSource(() => path.value); return () => null } }))
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
  wrapper.unmount()
  expect(newSignal.aborted).toBe(true)
  expect(mocks.unsubscribe).toHaveBeenCalledOnce()
})
