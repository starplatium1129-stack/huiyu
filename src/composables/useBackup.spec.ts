import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, effectScope, h, KeepAlive, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import * as backupActions from '@/platform/desktop/backupActions'
import { restoreBackupData } from '@/storage/backupRestore'
import { useBackup } from './useBackup'
import { imgList, imgDeleteMany } from './useImageStore'
import { downloadBlob } from '@/utils/downloadBlob'
import { MAX_BACKUP_BYTES } from '@/utils/backupExport'
import { BACKUP_AT_KEY, ARTWORK_HISTORY_KV_KEY } from '@/utils/storageKeys'
import { withArtworkCleanup } from '@/storage/artworkSession'
import { kvGet } from './useKVStore'
import { confirmAction } from '@/composables/useConfirm'
import { ARTWORK_TRASH_KV_KEY, ARTWORK_PROJECTS_KV_KEY, VIDEO_DRAFT_KEY } from '@/utils/storageKeys'
// 覆盖恢复与孤儿清理的确认走项目自己的确认弹窗（原生 confirm 已收编）。
vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn(async () => true) }))
vi.mock('./useImageStore', () => ({ imgList: vi.fn(), imgGet: vi.fn(), imgDeleteMany: vi.fn(), imgPutRecord: vi.fn() }))
vi.mock('./useKVStore', () => ({ kvGet: vi.fn(), kvSetMany: vi.fn() }))
vi.mock('@/storage/backupRestore', () => ({ restoreBackupData: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { readHistory: vi.fn(), getImage: vi.fn() } }))
vi.mock('@/storage/artworkMutation', () => ({ withArtworkMutation: (work: () => Promise<unknown>) => work() }))
vi.mock('@/storage/artworkSession', () => ({ withArtworkCleanup: vi.fn((work: () => Promise<unknown>) => work()), assertArtworkCleanupCurrent: vi.fn(), readArtworkCleanupImageReferences: vi.fn(() => []) }))
vi.mock('@/utils/downloadBlob', () => ({ downloadBlob: vi.fn() }))
const contents = JSON.stringify({ history: [{ id: 'one' }] })
beforeEach(() => { vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => unknown) => work() } }); vi.clearAllMocks(); vi.mocked(confirmAction).mockResolvedValue(true); sessionStorage.clear(); localStorage.clear(); vi.mocked(kvGet).mockImplementation(async key => key === 'chat_archive_v1' ? null : [] as never) })
afterEach(() => vi.unstubAllGlobals())
describe('backup selection and cleanup', () => {
  it('does not restore a previous backup after selecting an oversized file', async () => {
    const tool = useBackup()
    await tool.loadFile(new File([contents], 'valid.json'))
    expect(tool.pending.value).not.toBeNull()
    await tool.loadFile({ size: 513 * 1024 * 1024 } as File)
    expect(tool.pending.value).toBeNull()
    expect(tool.pendingName.value).toBe('')
  })
  it('ignores an old file read that completes after a newer selection', async () => {
    let resolve!: (value: string) => void
    const tool = useBackup()
    const pending = tool.loadFile({ name: 'old.json', size: 1, text: () => new Promise(done => { resolve = done }) } as File)
    await tool.loadFile(new File([contents], 'new.json'))
    resolve(contents); await pending
    expect(tool.pendingName.value).toBe('new.json')
  })
  it('binds replacement approval to the selected file and leaves preview cancellation usable', async () => {
    const tool = useBackup()
    await tool.loadFile(new File([contents], 'first.json'))
    let approve!: (value: boolean) => void
    vi.mocked(confirmAction).mockImplementationOnce(() => new Promise(resolve => { approve = resolve }))
    const restoring = tool.restore('replace')
    const signal = (vi.mocked(confirmAction).mock.calls[0]![0] as { signal: AbortSignal }).signal
    expect(await tool.restore('replace')).toBe(false)
    tool.discard()
    expect(signal.aborted).toBe(true)
    await tool.loadFile(new File([contents], 'second.json'))
    approve(true)
    expect(await restoring).toBe(false)
    expect(restoreBackupData).not.toHaveBeenCalled()
    expect(tool.pendingName.value).toBe('second.json')
    expect(tool.busy.value).toBe(false)
  })
  it('clears cached preview ownership and rejects late approval after return', async () => {
    const active = ref(true)
    let tool!: ReturnType<typeof useBackup>
    const Page = defineComponent({ setup() { tool = useBackup(); return () => h('div') } })
    const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Page) : null }) }))
    try {
      await tool.loadFile(new File([contents], 'first.json'))
      let approve!: (value: boolean) => void
      vi.mocked(confirmAction).mockImplementationOnce(() => new Promise(resolve => { approve = resolve }))
      const restoring = tool.restore('replace')
      active.value = false; await nextTick()
      expect(tool.pending.value).toBeNull()
      active.value = true; await nextTick()
      await tool.loadFile(new File([contents], 'second.json'))
      approve(true); expect(await restoring).toBe(false)
      expect(restoreBackupData).not.toHaveBeenCalled()
      let read!: (value: string) => void
      const loading = tool.loadFile({ name: 'late.json', size: 1, text: () => new Promise(resolve => { read = resolve }) } as File)
      wrapper.unmount()
      read(contents); await loading
      expect(tool.pending.value).toBeNull()
      expect(await tool.restore('merge')).toBe(false)
    } finally { if (wrapper.exists()) wrapper.unmount() }
  })
  it('lets an accepted exact snapshot finish after its owner unmounts', async () => {
    vi.useFakeTimers()
    let tool!: ReturnType<typeof useBackup>
    const wrapper = mount(defineComponent({ setup() { tool = useBackup(); return () => null } }))
    let complete!: () => void
    vi.mocked(restoreBackupData).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    try {
      await tool.loadFile(new File([contents], 'accepted.json'))
      const selected = tool.pending.value
      const restoring = tool.restore('merge')
      expect(restoreBackupData).toHaveBeenCalledWith(selected, false)
      wrapper.unmount()
      complete()
      expect(await restoring).toBe(true)
      expect(tool.pending.value).toBeNull()
      expect(tool.busy.value).toBe(false)
    } finally { vi.clearAllTimers(); vi.useRealTimers() }
  })
  it('rejects orphan cleanup approval from an earlier cached-page visit', async () => {
    const active = ref(true)
    const flash = vi.fn()
    let tool!: ReturnType<typeof useBackup>
    const Page = defineComponent({ setup() { tool = useBackup(flash); return () => h('div') } })
    const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Page) : null }) }))
    vi.mocked(imgList).mockResolvedValue([{ id: 'orphan' }] as Awaited<ReturnType<typeof imgList>>)
    let approve!: (value: boolean) => void
    vi.mocked(confirmAction).mockImplementationOnce(() => new Promise(resolve => { approve = resolve }))
    try {
      const cleaning = tool.cleanOrphanImages()
      await flushPromises()
      const signal = (vi.mocked(confirmAction).mock.calls[0]![0] as { signal: AbortSignal }).signal
      active.value = false; await nextTick()
      expect(signal.aborted).toBe(true)
      active.value = true; await nextTick()
      approve(true)
      expect(await cleaning).toBe(0)
      expect(imgDeleteMany).not.toHaveBeenCalled()
      expect(flash).not.toHaveBeenCalled()
      expect(tool.busy.value).toBe(false)
      expect(await tool.cleanOrphanImages()).toBe(1)
      expect(imgDeleteMany).toHaveBeenCalledWith(['orphan'])
    } finally { wrapper.unmount() }
  })
  it('protects project, trash and video-draft images during cleanup', async () => {
    vi.mocked(kvGet).mockImplementation(async key => key === ARTWORK_TRASH_KV_KEY ? [{ imageIds: ['trash'] }] : key === ARTWORK_PROJECTS_KV_KEY ? [{ imageId: 'project' }] : [])
    vi.mocked(imgList).mockResolvedValue(['trash', 'project', 'video', 'orphan'].map(id => ({ id })) as Awaited<ReturnType<typeof imgList>>)
    sessionStorage.setItem(VIDEO_DRAFT_KEY, JSON.stringify({ videoImageId: 'video' }))
    const tool = useBackup()
    expect(await tool.cleanOrphanImages()).toBe(1)
    expect(confirmAction).toHaveBeenCalledTimes(1)
    expect(imgDeleteMany).toHaveBeenCalledWith(['orphan'])
    expect(tool.busy.value).toBe(false)
  })
  it('stops cleanup when a draft cannot be read', async () => {
    vi.mocked(imgList).mockResolvedValue([{ id: 'protected' }] as Awaited<ReturnType<typeof imgList>>)
    sessionStorage.setItem(VIDEO_DRAFT_KEY, '{invalid')
    const flash = vi.fn(), tool = useBackup(flash)
    expect(await tool.cleanOrphanImages()).toBe(0)
    expect(imgDeleteMany).not.toHaveBeenCalled()
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('停止清理'))
  })
})


