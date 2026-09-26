import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptHistoryStore } from './promptHistoryStore'
import { artworkRepository } from '@/storage/artworkRepository'

vi.mock('@/storage/artworkRepository', () => ({
  artworkRepository: { readHistory: vi.fn(), readProjects: vi.fn(), softDeleteArtwork: vi.fn(), restoreArtwork: vi.fn() },
}))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  vi.mocked(artworkRepository.readHistory).mockResolvedValue([])
  vi.mocked(artworkRepository.readProjects).mockResolvedValue([])
})

describe('promptHistoryStore 持久化同步', () => {
  it('存储已清空时清除旧列表，后续读取重新填充', async () => {
    const store = usePromptHistoryStore()
    store.history = [{ id: 1 }]
    await store.loadHistory()
    expect(store.history).toEqual([])
    vi.mocked(artworkRepository.readHistory).mockResolvedValue([{ id: 2 }])
    await store.loadHistory()
    expect(store.history).toEqual([{ id: 2 }])
  })

  it('删除失败保留内存条目，成功时兼容旧数据中的字符串 id', async () => {
    const store = usePromptHistoryStore()
    store.history = [{ id: '12' }, { id: 13 }]
    vi.mocked(artworkRepository.softDeleteArtwork).mockRejectedValueOnce(new Error('quota'))
    await expect(store.removeHistoryEntry(12)).rejects.toThrow('quota')
    expect(store.history).toHaveLength(2)
    vi.mocked(artworkRepository.softDeleteArtwork).mockResolvedValueOnce({ deleted: true })
    await store.removeHistoryEntry(12)
    expect(store.history).toEqual([{ id: 13 }])
  })

  it('删除完成后，较早发起的读取不能把条目加回界面', async () => {
    const store = usePromptHistoryStore()
    let resolveRead!: (value: Array<{ id: number }>) => void
    vi.mocked(artworkRepository.readHistory).mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    store.history = [{ id: 1 }, { id: 2 }]
    const loading = store.loadHistory()
    vi.mocked(artworkRepository.softDeleteArtwork).mockResolvedValueOnce({ deleted: true })
    await store.removeHistoryEntry(1)
    resolveRead([{ id: 1 }, { id: 2 }])
    await loading
    expect(store.history).toEqual([{ id: 2 }])
  })

  it('恢复成功后重新载入历史与项目，恢复失败不改变当前视图', async () => {
    const store = usePromptHistoryStore()
    vi.mocked(artworkRepository.restoreArtwork).mockResolvedValueOnce({ restored: false })
    expect(await store.restoreHistoryEntry(1)).toBe(false)
    expect(artworkRepository.readHistory).not.toHaveBeenCalled()
    vi.mocked(artworkRepository.restoreArtwork).mockResolvedValueOnce({ restored: true })
    vi.mocked(artworkRepository.readHistory).mockResolvedValue([{ id: 1 }])
    vi.mocked(artworkRepository.readProjects).mockResolvedValue([{ id: 'p1', name: '项目' }])
    expect(await store.restoreHistoryEntry(1)).toBe(true)
    expect(store.history).toEqual([{ id: 1 }])
    expect(store.projects).toEqual([{ id: 'p1', name: '项目' }])
    expect(artworkRepository.readHistory).toHaveBeenCalledTimes(1)
    expect(artworkRepository.readProjects).toHaveBeenCalledTimes(1)
  })

  it('时钟回调和单毫秒高并发不会产生重复作品编号', () => {
    const store = usePromptHistoryStore()
    const now = Date.now()
    const ids = Array.from({ length: 1001 }, () => store.historyIdSeq(now))
    ids.push(store.historyIdSeq(now + 1), store.historyIdSeq(now))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id, index) => !index || id > ids[index - 1])).toBe(true)
  })
})
