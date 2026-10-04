import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useGeneratedSceneSave } from './useGeneratedSceneSave'
import type { CatalogChange } from '@/api/catalogApi'
import { ApiClientError } from '@/api/client'

const mock = vi.hoisted(() => ({ record: vi.fn(), state: vi.fn(), preview: vi.fn(), save: vi.fn(), image: vi.fn(), invalidate: vi.fn(), thumbnail: vi.fn() }))
vi.mock('@/api/maintenanceApi', () => ({ maintenanceApi: { saveShowcase: mock.image } }))
vi.mock('@/api/catalogApi', () => ({ catalogApi: { stats: mock.state, record: mock.record, changes: (payload: unknown, preview: boolean) => (preview ? mock.preview : mock.save)(payload) } }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ invalidate: mock.invalidate }) }))
vi.mock('@/utils/imageThumb', () => ({ blobThumbDataUrl: mock.thumbnail }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
const state = () => ({ ok: true, version: 7, nextSceneId: 'sc303', snapshot: { scenes: [], blueprints: [], tags: [], curation: {} } })
let wrapper: ReturnType<typeof mount>
function setup(popular = false) {
  let flow!: ReturnType<typeof useGeneratedSceneSave>
  wrapper = mount(defineComponent({ setup() {
    flow = useGeneratedSceneSave({ recipe: { engine: 'krea2', subject: 'studio', character: 'nene',
      ...(popular ? { subject: 'popular' as const, characterId: 'example', outfitId: 'default', blueprintId: 'source' } : {}),
      prompt: 'A woman watches rain through a window.', negative: '', size: '1024x1024', seed: 0,
      story: '望着窗外。', sceneTitle: '窗边' }, image: new Blob(['image'], { type: 'image/png' }), previewUrl: 'blob:fixture' })
    return () => null
  } }))
  return flow
}
beforeEach(() => {
  mock.state.mockResolvedValue(state())
  mock.preview.mockResolvedValue({ ok: true, preview: true, version: 7, items: [{ id: 'sc303' }], diffs: [] })
  mock.record.mockRejectedValue(new ApiClientError('不存在', { kind: 'http', status: 404 }))
  mock.save.mockResolvedValue({ ok: true })
  mock.thumbnail.mockResolvedValue('data:image/jpeg;base64,fixture')
  mock.image.mockResolvedValue({ ok: true })
})
afterEach(() => { wrapper?.unmount(); vi.resetAllMocks() })

it('requires explicit rating, previews a single new scene, saves once and attaches the image', async () => {
  const flow = setup(); await flushPromises()
  expect(flow.canReview.value).toBe(false)
  flow.rating.value = 'All'
  await flow.review()
  expect(mock.save).not.toHaveBeenCalled()
  expect(mock.preview.mock.calls[0][0]).toMatchObject([{ kind: 'scene', id: 'sc303', expectedRevision: 0, data: { story: '望着窗外。', storyJa: '', negative: '' } }])
  await flow.save(); await flow.save()
  expect(mock.save).toHaveBeenCalledTimes(1)
  expect(flow.savedId.value).toBe('sc303')
  expect(mock.image).toHaveBeenCalledWith(expect.objectContaining({ id: 'sc303' }), expect.anything())
  expect(mock.invalidate).toHaveBeenCalledTimes(1)
})

it('invalidates a preview when the user edits and keeps input after a save conflict', async () => {
  const flow = setup(); await flushPromises(); flow.rating.value = 'All'
  await flow.review(); flow.title.value = '雨后'; await flushPromises()
  await flow.save(); expect(mock.save).not.toHaveBeenCalled()
  await flow.review(); mock.save.mockRejectedValueOnce(new Error('版本冲突'))
  await flow.save()
  expect(flow.title.value).toBe('雨后')
  expect(flow.baseline.value).not.toBeNull()
  expect(flow.savedId.value).toBe('')
  expect(flow.error.value).toContain('版本冲突')
})

it('reconciles a lost save acknowledgement before allowing another creation', async () => {
  const flow = setup(); await flushPromises(); flow.rating.value = 'All'; flow.attachImage.value = false
  await flow.review()
  const payload = mock.preview.mock.calls[0][0] as CatalogChange[]
  mock.save.mockRejectedValueOnce(new Error('network'))
  mock.record.mockResolvedValueOnce({ record: { data: payload[0].data } })
  await flow.save(); await flow.save()
  expect(flow.savedId.value).toBe('sc303')
  expect(mock.save).toHaveBeenCalledTimes(1)
})

it('retries only the image after a partial image upload failure', async () => {
  const flow = setup(); await flushPromises(); flow.rating.value = 'All'
  await flow.review(); mock.image.mockRejectedValueOnce(new Error('图片服务暂不可用'))
  await flow.save()
  expect(flow.savedId.value).toBe('sc303')
  expect(flow.imageError.value).toContain('场景已保存')
  await flow.saveImage()
  expect(flow.imageError.value).toBe('')
  expect(mock.save).toHaveBeenCalledTimes(1)
  expect(mock.image).toHaveBeenCalledTimes(2)
})

it('keeps a user-edited composition when reloading after a conflict', async () => {
  mock.record.mockResolvedValue({ record: { data: { id: 'source', compositionIntent: 'group' } } })
  const flow = setup(true); await flushPromises()
  expect(flow.composition.value).toBe('group')
  expect(flow.compositionEdited.value).toBe(false)
  flow.composition.value = 'triptych'
  await flow.load()
  expect(flow.composition.value).toBe('triptych')
  expect(flow.compositionEdited.value).toBe(true)
})
