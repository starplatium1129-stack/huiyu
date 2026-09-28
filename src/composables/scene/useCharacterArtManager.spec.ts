import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCharacterArtManager } from './useCharacterArtManager'
import { adoptCharacterArtManifest, clearCharacterArtManifest } from '@/platform/characterArtState'
const mock = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), budget: vi.fn(), confirm: vi.fn(), metadata: vi.fn() }))
vi.mock('@/api/characterArtApi', () => ({ characterArtApi: { get: mock.get, save: mock.save } }))
vi.mock('@/utils/runtimeEnvironment', () => ({ isLocalStudioHost: () => true }))
vi.mock('@/utils/imageDecodeBudget', () => ({ withinImageDecodeBudget: mock.budget }))
vi.mock('@/composables/useConfirm', () => ({ confirmAction: mock.confirm }))
vi.mock('vue-router', () => ({ onBeforeRouteLeave: vi.fn() }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ loadCharacterShell: mock.metadata,
  characters: [{ id: 'nene', name: '宁宁', portrait: { image: '../assets/characters/nene-official.webp' } }, { id: 'natsume', name: '夏目' }],
}) }))
const entry = { revision: 'new', portraitUrl: '/api/character-art/nene/new/portrait.png', thumbnailUrl: '/api/character-art/nene/new/thumbnail.png', particleUrl: '/api/character-art/nene/new/particles.json', width: 500, height: 700, hasTransparency: true }
const picture = () => new File(['fixture'], 'portrait.png', { type: 'image/png' })
let wrapper: ReturnType<typeof mount>
function setup(id = 'nene') {
  let flow!: ReturnType<typeof useCharacterArtManager>
  wrapper = mount(defineComponent({ setup() { flow = useCharacterArtManager(() => id); return () => null } }))
  return flow
}
beforeEach(() => {
  clearCharacterArtManifest()
  mock.get.mockResolvedValue({ version: '0', entries: {} })
  mock.metadata.mockResolvedValue(undefined)
  mock.budget.mockResolvedValue(true)
  mock.confirm.mockResolvedValue(true)
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:candidate'), revokeObjectURL: vi.fn() })
})
afterEach(() => { wrapper?.unmount(); clearCharacterArtManifest(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('previews locally then applies one versioned replacement and releases the candidate image', async () => {
  mock.save.mockImplementation(async () => { adoptCharacterArtManifest({ version: '1', entries: { nene: entry } }); return { version: '1', entries: { nene: entry } } })
  const flow = setup(); await flushPromises()
  await flow.pick(picture())
  expect(mock.save).not.toHaveBeenCalled()
  expect(flow.previewUrl.value).toBe('blob:candidate')
  expect(flow.originalUrl.value).toBe('/assets/characters/nene-official.webp')
  await flow.save()
  expect(mock.save).toHaveBeenCalledWith({ baseVersion: '0', id: 'nene', image: expect.stringMatching(/^data:image\/png;base64,/) }, expect.anything())
  expect(flow.originalUrl.value).toBe(entry.portraitUrl)
  expect(flow.file.value).toBeNull()
  expect(flow.feedback.value).toContain('粒子已同步更新')
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:candidate')
})

it('preserves an unsaved candidate when switching is declined and retains it on conflict', async () => {
  const flow = setup(); await flushPromises(); await flow.pick(picture())
  mock.confirm.mockResolvedValueOnce(false)
  await flow.selectCharacter('natsume')
  expect(flow.selectedId.value).toBe('nene')
  mock.save.mockRejectedValueOnce(new Error('头像已更新，请刷新后重试'))
  await flow.save()
  expect(flow.file.value).not.toBeNull()
  expect(flow.error.value).toContain('头像已更新')
  expect(flow.feedback.value).toBe('')
})

it('restores all linked resources via reset and blocks oversized or undecodable candidates', async () => {
  const flow = setup(); await flushPromises()
  adoptCharacterArtManifest({ version: '1', entries: { nene: entry } })
  mock.save.mockImplementation(async () => { clearCharacterArtManifest(); return { version: '2', entries: {} } })
  await flow.reset()
  expect(mock.save).toHaveBeenCalledWith({ baseVersion: '1', id: 'nene', reset: true }, expect.anything())
  expect(flow.custom.value).toBeUndefined()
  mock.budget.mockResolvedValue(false)
  await flow.pick(picture())
  expect(flow.file.value).toBeNull()
  expect(flow.error.value).toContain('图片无法读取')
})

it('locks the confirmed character and rejects reentry while restore confirmation is pending', async () => {
  const flow = setup(); await flushPromises()
  adoptCharacterArtManifest({ version: '1', entries: { nene: entry } })
  let answer!: (value: boolean) => void
  mock.confirm.mockImplementationOnce(() => new Promise<boolean>(resolve => { answer = resolve }))
  const restoring = flow.reset()
  expect(flow.saving.value).toBe(true)
  await flow.selectCharacter('natsume'); await flow.reset()
  expect(flow.selectedId.value).toBe('nene')
  expect(mock.confirm).toHaveBeenCalledTimes(1)
  answer(false); await restoring
  expect(mock.save).not.toHaveBeenCalled()
  expect(flow.saving.value).toBe(false)
})
