import { computed, defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShotBatchMachine } from './useShotBatchMachine'
import { useShotDraft } from './useShotDraft'
import type { ShotsDraftPayload } from '@/stores/videoStore'
import * as api from '@/api/videoApi'
import { ApiClientError } from '@/api/client'
import type { ShotDraft } from './shotListTypes'
const savedDraft = ref<ShotsDraftPayload | null>(null)
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({
  get shotsDraft() { return savedDraft.value },
  saveShotsDraft(value: ShotsDraftPayload) { savedDraft.value = JSON.parse(JSON.stringify(value)); return true },
}) }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/api/videoApi', () => ({ cancelVideoBatch: vi.fn(), concatVideoBatch: vi.fn(), createVideoBatch: vi.fn(), fetchVideoBatch: vi.fn(), retryVideoShot: vi.fn() }))
let wrapper: ReturnType<typeof mount> | undefined
const batch = (status: api.VideoBatch['status'] = 'paused'): api.VideoBatch => ({ id: 'original', status, shots: [{ status: 'failed' }, { status: 'failed' }], progress: { total: 2, succeeded: 0, failed: 2 } } as api.VideoBatch)
function setup(cached = false, persisted = false) {
  const error = ref(''), accepted = vi.fn()
  const active = ref(true)
  const shots = ref<ShotDraft[]>([]), inputsBusy = ref(false)
  const identityCard = ref(''), aspectRatio = ref<api.VideoBatch['aspectRatio']>('landscape'), quality = ref<api.VideoQuality>('standard'), steps = ref<4 | 8>(4), linkLastFrame = ref(false)
  let machine!: ReturnType<typeof useShotBatchMachine>
  let draft: ReturnType<typeof useShotDraft> | undefined
  const submitted = vi.fn((targets: ShotDraft[], batchId: string) => draft?.finishShotSubmission(targets, batchId))
  const page = defineComponent({ setup() {
    machine = useShotBatchMachine({ shots, inputsBusy: computed(() => inputsBusy.value), identityCard, aspectRatio, quality, steps, linkLastFrame, shotReferences: () => undefined, h3Ready: computed(() => true), online: computed(() => true), batchError: error, onAccepted: accepted, onSubmitted: submitted,
      onSubmitting: targets => draft?.beginShotSubmission(targets), onSubmissionRejected: targets => draft?.finishShotSubmission(targets) })
    if (persisted) draft = useShotDraft({ shots, identityCard, aspectRatio, quality, steps, linkLastFrame, batchError: error,
      referenceCards: ref([]), selectCardCharacter: async () => false, retryPendingFrames: async () => ({ fixed: 0, remaining: 0 }),
      getShotSubmission: machine.getShotSubmission, restoreShotSubmission: machine.restoreShotSubmission })
    return () => null
  } })
  wrapper = mount(cached ? defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(page) : null }) }) : page)
  machine.batch.value = batch()
  return { machine, error, shots, inputsBusy, active, accepted, submitted, draft }
}
beforeEach(() => { vi.clearAllMocks(); savedDraft.value = null; vi.useFakeTimers() })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })
describe('shot batch operation recovery', () => {
  it('does not submit a batch while reference cards or first frames are being prepared', async () => {
    const { machine, shots, inputsBusy, accepted, submitted } = setup()
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
    expect(submitted).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps row results and retries on submitted draft identities after reorder or deletion, without guessing historical matches', async () => {
    let { machine, shots, draft } = setup(false, true)
    shots.value = ['First shot description', 'Second shot description'].map(prompt => ({ prompt, seedText: '', dialogue: '' } as ShotDraft))
    const submitted = { ...batch('done'), shots: [{ status: 'failed', resultUrl: '/first.mp4' }, { status: 'failed', resultUrl: '/second.mp4' }] } as api.VideoBatch
    vi.mocked(api.createVideoBatch).mockResolvedValueOnce({ ok: true, batch: submitted })
    await machine.submitBatch()
    expect(machine.serverShot(0)?.resultUrl).toBe('/first.mp4')
    expect(savedDraft.value?.shots.map(shot => shot.submission)).toEqual([{ batchId: 'original', shotIndex: 0 }, { batchId: 'original', shotIndex: 1 }])
    shots.value.reverse()
    expect(machine.serverShot(0)?.resultUrl).toBe('/second.mp4')
    shots.value.splice(1, 1)
    draft!.persistShotsDraft()
    wrapper!.unmount()
    ;({ machine, shots, draft } = setup(false, true))
    await draft!.restoreShotsDraft()
    machine.batch.value = null
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ ok: true, batch: submitted })
    await machine.reconnectBatch('original')
    expect(machine.serverShot(0)?.resultUrl).toBe('/second.mp4')
    vi.mocked(api.retryVideoShot).mockResolvedValueOnce({ ok: true, batch: submitted })
    await machine.retryShotAt(0)
    expect(api.retryVideoShot).toHaveBeenCalledWith('original', 2)
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ ok: true, batch: { ...submitted, id: 'historical' } })
    const currentDraft = shots.value[0]
    await machine.reconnectBatch('historical')
    expect(shots.value[0]).toBe(currentDraft)
    expect(machine.batch.value).toHaveProperty('shots.0.resultUrl', '/first.mp4')
    expect(machine.serverShot(0)).toBeNull()
    await machine.retryShotAt(0)
    expect(api.retryVideoShot).toHaveBeenCalledTimes(1)
    vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ ok: true, batch: submitted })
    await machine.reconnectBatch('original')
    expect(machine.serverShot(0)?.resultUrl).toBe('/second.mp4')
    shots.value = shots.value.map(shot => ({ ...shot }))
    expect(machine.serverShot(0)).toBeNull()
    draft!.persistShotsDraft()
    expect(savedDraft.value?.shots[0].submission).toBeUndefined()
    await machine.retryShotAt(0)
    expect(api.retryVideoShot).toHaveBeenCalledTimes(1)
  })
  it.each([false, true])('archives a late submission after leaving without replacing a newer draft (%s)', async replaced => {
    let acknowledge!: (value: Awaited<ReturnType<typeof api.createVideoBatch>>) => void
    vi.mocked(api.createVideoBatch).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve }))
    const { machine, shots } = setup(false, true)
    shots.value = [{ prompt: 'A complete shot description', seedText: '', dialogue: '' } as ShotDraft]
    const pending = machine.submitBatch()
    wrapper!.unmount()
    const saved = savedDraft.value!
    if (replaced) savedDraft.value = { ...saved, identityCard: 'New workspace draft', shots: saved.shots.map(shot => ({ ...shot, submissionToken: undefined })) }
    const current = savedDraft.value
    const accepted = { ...batch('done'), id: 'accepted-after-leave' }
    acknowledge({ ok: true, batch: accepted }); await pending
    if (replaced) {
      expect(savedDraft.value).toBe(current)
      expect(savedDraft.value?.identityCard).toBe('New workspace draft')
      expect(savedDraft.value?.shots[0].submission).toBeUndefined()
    } else {
      expect(savedDraft.value?.shots[0].submission).toEqual({ batchId: accepted.id, shotIndex: 0 })
      const reopened = setup(false, true)
      await reopened.draft!.restoreShotsDraft()
      reopened.machine.batch.value = null
      vi.mocked(api.fetchVideoBatch).mockResolvedValueOnce({ ok: true, batch: accepted })
      await reopened.machine.reconnectBatch(accepted.id)
      expect(reopened.machine.serverShot(0)?.status).toBe('failed')
      vi.mocked(api.retryVideoShot).mockResolvedValueOnce({ ok: true, batch: accepted })
      await reopened.machine.retryShotAt(0)
      expect(api.retryVideoShot).toHaveBeenCalledWith(accepted.id, 1)
    }
  })
  it.each([false, true])('binds late acceptance to surviving reopened rows across autosave (%s)', async autosave => {
    let acknowledge!: (value: Awaited<ReturnType<typeof api.createVideoBatch>>) => void
    vi.mocked(api.createVideoBatch).mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve }))
    const original = setup(false, true)
    original.shots.value = ['First shot description', 'Second shot description', 'Third shot description']
      .map(prompt => ({ prompt, seedText: '', dialogue: '' } as ShotDraft))
    const pending = original.machine.submitBatch()
    wrapper!.unmount()
    const reopened = setup(false, true)
    await reopened.draft!.restoreShotsDraft()
    reopened.shots.value.reverse()
    const clone = { ...reopened.shots.value[1] }
    reopened.shots.value.splice(1, 1)
    reopened.shots.value.push(clone)
    reopened.shots.value[0].prompt = 'Edited surviving shot description'
    if (autosave) reopened.draft!.persistShotsDraft()
    const accepted = { ...batch('done'), id: 'accepted-after-reopen' }
    acknowledge({ ok: true, batch: accepted }); await pending
    reopened.draft!.persistShotsDraft()
    expect(savedDraft.value?.shots.map(shot => shot.submission)).toEqual([
      { batchId: accepted.id, shotIndex: 2 }, { batchId: accepted.id, shotIndex: 0 }, undefined,
    ])
    expect(savedDraft.value?.shots[0].prompt).toBe('Edited surviving shot description')
  })
  it('clears only failed submission tokens after reopening and retains known provenance', async () => {
    let reject!: (reason: Error) => void
    vi.mocked(api.createVideoBatch).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    const original = setup(false, true)
    original.shots.value = [{ prompt: 'A complete shot description', seedText: '', dialogue: '' } as ShotDraft]
    original.machine.restoreShotSubmission(original.shots.value[0], { batchId: 'known', shotIndex: 2 })
    const pending = original.machine.submitBatch()
    wrapper!.unmount()
    const reopened = setup(false, true)
    await reopened.draft!.restoreShotsDraft()
    reject(new Error('Submission failed')); await pending
    reopened.draft!.persistShotsDraft()
    expect(savedDraft.value?.shots[0].submissionToken).toBeUndefined()
    expect(savedDraft.value?.shots[0].submission).toEqual({ batchId: 'known', shotIndex: 2 })
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
    const retry = machine.retryAllFailed()
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
    expect(machine.serverShot(0)).toBeNull()
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
