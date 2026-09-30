import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { useBackup } from './useBackup'
import { readWebBackupImages, readWebBackupImage } from '@/platform/web/profileBackupSource'

vi.mock('@/platform/web/profileBackupSource', () => ({ readWebBackupImages: vi.fn(), readWebBackupImage: vi.fn() }))
const mode = vi.hoisted(() => ({ desktop: false }))
vi.mock('@/platform/desktop/backupActions', () => ({ workspaceBackupActive: () => mode.desktop }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { readHistory: vi.fn(), getImage: vi.fn() } }))
vi.mock('@/platform/desktop/runtime', () => ({ onDesktopRuntime: () => () => {} }))
vi.mock('@/platform/maintenanceParticipants', () => ({ registerMaintenanceParticipant: () => () => {} }))

const scopes: ReturnType<typeof effectScope>[] = []
function setup() {
  const scope = effectScope()
  scopes.push(scope)
  const flash = vi.fn()
  const tool = scope.run(() => useBackup(flash))!
  return { scope, flash, tool }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const records = ['one', 'two'].map(id => ({ id, name: 'Neutral image', created_at: 1 })) as Awaited<ReturnType<typeof readWebBackupImages>>
let click: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.resetAllMocks()
  mode.desktop = false
  vi.useFakeTimers()
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:neutral'), revokeObjectURL: vi.fn() })
  click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  vi.mocked(readWebBackupImages).mockResolvedValue(records)
  vi.mocked(readWebBackupImage).mockResolvedValue(new Blob(['neutral'], { type: 'image/png' }))
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('original image export lifecycle', () => {
  it('stops after cancel during a delayed read, without starting downloads or later reads', async () => {
    const image = deferred<Blob>()
    vi.mocked(readWebBackupImage).mockReturnValueOnce(image.promise)
    const { tool } = setup()
    const running = tool.exportImages()
    await vi.waitFor(() => expect(readWebBackupImage).toHaveBeenCalledTimes(1))
    tool.cancelExport()
    image.resolve(new Blob(['neutral']))
    await running
    expect(click).not.toHaveBeenCalled()
    expect(readWebBackupImage).toHaveBeenCalledTimes(1)
    expect(tool.busy.value).toBe(false)
  })
  it('releases a URL when creating the download anchor throws', async () => {
    vi.mocked(readWebBackupImages).mockResolvedValue(records.slice(0, 1))
    vi.spyOn(document, 'createElement').mockImplementationOnce(() => { throw Error('anchor unavailable') })
    const { tool } = setup()
    const running = tool.exportImages()
    await vi.runAllTimersAsync()
    await running
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:neutral')
  })
  it('exposes separate image progress while listing and cancels before any image read', async () => {
    const listing = deferred<typeof records>()
    vi.mocked(readWebBackupImages).mockReturnValueOnce(listing.promise)
    const { tool, flash } = setup()
    const running = tool.exportImages()
    expect(tool.imageExportProgress.value).toEqual({ completed: 0, total: 0 })
    expect(tool.exportProgress.value).toBeNull()
    tool.cancelExport()
    listing.resolve(records)
    await running
    expect(readWebBackupImage).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    expect(tool.imageExportProgress.value).toBeNull()
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('已停止后续导出'))
  })
  it('yields between inline blobs, rejects reentry, and reports started downloads honestly', async () => {
    vi.mocked(readWebBackupImages).mockResolvedValue(records.map(record => ({ ...record, blob: new Blob(['neutral']) })))
    const { tool, flash } = setup()
    const running = tool.exportImages()
    await Promise.resolve()
    expect(click).toHaveBeenCalledTimes(1)
    expect(tool.imageExportProgress.value).toEqual({ completed: 1, total: 2 })
    await tool.exportImages()
    expect(readWebBackupImages).toHaveBeenCalledTimes(1)
    tool.cancelExport()
    await vi.runAllTimersAsync()
    await running
    expect(click).toHaveBeenCalledTimes(1)
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('已开始下载 1 张'))
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('无法撤销'))
    expect(tool.busy.value).toBe(false)
  })
  it('stops a desktop late read on disposal without a stale completion notification', async () => {
    mode.desktop = true
    vi.mocked(artworkRepository.readHistory).mockResolvedValue(records.map(record => ({ id: record.id, image_id: record.id })) as Awaited<ReturnType<typeof artworkRepository.readHistory>>)
    const image = deferred<Blob>()
    vi.mocked(artworkRepository.getImage).mockReturnValueOnce(image.promise)
    const { tool, scope, flash } = setup()
    const running = tool.exportImages()
    await vi.waitFor(() => expect(artworkRepository.getImage).toHaveBeenCalledTimes(1))
    scope.stop()
    image.resolve(new Blob(['neutral']))
    await running
    expect(artworkRepository.getImage).toHaveBeenCalledTimes(1)
    expect(click).not.toHaveBeenCalled()
    expect(flash).toHaveBeenCalledTimes(1)
    expect(tool.imageExportProgress.value).toBeNull()
    await tool.exportImages()
    expect(artworkRepository.readHistory).toHaveBeenCalledTimes(1)
  })
  it('releases successful download URLs and timers when the scope is disposed', async () => {
    vi.mocked(readWebBackupImages).mockResolvedValue(records.slice(0, 1))
    const { tool, scope } = setup()
    await tool.exportImages()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    scope.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:neutral')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases successful URLs once after the download grace period', async () => {
    vi.mocked(readWebBackupImages).mockResolvedValue(records.slice(0, 1))
    const { tool, scope } = setup()
    await tool.exportImages()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:neutral')
    scope.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  })
  it('removes the anchor and immediately releases its URL if clicking throws', async () => {
    vi.mocked(readWebBackupImages).mockResolvedValue(records.slice(0, 1))
    click.mockImplementationOnce(() => { throw Error('blocked') })
    const { tool, flash } = setup()
    await tool.exportImages()
    expect(document.querySelector('a[download]')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:neutral')
    expect(vi.getTimerCount()).toBe(0)
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('1 张读取或下载失败'))
  })

})
