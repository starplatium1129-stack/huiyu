import { computed, defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShotBatchMachine } from './useShotBatchMachine'
import * as api from '@/api/videoApi'
import { ApiClientError } from '@/api/client'
import type { ShotDraft } from './shotListTypes'
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/api/videoApi', () => ({ cancelVideoBatch: vi.fn(), concatVideoBatch: vi.fn(), createVideoBatch: vi.fn(), fetchVideoBatch: vi.fn(), retryVideoShot: vi.fn() }))
let wrapper: ReturnType<typeof mount> | undefined
const batch = (status: api.VideoBatch['status'] = 'paused'): api.VideoBatch => ({ id: 'original', status, shots: [{ status: 'failed' }, { status: 'failed' }], progress: { total: 2, succeeded: 0, failed: 2 } } as api.VideoBatch)
function setup() {
  const error = ref('')
  const shots = ref<ShotDraft[]>([]), inputsBusy = ref(false)
  let machine!: ReturnType<typeof useShotBatchMachine>
  wrapper = mount(defineComponent({ setup() {
    machine = useShotBatchMachine({ shots, inputsBusy: computed(() => inputsBusy.value), identityCard: ref(''), aspectRatio: ref('landscape'), quality: ref('standard'), steps: ref(4), linkLastFrame: ref(false), shotReferences: () => undefined, h3Ready: computed(() => true), online: computed(() => true), batchError: error })
    return () => null
  } }))
  machine.batch.value = batch()
  return { machine, error, shots, inputsBusy }
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })
describe('shot batch operation recovery', () => {
  it('does not submit a batch while reference cards or first frames are being prepared', async () => {
    const { machine, shots, inputsBusy } = setup()
    shots.value = [{ prompt: 'A complete shot description', seedText: '' } as ShotDraft]
    expect(machine.canSubmit.value).toBe(true)
    inputsBusy.value = true
    expect(machine.canSubmit.value).toBe(false)
    await machine.submitBatch()
    expect(api.createVideoBatch).not.toHaveBeenCalled()
  })
  it('resumes polling if only part of a retry-all request succeeded', async () => {
    vi.mocked(api.retryVideoShot).mockResolvedValueOnce({ batch: batch('running') } as Awaited<ReturnType<typeof api.retryVideoShot>>).mockRejectedValueOnce(new Error('retry failed'))
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ batch: batch('done') } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    const { machine, error } = setup()
    await machine.retryAllFailed()
    expect(error.value).toBe('retry failed')
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.fetchVideoBatch).toHaveBeenCalledWith('original')
    expect(machine.batch.value?.status).toBe('done')
  })
  it('prevents duplicate retries and cancels the remainder of a retry loop', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.retryVideoShot>>) => void
    vi.mocked(api.retryVideoShot).mockReturnValueOnce(new Promise(done => { resolve = done }))
    vi.mocked(api.cancelVideoBatch).mockResolvedValueOnce({ batch: batch('cancelled') } as Awaited<ReturnType<typeof api.cancelVideoBatch>>)
    const { machine } = setup()
    const pending = machine.retryAllFailed()
    expect(machine.retrying.value).toBe(true)
    await machine.retryAllFailed()
    await machine.cancelBatch()
    resolve({ batch: batch('running') } as Awaited<ReturnType<typeof api.retryVideoShot>>)
    await pending
    expect(machine.retrying.value).toBe(false)
    expect(api.retryVideoShot).toHaveBeenCalledTimes(1)
    expect(machine.batch.value?.status).toBe('cancelled')
  })
  it('keeps reconnect information on a transient server failure', async () => {
    vi.mocked(api.fetchVideoBatch).mockRejectedValueOnce(new ApiClientError('temporary', { kind: 'http', status: 503 }))
    const { machine, error } = setup()
    expect(await machine.reconnectBatch('saved')).toBe(true)
    expect(error.value).toBe('temporary')
  })
  it('only discards reconnect information when the batch is missing', async () => {
    vi.mocked(api.fetchVideoBatch).mockRejectedValueOnce(new ApiClientError('gone', { kind: 'http', status: 410 }))
    const { machine } = setup()
    expect(await machine.reconnectBatch('saved')).toBe(false)
  })
  it('ignores a missing response from an older reconnect after a newer selection succeeds', async () => {
    let reject!: (error: Error) => void
    vi.mocked(api.fetchVideoBatch).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
      .mockResolvedValueOnce({ batch: { ...batch('done'), id: 'new' } } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    const { machine, error } = setup()
    const old = machine.reconnectBatch('old')
    await machine.reconnectBatch('new')
    reject(new ApiClientError('gone', { kind: 'http', status: 410 }))
    expect(await old).toBe(true)
    expect(machine.batch.value?.id).toBe('new')
    expect(error.value).toBe('')
  })

})
