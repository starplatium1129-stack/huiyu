import { flushPromises } from '@vue/test-utils'
import { effectScope, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maintenanceApi } from '@/api/maintenanceApi'
import { setRuntimeFetch, setRuntimeOrigin } from '@/platform/runtimeUrl'
import { useSceneShowcaseUpload } from './useSceneShowcaseUpload'
import { showcaseItem } from './useCatalogMedia'

vi.mock('@/api/maintenanceApi', () => ({ maintenanceApi: { saveShowcase: vi.fn(), resetHomeHero: vi.fn() }, maintenanceFailure: () => null }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: vi.fn().mockResolvedValue(true) }))
vi.mock('@/composables/useHomeHeroes', () => ({ useHomeHeroes: () => ({ heroes: ref({}), reload: vi.fn() }) }))
const scopes: EffectScope[] = []
const entry = {
  id: 'pc_alice_library', title: '书架之间', char: 'alice', type: 'popular', rating: 'All',
  image: 'images/pc_current_alice_library.png', thumb: 'thumbs/pc_current_alice_library.webp',
}
const response = (entries: unknown[]) => new Response(JSON.stringify({ entries }), { headers: { 'Content-Type': 'application/json' } })
function setup() {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(() => useSceneShowcaseUpload({ errorMessage: String }))!
}
beforeEach(() => {
  setRuntimeOrigin(null, false)
  setRuntimeFetch((input, init) => globalThis.fetch(input, init))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([entry])))
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  setRuntimeOrigin(null, false)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('maintenance showcase sources', () => {
  it('uses the published image and thumbnail paths for the same logical scene', async () => {
    const upload = setup()
    await flushPromises()
    upload.previewImage(showcaseItem({ kind: 'blueprint', id: 'library', title: entry.title, characterId: entry.char, rating: 'All' }))
    expect(upload.showcaseUrl.value).toMatch(/^\/scene-showcase\/images\/pc_current_alice_library\.png\?v=\d+$/)
    expect(upload.thumbUrl(entry.id)).toMatch(/^\/scene-showcase\/thumbs\/pc_current_alice_library\.webp\?v=\d+$/)
    const cachedThumbnail = upload.thumbUrl(entry.id)
    upload.previewImage({ id: 'sc001', title: '另一个故事', char: 'nene', type: 'scene' })
    expect(upload.thumbUrl(entry.id)).toBe(cachedThumbnail)
  })

  it('derives the default path only for a verified manifest entry and rejects unsafe or ambiguous entries', async () => {
    vi.mocked(fetch).mockResolvedValue(response([
      { ...entry, id: 'pc_default', image: undefined, thumb: undefined },
      { ...entry, id: 'pc_unsafe', image: '../other.png', thumb: 'https://example.com/other.png' },
      { ...entry, id: 'pc_duplicate' }, { ...entry, id: 'pc_duplicate' },
    ]))
    const upload = setup()
    await flushPromises()
    expect(upload.imageUrl('pc_default')).toMatch(/^\/scene-showcase\/images\/pc_default\.jpg\?v=\d+$/)
    expect(upload.thumbUrl('pc_default')).toMatch(/^\/scene-showcase\/thumbs\/pc_default\.jpg\?v=\d+$/)
    for (const id of ['pc_missing', 'pc_unsafe', 'pc_duplicate']) {
      expect(upload.imageUrl(id)).toBe('')
      expect(upload.thumbUrl(id)).toBe('')
    }
  })

  it('cancels an old manifest and ignores its late result after the runtime changes', async () => {
    let finish!: (value: Response) => void
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve }))
    const upload = setup()
    const oldSignal = vi.mocked(fetch).mock.calls[0][1]!.signal!
    setRuntimeOrigin('http://127.0.0.1:3002', true, 'reconnected')
    await flushPromises()
    expect(oldSignal.aborted).toBe(true)
    expect(upload.imageUrl(entry.id)).toContain(entry.image)
    finish(response([{ ...entry, image: 'images/pc_old.jpg' }]))
    await flushPromises()
    expect(upload.imageUrl(entry.id)).toContain(entry.image)
  })

  it('cancels pending reads on disposal and leaves an unavailable manifest closed', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
    const upload = setup()
    await flushPromises()
    expect(upload.imageUrl(entry.id)).toBe('')
    vi.mocked(fetch).mockReturnValueOnce(new Promise(() => {}))
    setRuntimeOrigin('http://127.0.0.1:3002', true, 'retry')
    await flushPromises()
    const signal = vi.mocked(fetch).mock.lastCall![1]!.signal!
    scopes[0].stop()
    expect(signal.aborted).toBe(true)
  })

  it.each(['current', 'changed', 'disposed'])('keeps decoded uploads with their original scene (%s)', async (selection) => {
    let completeImage!: () => void
    vi.mocked(maintenanceApi.saveShowcase).mockClear()
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,fixture'
      onload?: () => void
      readAsDataURL() { queueMicrotask(() => this.onload?.()) }
    })
    vi.stubGlobal('Image', class {
      naturalWidth = 832
      naturalHeight = 1216
      onload?: () => void
      set src(_value: string) { completeImage = () => this.onload?.() }
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,normalized')
    vi.mocked(maintenanceApi.saveShowcase).mockResolvedValue({ ok: true, file: `images/${entry.id}.jpg`, thumb: `thumbs/${entry.id}.jpg`, backup: 'fixture', message: '样张已保存' })
    const upload = setup()
    await flushPromises()
    upload.previewImage({ id: entry.id, title: entry.title, char: entry.char, type: 'popular' })
    vi.mocked(fetch).mockResolvedValue(response([{ ...entry, image: `images/${entry.id}.jpg`, thumb: `thumbs/${entry.id}.jpg` }]))
    const input = { files: [new File(['fixture'], 'sample.png', { type: 'image/png' })], value: 'fixture' }
    const pending = upload.onShowcasePicked({ target: input } as unknown as Event)
    await flushPromises()
    if (selection === 'changed') upload.previewImage({ id: 'pc_other', title: '另一场景', char: 'alice', type: 'popular' })
    if (selection === 'disposed') scopes[0].stop()
    const feedback = upload.showcaseFeedback.value
    completeImage()
    await pending
    if (selection === 'disposed') {
      expect(maintenanceApi.saveShowcase).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(1)
    } else {
      expect(maintenanceApi.saveShowcase).toHaveBeenCalledExactlyOnceWith({
        id: entry.id, image: 'data:image/jpeg;base64,normalized', thumbnail: 'data:image/jpeg;base64,normalized',
      }, { signal: expect.any(AbortSignal) })
      expect(upload.thumbUrl(entry.id)).toContain(`/scene-showcase/thumbs/${entry.id}.jpg`)
      if (selection === 'changed') {
        expect(upload.selectedImageId.value).toBe('pc_other')
        expect(upload.showcaseFeedback.value).toBe(feedback)
      } else {
        expect(upload.showcaseUrl.value).toContain(`/scene-showcase/images/${entry.id}.jpg`)
        expect(upload.showcaseFeedback.value).toBe('样张已保存')
      }
    }
    expect(upload.uploadBusy.value).toBe(false)
    expect(input.value).toBe('')
  })
})

