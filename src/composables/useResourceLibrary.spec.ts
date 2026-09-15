import { afterEach, describe, expect, it, vi } from 'vitest'
import { useResourceLibrary } from './useResourceLibrary'
import type { ResourceApi } from '../api/resourceApi'
import type { ResourceStatus, ResourceTask } from '../types/resources'

const task: ResourceTask = { id: 'e58ce240-61d8-4a71-a496-bcbd4e74a7d5', action: 'import', releaseId: 'portrait',
  resumeAction: null, state: 'running', phase: 'copy-progress', bytes: 5, total: 10, startedAt: 1, finishedAt: 0, error: null }
function status(extra: Partial<ResourceStatus> = {}): ResourceStatus {
  return { ok: true, configured: true, managementEnabled: true, busy: false, mounted: false, current: null,
    canRollback: false, recoveryRequired: false, issue: null, task: null,
    releases: [{ id: 'portrait', label: '角色图片', identity: 'a'.repeat(64), kind: 'full', source: 'offline', downloaded: false }], ...extra }
}
function api(): ResourceApi {
  return { status: vi.fn().mockResolvedValue(status()), start: vi.fn().mockResolvedValue({ ok: true, task }),
    cancel: vi.fn().mockResolvedValue({ ok: true, task: { ...task, state: 'cancelling' } }) }
}
afterEach(() => vi.useRealTimers())

describe('resource library interaction', () => {
  it('never fetches, downloads or writes on remote hosts', async () => {
    const calls = api(); const model = useResourceLibrary(calls, false)
    model.start(); await model.refresh(); await model.run('download'); await model.cancel(); model.stop()
    expect(calls.status).not.toHaveBeenCalled(); expect(calls.start).not.toHaveBeenCalled(); expect(calls.cancel).not.toHaveBeenCalled()
  })
  it('coalesces status refresh while a slow request is pending', async () => {
    vi.useFakeTimers()
    const calls = api(); let resolve!: (value: ResourceStatus) => void
    calls.status = vi.fn(() => new Promise<ResourceStatus>(done => { resolve = done }))
    const model = useResourceLibrary(calls, true)
    model.start(); await vi.advanceTimersByTimeAsync(10000); void model.refresh(true)
    expect(calls.status).toHaveBeenCalledOnce()
    resolve(status()); await vi.advanceTimersByTimeAsync(0)
    expect(model.selectedId.value).toBe('portrait'); expect(model.canImport.value).toBe(true)
    model.stop()
  })
  it('requires downloaded HTTP content before enabling import', async () => {
    const calls = api(); const value = status()
    value.releases[0]!.source = 'http'; vi.mocked(calls.status).mockResolvedValue(value)
    const model = useResourceLibrary(calls, true); await model.refresh()
    expect(model.canDownload.value).toBe(true); expect(model.canImport.value).toBe(false)
    await model.run('import'); expect(calls.start).not.toHaveBeenCalled()
    value.releases[0]!.downloaded = true
    vi.mocked(calls.status).mockResolvedValue(structuredClone(value)); await model.refresh()
    expect(model.canImport.value).toBe(true); model.stop()
  })
  it('does not overwrite a newly accepted task with a late pre-action status', async () => {
    const calls = api(); const model = useResourceLibrary(calls, true)
    await model.refresh()
    let old!: (value: ResourceStatus) => void
    vi.mocked(calls.status).mockImplementationOnce(() => new Promise(done => { old = done }))
    const pending = model.refresh()
    vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
    await model.run('import'); old(status()); await pending
    expect(model.status.value?.task?.id).toBe(task.id); expect(model.busy.value).toBe(true); model.stop()
  })
  it('reconciles a lost start response without retrying the operation', async () => {
    const calls = api(); const model = useResourceLibrary(calls, true); await model.refresh()
    vi.mocked(calls.start).mockRejectedValue(new Error('response lost'))
    vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
    await model.run('import')
    expect(calls.start).toHaveBeenCalledOnce(); expect(model.status.value?.task?.id).toBe(task.id); model.stop()
  })
  it('cancels the exact active task and ignores a concurrent old poll', async () => {
    const calls = api(); vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
    const model = useResourceLibrary(calls, true); await model.refresh()
    let old!: (value: ResourceStatus) => void
    vi.mocked(calls.status).mockImplementationOnce(() => new Promise(done => { old = done }))
    const pending = model.refresh()
    vi.mocked(calls.status).mockResolvedValue(status({ busy: false, recoveryRequired: true, task: { ...task, state: 'cancelled' } }))
    await model.cancel(); old(status({ busy: true, task })); await pending
    expect(calls.cancel).toHaveBeenCalledWith(task.id, expect.any(AbortSignal))
    expect(model.status.value?.task?.state).toBe('cancelled'); model.stop()
  })
  it('unmount stops polling but does not cancel a server resource operation', async () => {
    vi.useFakeTimers(); const calls = api(); const model = useResourceLibrary(calls, true)
    await model.refresh(); model.stop(); await vi.advanceTimersByTimeAsync(30000)
    expect(calls.status).toHaveBeenCalledOnce(); expect(calls.cancel).not.toHaveBeenCalled()
  })
  it('failed status prevents unsafe action until the next successful refresh', async () => {
    const calls = api(); const model = useResourceLibrary(calls, true); await model.refresh()
    vi.mocked(calls.status).mockRejectedValueOnce(new Error('offline')); await model.refresh()
    expect(model.enabled.value).toBe(false); await model.run('import'); expect(calls.start).not.toHaveBeenCalled()
    await model.refresh(); expect(model.enabled.value).toBe(true); model.stop()
  })
})
