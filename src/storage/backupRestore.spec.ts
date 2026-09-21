import { beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreBackupData } from './backupRestore'
import { imgPutRecord, imgDeleteMany } from '@/composables/useImageStore'
import { kvGet, kvSetMany } from '@/composables/useKVStore'
import { normalizeBackup, type BackupFile } from '@/utils/backupCore'
import { CHAT_ARCHIVE_KEY } from '@/utils/chatArchive'
import { CHAT_MEMORY_KEY } from '@/utils/storageKeys'

vi.mock('@/composables/useImageStore', () => ({ imgPutRecord: vi.fn(), imgDeleteMany: vi.fn() }))
vi.mock('@/composables/useKVStore', () => ({ kvGet: vi.fn(), kvSetMany: vi.fn() }))
vi.mock('./artworkMutation', () => ({ withArtworkMutation: (work: () => Promise<unknown>) => work() }))
const backup = (): BackupFile => normalizeBackup({
  data: { history: [{ id: 'incoming', image_id: 'shared' }], projects: [{ id: 'project', imageId: 'shared' }], settings: { aics_theme: 'light' } },
  images: [{ id: 'shared', dataUrl: 'data:image/png;base64,YQ==' }],
})
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => unknown) => work() } })
  localStorage.setItem('aics_theme', 'dark')
  vi.mocked(imgPutRecord).mockImplementation(async record => record.id)
  vi.mocked(imgDeleteMany).mockResolvedValue()
  vi.mocked(kvGet).mockImplementation(async key => key === 'chat_archive_v1' ? null : [{ id: 'existing', image_id: 'shared' }] as never)
  vi.mocked(kvSetMany).mockResolvedValue()
})
describe('backup restore publication', () => {
  it('stages fresh image identities and remaps references without deleting existing originals', async () => {
    await restoreBackupData(backup(), true)
    const staged = vi.mocked(imgPutRecord).mock.calls[0][0]
    expect(staged.id).not.toBe('shared')
    const entries = vi.mocked(kvSetMany).mock.calls[0][0]
    expect(entries[0].value).toEqual([{ id: 'incoming', image_id: staged.id }])
    expect(entries[1].value).toEqual([{ id: 'project', imageId: staged.id }])
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('preserves a current image when merging a backup with a colliding image ID', async () => {
    await restoreBackupData(backup(), false)
    const history = vi.mocked(kvSetMany).mock.calls[0][0][0].value as Array<{ id: string; image_id: string }>
    expect(history.find(item => item.id === 'existing')?.image_id).toBe('shared')
    expect(history.find(item => item.id === 'incoming')?.image_id).not.toBe('shared')
  })
  it('leaves records and settings untouched if staging an image fails', async () => {
    vi.mocked(imgPutRecord).mockRejectedValueOnce(new Error('quota'))
    await expect(restoreBackupData(backup(), true)).rejects.toThrow('原有作品与原图未删除')
    expect(kvSetMany).not.toHaveBeenCalled()
    expect(localStorage.getItem('aics_theme')).toBe('dark')
    expect(imgDeleteMany).toHaveBeenCalledWith([vi.mocked(imgPutRecord).mock.calls[0][0].id])
  })
  it('rolls back settings and staged images when atomic metadata publication fails', async () => {
    vi.mocked(kvSetMany).mockRejectedValueOnce(new Error('quota'))
    await expect(restoreBackupData(backup(), true)).rejects.toThrow('quota')
    expect(localStorage.getItem('aics_theme')).toBe('dark')
    expect(imgDeleteMany).toHaveBeenCalledWith([vi.mocked(imgPutRecord).mock.calls[0][0].id])
  })
  it('does not overwrite settings changed while images are being staged', async () => {
    const file = backup()
    file.data.settings = { aics_theme: 'light' }
    vi.mocked(imgPutRecord).mockImplementationOnce(async record => {
      localStorage.setItem('aics_theme', 'user-choice')
      localStorage.setItem('aics_chat_v1', JSON.stringify({ histories: { nene: [{ mid: 'new' }] } }))
      return record.id
    })
    await restoreBackupData(file, false)
    expect(localStorage.getItem('aics_theme')).toBe('user-choice')
    expect(localStorage.getItem('aics_chat_v1')).toContain('new')
  })
  it('does not roll back a setting changed after this restore published it', async () => {
    const file = backup()
    file.data.settings = { aics_theme: 'light' }
    vi.mocked(kvSetMany).mockImplementationOnce(async () => {
      localStorage.setItem('aics_theme', 'user-choice-after-publish')
      throw new Error('quota')
    })
    await expect(restoreBackupData(file, true)).rejects.toThrow('quota')
    expect(localStorage.getItem('aics_theme')).toBe('user-choice-after-publish')
  })
  it.each([false, true])('preserves writes made during image staging when publication fails (replace=%s)', async replace => {
    const file = backup()
    file.data.settings[CHAT_ARCHIVE_KEY] = JSON.stringify({ version: 1, archived: { nene: [] } })
    file.data.settings[CHAT_MEMORY_KEY] = JSON.stringify({ version: 1, byCharacter: { nene: [] } })
    const archive = JSON.stringify({ version: 1, archived: { nene: [{ mid: 'new', role: 'user', content: 'New conversation' }] } })
    const memory = JSON.stringify({ version: 1, byCharacter: { nene: [{ id: 'new', character: 'nene', text: 'New memory', createdAt: 1, updatedAt: 1 }] } })
    vi.mocked(imgPutRecord).mockImplementationOnce(async record => {
      localStorage.setItem(CHAT_ARCHIVE_KEY, archive)
      localStorage.setItem(CHAT_MEMORY_KEY, memory)
      localStorage.setItem('aics_theme', 'latest-theme')
      return record.id
    })
    vi.mocked(kvSetMany).mockRejectedValueOnce(new Error('quota'))
    await expect(restoreBackupData(file, replace)).rejects.toThrow('quota')
    expect(localStorage.getItem(CHAT_ARCHIVE_KEY)).toBe(archive)
    expect(localStorage.getItem(CHAT_MEMORY_KEY)).toBe(memory)
    expect(localStorage.getItem('aics_theme')).toBe('latest-theme')
  })
  it('validates all encoded images before writing any record', async () => {
    const file = backup(); file.images.push({ id: 'bad', dataUrl: 'data:image/png;base64,a' })
    await expect(restoreBackupData(file, true)).rejects.toThrow()
    expect(imgPutRecord).not.toHaveBeenCalled()
    expect(kvSetMany).not.toHaveBeenCalled()
  })
  it('recovers a lost publication acknowledgement without rolling back settings or images', async () => {
    vi.mocked(kvSetMany).mockImplementationOnce(async entries => {
      vi.mocked(kvGet).mockImplementation(async key => entries.find(entry => entry.key === key)?.value as never)
      throw new Error('ack lost')
    })
    await expect(restoreBackupData(backup(), true)).resolves.toBeUndefined()
    expect(localStorage.getItem('aics_theme')).toBe('light')
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it.each(['unreadable', 'partial'] as const)('retains images and settings when publication is %s', async mode => {
    vi.mocked(kvSetMany).mockImplementationOnce(async entries => {
      if (mode === 'unreadable') vi.mocked(kvGet).mockRejectedValue(new Error('offline'))
      else vi.mocked(kvGet).mockImplementation(async key => (key === entries[0].key ? entries[0].value : []) as never)
      throw new Error('ack lost')
    })
    await expect(restoreBackupData(backup(), true)).rejects.toThrow('导入图片已保留')
    expect(localStorage.getItem('aics_theme')).toBe('light')
    expect(imgDeleteMany).not.toHaveBeenCalled()
  })
  it('reports cleanup failure with staged identities and the original error', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = new Error('quota')
    vi.mocked(imgPutRecord).mockRejectedValueOnce(error)
    vi.mocked(imgDeleteMany).mockRejectedValueOnce(new Error('offline'))
    await expect(restoreBackupData(backup(), true)).rejects.toThrow('临时图片清理失败')
    expect(warning).toHaveBeenCalledWith('[backup-restore] cleanup failed', expect.objectContaining({
      operationId: expect.any(String), imageIds: [vi.mocked(imgPutRecord).mock.calls[0][0].id], error,
    }))
    warning.mockRestore()
  })
  it('rejects partially invalid backups instead of silently dropping images', () => {
    const file = backup(); file.images.push({ id: 'bad', dataUrl: 'not an image' })
    expect(() => normalizeBackup(file)).toThrow('无效图片')
  })
})