it.each(['saved', 'refresh-failed', 'reset-failed', 'current-refresh-failed'])('keeps home hero feedback with its submitted character (%s)', async (outcome) => {
  const upload = setup()
  await flushPromises()
  let settle!: () => void
  vi.mocked(maintenanceApi.resetHomeHero).mockImplementationOnce(() => new Promise((resolve, reject) => {
    settle = () => outcome === 'reset-failed' ? reject(new Error('reset failure')) : resolve({ ok: true, character: 'nene', action: 'reset', backup: 'fixture', message: '已恢复内置图' })
  }))
  vi.mocked(upload.loadHomeHeroes).mockReset()
  if (outcome.endsWith('refresh-failed')) vi.mocked(upload.loadHomeHeroes).mockRejectedValueOnce(new Error('refresh failure'))
  upload.previewHero({ id: 'nene', title: '宁宁', image: '/fixture-nene.webp', updatedAt: '' })
  const pending = upload.resetHero()
  await flushPromises()
  if (outcome !== 'current-refresh-failed') upload.previewHero({ id: 'natsume', title: '夏目', image: '/fixture-natsume.webp', updatedAt: '' })
  const feedback = upload.showcaseFeedback.value
  settle()
  await pending
  if (outcome === 'current-refresh-failed') {
    expect(upload.selectedHeroId.value).toBe('nene')
    expect(upload.showcaseFeedback.value).toContain('已恢复内置图，但预览未能刷新')
    expect(upload.showcaseError.value).toBe(true)
  } else {
    expect(upload.selectedHeroId.value).toBe('natsume')
    expect(upload.showcaseFeedback.value).toBe(feedback)
    expect(upload.showcaseError.value).toBe(false)
  }
  expect(upload.uploadBusy.value).toBe(false)
  expect(maintenanceApi.resetHomeHero).toHaveBeenLastCalledWith('nene', { signal: expect.any(AbortSignal) })
})
