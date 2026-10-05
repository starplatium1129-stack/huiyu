import { computed, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShotBatchMachine } from './useShotBatchMachine'
import * as api from '@/api/videoApi'
import { ApiClientError } from '@/api/client'
import type { ShotDraft } from './shotListTypes'
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/api/videoApi', () => ({ cancelVideoBatch: vi.fn(), concatVideoBatch: vi.fn(), createVideoBatch: vi.fn(), fetchVideoBatch: vi.fn(), retryVideoShot: vi.fn() }))
let wrapper: ReturnType<typeof mount> | undefined
const batch = (status: api.VideoBatch['status'] = 'paused'): api.VideoBatch => ({ id: 'original', status, shots: [{ status: 'failed' }, { status: 'failed' }], progress: { total: 2, succeeded: 0, failed: 2 } } as api.VideoBatch)
function setup(cached = false) {
  const error = ref(''), accepted = vi.fn()
  const active = ref(true)
  const shots = ref<ShotDraft[]>([]), inputsBusy = ref(false)
  let machine!: ReturnType<typeof useShotBatchMachine>
  const page = defineComponent({ setup() {
    machine = useShotBatchMachine({ shots, inputsBusy: computed(() => inputsBusy.value), identityCard: ref(''), aspectRatio: ref('landscape'), quality: ref('standard'), steps: ref(4), linkLastFrame: ref(false), shotReferences: () => undefined, h3Ready: computed(() => true), online: computed(() => true), batchError: error, onAccepted: accepted })
    return () => null
  } })
  wrapper = mount(cached ? defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(page) : null }) }) : page)
  machine.batch.value = batch()
  return { machine, error, shots, inputsBusy, active, accepted }
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers() })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })
describe('shot batch operation recovery', () => {
  it('does not submit a batch while reference cards or first frames are being prepared', async () => {
    const { machine, shots, inputsBusy, accepted } = setup()
    shots.value = [{ prompt: 'A complete shot description', seedText: '' } as ShotDraft]
    expect(machine.canSubmit.value).toBe(true)
    inputsBusy.value = true
    expect(machine.canSubmit.value).toBe(false)
    await machine.submitBatch()
    expect(api.createVideoBatch).not.toHaveBeenCalled()
    inputsBusy.value = false
    shots.value[0].dialogue = ''
    vi.mocked(api.createVideoBatch).mockResolvedValueOnce({ batch: batch('running') } as Awaited<ReturnType<typeof api.createVideoBatch>>)
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ batch: batch('done') } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    await machine.submitBatch()
    await vi.advanceTimersByTimeAsync(3000)
    expect(machine.batch.value?.status).toBe('done')
    let acknowledge!: (value: Awaited<ReturnType<typeof api.createVideoBatch>>) => void
    vi.mocked(api.createVideoBatch).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve }))
    const submitting = machine.submitBatch()
    wrapper!.unmount()
    acknowledge({ ok: true, batch: { ...batch('running'), id: 'accepted-after-leave' } })
    await submitting
    expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ id: 'accepted-after-leave' }))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('resumes polling if only part of a retry-all request succeeded', async () => {
    vi.mocked(api.retryVideoShot).mockResolvedValueOnce({ batch: batch('running') } as Awaited<ReturnType<typeof api.retryVideoShot>>).mockRejectedValueOnce(new Error('retry failed'))
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ batch: batch('done') } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    const { machine, error } = setup()
    await machine.retryAllFailed()
    expect(error.value).toBe('retry failed')
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.fetchVideoBatch).toHaveBeenCalledWith('original', expect.any(AbortSignal))
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
    const { machine, error } = setup()
    expect(await machine.reconnectBatch('saved')).toBe(false)
    expect(error.value).toContain('已不存在')
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
    let resolve!: (value: Awaited<ReturnType<typeof api.fetchVideoBatch>>) => void
    vi.mocked(api.fetchVideoBatch).mockReturnValueOnce(new Promise(done => { resolve = done }))
    const pending = machine.reconnectBatch('obsolete')
    await machine.reconnectBatch('new')
    resolve({ ok: true, batch: { ...batch('done'), id: 'obsolete' } })
    await pending
    expect(machine.batch.value?.id).toBe('new')

  })

  it('pauses cached storyboard polling, ignores abandoned read failures and refreshes once on return', async () => {
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ batch: { ...batch('running'), id: 'saved' } } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    const { machine, error, active } = setup(true)
    await machine.reconnectBatch('saved')
    let reject!: (error: Error) => void
    vi.mocked(api.fetchVideoBatch).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    await vi.advanceTimersByTimeAsync(3000)
    const signal = vi.mocked(api.fetchVideoBatch).mock.calls[1][1]
    expect(signal).toBeInstanceOf(AbortSignal)
    active.value = false
    await nextTick()
    expect(signal!.aborted).toBe(true)
    reject(new Error('obsolete read failed'))
    await vi.advanceTimersByTimeAsync(12000)
    expect(api.fetchVideoBatch).toHaveBeenCalledTimes(2)
    expect(error.value).toBe('')
    expect(api.cancelVideoBatch).not.toHaveBeenCalled()
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ batch: { ...batch('done'), id: 'saved' } } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    active.value = true
    await nextTick(); await flushPromises()
    expect(api.fetchVideoBatch).toHaveBeenCalledTimes(3)
    expect(machine.batch.value?.status).toBe('done')
  })

  it('holds scheduled status reads while cancelling and ignores an obsolete retry error', async () => {
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ batch: { ...batch('running'), id: 'saved' } } as Awaited<ReturnType<typeof api.fetchVideoBatch>>)
    const { machine, error } = setup()
    await machine.reconnectBatch('saved')
    let rejectRetry!: (error: Error) => void, finishCancel!: (value: Awaited<ReturnType<typeof api.cancelVideoBatch>>) => void
    vi.mocked(api.retryVideoShot).mockReturnValueOnce(new Promise((_resolve, fail) => { rejectRetry = fail }))
    vi.mocked(api.cancelVideoBatch).mockReturnValueOnce(new Promise(resolve => { finishCancel = resolve }))
    const retry = machine.retryShotAt(0)
    const cancellation = machine.cancelBatch()
    await vi.advanceTimersByTimeAsync(6000)
    expect(api.fetchVideoBatch).toHaveBeenCalledOnce()
    finishCancel({ batch: { ...batch('cancelled'), id: 'saved' } } as Awaited<ReturnType<typeof api.cancelVideoBatch>>)
    await cancellation
    rejectRetry(new Error('superseded retry failed'))
    await retry
    expect(error.value).toBe('')
    expect(machine.batch.value?.status).toBe('cancelled')
  })

  it('keeps independent retries out of original shot slots and resolves old child links only through an accessible source', async () => {
    const { machine, error } = setup()
    const original = machine.batch.value
    const child = { ...batch('running'), id: 'retry-child', shots: [batch().shots[1]], retrySource: { batchId: 'original', stepIndex: 1 } }
    vi.mocked(api.retryVideoShot).mockResolvedValue({ ok: true, batch: child })
    await machine.retryAllFailed()
    expect(machine.batch.value).toBe(original)
    expect(machine.serverShot(0)?.status).toBe('failed')
    expect(api.retryVideoShot).toHaveBeenNthCalledWith(1, 'original', 1)
    expect(api.retryVideoShot).toHaveBeenNthCalledWith(2, 'original', 2)
    expect(error.value).toContain('不会自动回并')
    expect(machine.canConcat.value).toBe(false)
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ ok: true, batch: child }).mockResolvedValueOnce({ ok: true, batch: batch() })
    expect(await machine.reconnectBatch('retry-child')).toBe(true)
    expect(machine.batch.value?.id).toBe('original')
    expect(error.value).toContain('尚未替换')
    for (const status of [404, 403]) {
      vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ ok: true, batch: child })
        .mockRejectedValueOnce(new ApiClientError('unavailable source', { kind: 'http', status }))
      expect(await machine.reconnectBatch('retry-child')).toBe(false)
      expect(machine.batch.value?.id).toBe('original')
      expect(error.value).toContain('不存在或无权访问')
    }
  })

})
