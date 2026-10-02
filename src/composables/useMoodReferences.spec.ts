import { afterEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { setRuntimeOrigin, runtimeFetch } from '@/platform/runtimeUrl'
import { useMoodReferences } from './useMoodReferences'

vi.mock('@/platform/runtimeUrl', async importOriginal => ({
  ...await importOriginal<typeof import('@/platform/runtimeUrl')>(), runtimeFetch: vi.fn(),
}))
enableAutoUnmount(afterEach)
afterEach(() => { setRuntimeOrigin(null, false); vi.resetAllMocks() })
const fetchMock = vi.mocked(runtimeFetch)
const response = (...ids: string[]) => new Response(JSON.stringify({ entries: ids.map(id => ({ id, title: id, char: 'nene', type: 'scene', rating: 'All' })) }))
function setup() {
  let references!: ReturnType<typeof useMoodReferences>
  const view = mount(defineComponent({ setup() { references = useMoodReferences(['one', 'two']); return () => null } }))
  return { view, references }
}

it('waits while disconnected and retries a failed manifest once after runtime recovery', async () => {
  setRuntimeOrigin(null, true)
  fetchMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response('one', 'two', 'two'))
  const { references } = setup()
  expect(fetchMock).not.toHaveBeenCalled()
  expect(references.loading.value).toBe(false)
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'first'); await flushPromises()
  expect(references.loading.value).toBe(false)
  expect(references.available.value.size).toBe(0)
  setRuntimeOrigin(null, true); await nextTick()
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'second'); await flushPromises()
  expect([...references.available.value]).toEqual(['one']) // Ambiguous IDs remain unavailable.
  expect(fetchMock).toHaveBeenCalledTimes(2)
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'second'); await flushPromises()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('aborts old epochs and unmounts, ignoring late responses from those requests', async () => {
  const pending: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = []
  fetchMock.mockImplementation((_input, init) => new Promise<Response>(resolve => {
    pending.push({ signal: init!.signal as AbortSignal, resolve })
  }))
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'first')
  const { view, references } = setup()
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'second'); await nextTick()
  expect(pending[0]!.signal.aborted).toBe(true)
  pending[0]!.resolve(response('one')); await flushPromises()
  expect(references.available.value.size).toBe(0)
  expect(references.loading.value).toBe(true)
  pending[1]!.resolve(response('two')); await flushPromises()
  expect([...references.available.value]).toEqual(['two'])
  setRuntimeOrigin('http://127.0.0.1:3002', true, 'third'); await nextTick()
  expect(references.available.value.size).toBe(0)
  view.unmount()
  expect(pending[2]!.signal.aborted).toBe(true)
  pending[2]!.resolve(response('one')); await flushPromises()
  expect(references.available.value.size).toBe(0)
})
