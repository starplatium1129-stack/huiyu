import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ResourceLibraryPanel from '../components/ResourceLibraryPanel.vue'
import { resourceApi } from '../api/resourceApi'
import { ApiClientError } from '../api/client'
import { useResourceLibrary } from './useResourceLibrary'
import type { ResourceApi } from '../api/resourceApi'
import type { ResourceStatus, ResourceTask } from '../../types/resources'

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
  it('renders the current-file stage and progress without implying overall completion', async () => {
    vi.spyOn(resourceApi, 'status').mockResolvedValue(status({ busy: true,
      task: { ...task, action: 'download', phase: 'download-progress', bytes: 1024, total: 2048 } }))
    const panel = mount(ResourceLibraryPanel, { global: { stubs: { ArchiveIcon: true, StudioSelect: true, StudioTooltip: true } } })
    try {
      await flushPromises()
      expect(panel.text()).toContain('正在下载资源')
      expect(panel.text()).toContain('下载当前文件：1.0 KiB / 2.0 KiB（单文件进度）')
      expect(panel.get('progress').attributes('value')).toBe('1024')
      expect(panel.get('progress').attributes('max')).toBe('2048')
    } finally { panel.unmount() }
  })
  it('distinguishes download completion from installation and resumed actions', async () => {
    const calls = api(); const model = useResourceLibrary(calls, true)
    vi.mocked(calls.status).mockResolvedValue(status({ task: { ...task, action: 'recover', resumeAction: 'download', state: 'completed' } }))
    await model.refresh()
    expect(model.taskMessage.value).toBe('资源下载已完成，请安装该版本后使用')
    expect(model.taskDetail.value).toBe('')
    vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task: { ...task, action: 'download', phase: 'download-progress', bytes: 1024 ** 2, total: 2 * 1024 ** 2 } }))
    await model.refresh()
    expect(model.taskMessage.value).toBe('正在下载资源')
    expect(model.taskDetail.value).toBe('下载当前文件：1.0 MiB / 2.0 MiB（单文件进度）')
    vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task: { ...task, phase: 'staged', bytes: 0, total: 0 } }))
    await model.refresh()
    expect(model.taskMessage.value).toBe('正在安装资源')
    expect(model.taskDetail.value).toBe('正在校验并准备切换版本')
    model.stop()
  })
  it('shows the restored version and recovery reason while keeping completion successful', async () => {
    const warning = { code: 'CONTENT_INVALID', message: '新版本资源内容校验失败。' }
    vi.spyOn(resourceApi, 'status').mockResolvedValue(status({ mounted: true,
      task: { ...task, action: 'recover', state: 'completed', result: { action: 'rolled-back', warning } } }))
    const panel = mount(ResourceLibraryPanel, { global: { stubs: { ArchiveIcon: true, StudioSelect: true, StudioTooltip: true } } })
    try {
      await flushPromises()
      expect(panel.text()).toContain('已恢复上一版本')
      expect(panel.text()).toContain(warning.message)
      expect(panel.text()).not.toContain('资源操作已完成')
      expect(panel.find('.resource-task-error').exists()).toBe(false)
      expect(panel.find('progress').exists()).toBe(false)
    } finally { panel.unmount() }
  })
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
  it('keeps an explicit start rejection visible across idle polls until a fresh check', async () => {
    const calls = api(), model = useResourceLibrary(calls, true)
    const reason = '资源操作未通过检查，请核对本地配置与资源包。'
    try {
      await model.refresh()
      vi.mocked(calls.start).mockRejectedValueOnce(new ApiClientError(reason, { kind: 'http', status: 403, code: 'RESOURCE_FAILED' }))
      await model.run('import')
      expect(model.error.value).toBe(reason)
      expect(model.status.value?.task).toBeNull()
      await model.refresh()
      expect(model.error.value).toBe(reason)
      expect(model.enabled.value).toBe(false)
      expect(calls.start).toHaveBeenCalledOnce()
      await model.refresh(true)
      expect(model.error.value).toBe('')
      expect(model.enabled.value).toBe(true)
    } finally { model.stop() }
  })
  it('reconciles a lost start response without retrying the operation', async () => {
    const calls = api(); const model = useResourceLibrary(calls, true); await model.refresh()
    vi.mocked(calls.start).mockRejectedValue(new Error('response lost'))
    vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
    await model.run('import')
    expect(calls.start).toHaveBeenCalledOnce(); expect(model.status.value?.task?.id).toBe(task.id)
    expect(model.error.value).toBe(''); model.stop()
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
  it('retains uncertain cancellation across running status reads until a retry is observed cancelling', async () => {
    const calls = api(); vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
    vi.mocked(calls.cancel).mockRejectedValueOnce(new Error('permission changed'))
    const model = useResourceLibrary(calls, true)
    try {
      await model.refresh(); await model.cancel()
      expect(model.error.value).toContain('取消尚未确认')
      expect(model.status.value?.task?.state).toBe('running')
      await model.refresh(true)
      expect(model.error.value).toContain('取消尚未确认')
      vi.mocked(calls.status).mockRejectedValueOnce(new Error('offline'))
      await model.refresh()
      expect(model.error.value).toContain('取消尚未确认')
      await model.refresh()
      expect(model.error.value).toContain('取消尚未确认')
      vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task: { ...task, state: 'cancelling' } }))
      await model.cancel()
      expect(calls.cancel).toHaveBeenCalledTimes(2)
      expect(model.status.value?.task?.state).toBe('cancelling')
      expect(model.error.value).toBe('')
    } finally { model.stop() }
  })
  it.each(['completed', 'replaced'] as const)('drops an uncertain cancellation only after its task is %s', async state => {
    const calls = api(); vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
    vi.mocked(calls.cancel).mockRejectedValueOnce(new Error('response lost'))
    const model = useResourceLibrary(calls, true)
    try {
      await model.refresh(); await model.cancel()
      expect(model.error.value).toContain('取消尚未确认')
      vi.mocked(calls.status).mockResolvedValue(status({ busy: state === 'replaced', task: state === 'replaced' ? { ...task, id: 'next-task' } : { ...task, state: 'completed' } }))
      await model.refresh()
      expect(model.error.value).toBe('')
    } finally { model.stop() }
  })
  it('unmount stops polling but does not cancel a server resource operation', async () => {
    vi.useFakeTimers(); const calls = api(); const model = useResourceLibrary(calls, true)
    await model.refresh(); model.stop(); await vi.advanceTimersByTimeAsync(30000)
    expect(calls.status).toHaveBeenCalledOnce(); expect(calls.cancel).not.toHaveBeenCalled()
  })
  it('pauses hidden polling without interrupting an accepted command and refreshes on return', async () => {
    vi.useFakeTimers()
    let hidden = false
    const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
    const calls = api(); const model = useResourceLibrary(calls, true)
    try {
      model.start(); await vi.advanceTimersByTimeAsync(0)
      let accept!: (value: { ok: true; task: ResourceTask }) => void
      vi.mocked(calls.start).mockImplementationOnce(() => new Promise(resolve => { accept = resolve }))
      const pending = model.run('import')
      const signal = vi.mocked(calls.start).mock.calls[0]![2]!
      hidden = true; document.dispatchEvent(new Event('visibilitychange'))
      expect(signal.aborted).toBe(false)
      vi.mocked(calls.status).mockResolvedValue(status({ busy: true, task }))
      accept({ ok: true, task }); await pending
      expect(model.status.value?.task?.id).toBe(task.id)
      const reads = vi.mocked(calls.status).mock.calls.length
      await vi.advanceTimersByTimeAsync(30000)
      expect(calls.status).toHaveBeenCalledTimes(reads)
      hidden = false; document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(750)
      expect(calls.status).toHaveBeenCalledTimes(reads + 2)
      model.stop()
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls.status).toHaveBeenCalledTimes(reads + 2)
      expect(calls.cancel).not.toHaveBeenCalled()
    } finally { model.stop(); visibility.mockRestore() }
  })
  it('failed status prevents unsafe action until the next successful refresh', async () => {
    const calls = api(); const model = useResourceLibrary(calls, true); await model.refresh()
    vi.mocked(calls.status).mockRejectedValueOnce(new Error('offline')); await model.refresh()
    expect(model.enabled.value).toBe(false); await model.run('import'); expect(calls.start).not.toHaveBeenCalled()
    await model.refresh(); expect(model.enabled.value).toBe(true); model.stop()
  })
})