describe('backup safety regressions', () => {
  it('rescans after confirmation and protects a newly published history reference', async () => {
    const stored = new Map<string, unknown>()
    vi.mocked(kvGet).mockImplementation(async key => stored.get(key) as never ?? [])
    vi.mocked(imgList).mockResolvedValue([{ id: 'racing' }] as Awaited<ReturnType<typeof imgList>>)
    vi.mocked(confirmAction).mockImplementation(async () => { stored.set(ARTWORK_HISTORY_KV_KEY, [{ image_id: 'racing' }]); return true })
    expect(await useBackup().cleanOrphanImages()).toBe(0)
    expect(withArtworkCleanup).toHaveBeenCalledTimes(1)
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('never extends the approved deletion set with images created after confirmation', async () => {
    vi.mocked(imgList).mockResolvedValueOnce([{ id: 'old' }] as Awaited<ReturnType<typeof imgList>>)
      .mockResolvedValueOnce([{ id: 'old' }, { id: 'new' }] as Awaited<ReturnType<typeof imgList>>)
    vi.mocked(confirmAction).mockResolvedValue(true)
    expect(await useBackup().cleanOrphanImages()).toBe(1)
    expect(imgDeleteMany).toHaveBeenCalledWith(['old'])
  })
  it('protects local drafts as well as session drafts', async () => {
    localStorage.setItem('aics_pb_last_draft', JSON.stringify({ imageId: 'draft' }))
    vi.mocked(imgList).mockResolvedValue([{ id: 'draft' }] as Awaited<ReturnType<typeof imgList>>)
    expect(await useBackup().cleanOrphanImages()).toBe(0)
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('protects legacy local metadata until migration finishes', async () => {
    localStorage.setItem(ARTWORK_HISTORY_KV_KEY, JSON.stringify([{ id: 'old', image_id: 'legacy-image' }]))
    vi.mocked(imgList).mockResolvedValue([{ id: 'legacy-image' }] as Awaited<ReturnType<typeof imgList>>)
    expect(await useBackup().cleanOrphanImages()).toBe(0)
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('does not delete when registered local draft JSON is malformed', async () => {
    localStorage.setItem('aics_pb_last_draft', '{broken')
    vi.mocked(imgList).mockResolvedValue([{ id: 'keep' }] as Awaited<ReturnType<typeof imgList>>)
    expect(await useBackup().cleanOrphanImages()).toBe(0)
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('fails closed when exclusive cleanup access cannot be acquired', async () => {
    vi.mocked(imgList).mockResolvedValue([{ id: 'draft' }] as Awaited<ReturnType<typeof imgList>>)
    vi.mocked(withArtworkCleanup).mockRejectedValueOnce(new Error('other window'))
    const flash = vi.fn(), tool = useBackup(flash)
    expect(await tool.cleanOrphanImages()).toBe(0)
    expect(imgDeleteMany).not.toHaveBeenCalled()
    expect(tool.busy.value).toBe(false)
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('other window'))
  })
  it('leaves images untouched on cancellation or failure of the second scan', async () => {
    vi.mocked(imgList).mockResolvedValue([{ id: 'old' }] as Awaited<ReturnType<typeof imgList>>)
    vi.mocked(confirmAction).mockResolvedValueOnce(false)
    expect(await useBackup().cleanOrphanImages()).toBe(0)
    expect(withArtworkCleanup).not.toHaveBeenCalled()
    vi.mocked(imgList).mockResolvedValueOnce([{ id: 'old' }] as Awaited<ReturnType<typeof imgList>>).mockRejectedValueOnce(new Error('read failed'))
    expect(await useBackup().cleanOrphanImages()).toBe(0)
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('does not download or update the backup timestamp on oversize export', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    Object.defineProperty(blob, 'size', { value: MAX_BACKUP_BYTES })
    vi.mocked(imgList).mockResolvedValue([{ id: 'large', blob }] as Awaited<ReturnType<typeof imgList>>)
    localStorage.setItem(BACKUP_AT_KEY, '123')
    const flash = vi.fn(), tool = useBackup(flash)
    await tool.exportBackup()
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(localStorage.getItem(BACKUP_AT_KEY)).toBe('123')
    expect(tool.busy.value).toBe(false)
    expect(tool.exportProgress.value).toBeNull()
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('512 MB'))
  })
  it('aborts a disposed backup export and rejects a late native receipt without downloading', async () => {
    const desktop = vi.spyOn(backupActions, 'workspaceBackupActive').mockReturnValue(true)
    let receipt!: (value: backupActions.WorkspaceBackupReceipt) => void
    const create = vi.spyOn(backupActions, 'createWorkspaceBackup').mockImplementation(() => new Promise(resolve => { receipt = resolve }))
    const scope = effectScope()
    const flash = vi.fn()
    const tool = scope.run(() => useBackup(flash))!
    try {
      const exporting = tool.exportBackup()
      const signal = create.mock.calls[0]![0]!
      scope.stop()
      expect(signal.aborted).toBe(true)
      receipt({ format: 'huiyu-workspace-backup-receipt', version: 1, workspaceId: 'workspace', backupId: 'backup', createdAt: '', revision: 1, mediaCount: 0 })
      await exporting
      expect(downloadBlob).not.toHaveBeenCalled()
      expect(tool.lastBackupAt.value).toBe(0)
      expect(flash).toHaveBeenCalledTimes(1)
      await tool.exportBackup()
      expect(create).toHaveBeenCalledOnce()
    } finally { scope.stop(); create.mockRestore(); desktop.mockRestore() }
  })
  it('supports cancelling export without touching existing records or timestamps', async () => {
    vi.mocked(imgList).mockResolvedValue([])
    const flash = vi.fn(), tool = useBackup(flash)
    const running = tool.exportBackup()
    tool.cancelExport()
    await running
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(localStorage.getItem(BACKUP_AT_KEY)).toBeNull()
    expect(tool.busy.value).toBe(false)
    expect(flash).toHaveBeenCalledWith(expect.stringContaining('已取消备份'))
  })
  it('downloads an importable complete file on success', async () => {
    vi.mocked(kvGet).mockImplementation(async key => key === 'chat_archive_v1' ? null : [{ id: 'one' }] as never)
    vi.mocked(imgList).mockResolvedValue([{ id: 'image', blob: new Blob(['a'], { type: 'image/png' }) }] as Awaited<ReturnType<typeof imgList>>)
    const tool = useBackup()
    await tool.exportBackup()
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob] = vi.mocked(downloadBlob).mock.calls[0]
    expect(await tool.loadFile(new File([blob], 'round-trip.json'))).toMatchObject({ images: 1, history: 1 })
    expect(tool.lastBackupAt.value).toBeGreaterThan(0)
  })
  it('exports unavailable character archives from IndexedDB and stops on archive read errors', async () => {
    const archive = { version: 1, archived: { unavailable_private_model: [{ mid: 'private', role: 'user', content: 'kept', stopped: false }] } }
    vi.mocked(kvGet).mockImplementation(async key => (key === 'chat_archive_v1' ? archive : []) as never)
    vi.mocked(imgList).mockResolvedValue([])
    const tool = useBackup()
    await tool.exportBackup()
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob] = vi.mocked(downloadBlob).mock.calls[0]
    expect(await blob.text()).toContain('unavailable_private_model')
    vi.mocked(downloadBlob).mockClear()
    vi.mocked(kvGet).mockImplementation(async key => { if (key === 'chat_archive_v1') throw Error('database offline'); return [] as never })
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    await tool.exportBackup()
    expect(downloadBlob).not.toHaveBeenCalled()
    warning.mockRestore()
  })
})
