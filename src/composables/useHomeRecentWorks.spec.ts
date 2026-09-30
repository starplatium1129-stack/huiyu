import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { ArtworkRecord } from '@/types/artwork'
const mocks = vi.hoisted(() => ({ history: vi.fn(), thumbnail: vi.fn(), image: vi.fn() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: {
  readRecentHistory: mocks.history, getThumbnail: mocks.thumbnail, getImage: mocks.image,
} }))
import { useHomeRecentWorks } from './useHomeRecentWorks'

const record = (id: number): ArtworkRecord => ({ id, timestamp: id, image_id: `image-${id}`, sceneTitle: `Work ${id}` })
const wrappers: VueWrapper[] = []
function setup() {
  let home!: ReturnType<typeof useHomeRecentWorks>
  const wrapper = mount(defineComponent({ setup() { home = useHomeRecentWorks(); return () => null } }))
  wrappers.push(wrapper)
  return { home, wrapper }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.history.mockResolvedValue([record(1), record(2), record(3), record(4)])
  mocks.thumbnail.mockResolvedValue('data:image/jpeg;base64,preview')
  mocks.image.mockResolvedValue(new Blob(['neutral image']))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:home-fixture')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('home recent-work loading', () => {
  it('loads the newest three previews without fetching or decoding their original images', async () => {
    const { home } = setup(); await home.load()
    expect(home.recentWorks.value.map(item => item.id)).toEqual([4, 3, 2])
    expect(mocks.history).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(mocks.thumbnail.mock.calls.map(([id]) => id)).toEqual(['image-4', 'image-3', 'image-2'])
    expect(home.coverUrl(record(4))).toBe('data:image/jpeg;base64,preview')
    expect(mocks.image).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
  it('falls back to originals only for missing previews and releases only owned Blob URLs', async () => {
    mocks.history.mockResolvedValue([record(1), record(2)])
    mocks.thumbnail.mockRejectedValueOnce(new Error('preview unavailable'))
    const { home, wrapper } = setup(); await home.load()
    expect(mocks.image).toHaveBeenCalledExactlyOnceWith('image-2', expect.any(AbortSignal))
    expect(home.coverUrl(record(2))).toBe('blob:home-fixture')
    expect(home.coverUrl(record(1))).toBe('data:image/jpeg;base64,preview')
    wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:home-fixture')
  })
  it('cancels an obsolete history read and discards its late result after another load', async () => {
    let finish!: (records: ArtworkRecord[]) => void
    mocks.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { home } = setup(), older = home.load()
    const oldSignal = mocks.history.mock.lastCall![0] as AbortSignal
    mocks.history.mockResolvedValue([record(5)])
    await home.load()
    expect(oldSignal.aborted).toBe(true)
    finish([record(1)]); await older
    expect(home.recentWorks.value.map(item => item.id)).toEqual([5])
    expect(mocks.thumbnail).toHaveBeenCalledExactlyOnceWith('image-5')
  })
  it('cancels metadata and prevents cover work when leaving before history returns', async () => {
    let finish!: (records: ArtworkRecord[]) => void
    mocks.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { home, wrapper } = setup(), loading = home.load()
    const signal = mocks.history.mock.lastCall![0] as AbortSignal
    wrapper.unmount(); expect(signal.aborted).toBe(true)
    finish([record(1)]); await loading
    expect(home.recentWorks.value).toEqual([]); expect(mocks.thumbnail).not.toHaveBeenCalled()
  })
  it('aborts pending original reads on exit without creating a late Blob URL', async () => {
    let finish!: (blob: Blob) => void
    mocks.history.mockResolvedValue([record(1)]); mocks.thumbnail.mockResolvedValue(null)
    mocks.image.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const { home, wrapper } = setup(), loading = home.load()
    await flushPromises()
    const signal = mocks.image.mock.lastCall![1] as AbortSignal
    wrapper.unmount(); expect(signal.aborted).toBe(true)
    finish(new Blob(['late image'])); await loading
    expect(URL.createObjectURL).not.toHaveBeenCalled(); expect(home.coverUrl(record(1))).toBe('')
  })
})
