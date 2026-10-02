import { beforeEach, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, reactive, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { useShotWorkspace } from './useShotWorkspace'
import { uploadVideoImage, type VideoStatusResponse } from '@/api/videoApi'
import { artworkRepository } from '@/storage/artworkRepository'

const route = reactive({ path: '/video-studio', query: {} as Record<string, string | undefined> })
const replace = vi.fn(async ({ query }: { query: Record<string, string | undefined> }) => { route.query = query })
const restoreDraft = vi.fn(async () => {})
const cards = ref<Array<{ characterId?: string; outfitId?: string }>>([{}])
const loadReferences = vi.fn(async (_id: string, _index: number, _outfit?: string, _signal?: AbortSignal) => 0)
beforeEach(() => { route.path = '/video-studio'; route.query = {}; cards.value = [{}]; loadReferences.mockReset(); replace.mockClear(); restoreDraft.mockReset() })
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
vi.mock('@/storage/artworkSession', () => ({ withArtworkStaging: (run: () => unknown) => run() }))
vi.mock('@/storage/artworkRepository', () => ({ artworkRepository: { putImage: vi.fn().mockResolvedValue('saved-image') } }))
vi.mock('@/api/videoApi', () => ({ uploadVideoImage: vi.fn() }))
vi.mock('@/composables/useTaskCenter', () => ({ useTrackedTask: vi.fn() }))
vi.mock('@/stores/sceneStore', () => ({ useSceneStore: () => ({ sceneBlueprints: [], popularCharacters: [] }) }))
vi.mock('@/stores/videoStore', () => ({ useVideoStore: () => ({ consumeScenarioActs: () => [] }) }))
vi.mock('@/utils/characterReferenceData', () => ({ ensureCharacterReferencesLoaded: vi.fn(), getCharacterReferences: vi.fn() }))
vi.mock('./useShotFirstFrames', () => ({ useShotFirstFrames: () => ({ firstFrameBusy: ref(false) }) }))
vi.mock('./useReferenceCards', () => ({ useReferenceCards: () => ({ referenceCards: cards, loadingRefAssets: ref(false), shotReferences: () => undefined, autoLoadCharacterReferences: loadReferences }) }))
vi.mock('./useShotAiTools', () => ({ useShotAiTools: () => ({}) }))
vi.mock('./useShotDraft', () => ({ useShotDraft: () => ({ restoreShotsDraft: restoreDraft }) }))
vi.mock('./useShotImport', () => ({ useShotImport: () => ({ importShotsFromDrawing: async () => null }) }))

it('keeps frame uploads on the captured shot and rejects cleared, replaced, or disposed requests', async () => {
  const pending: Array<(response: Awaited<ReturnType<typeof uploadVideoImage>>) => void> = []
  vi.mocked(uploadVideoImage).mockImplementation(() => new Promise(resolve => pending.push(resolve)))
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:new')
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  let tools!: ReturnType<typeof useShotWorkspace>
  const wrapper = mount(defineComponent({ setup() {
    tools = useShotWorkspace({ status: { online: true, models: [{ id: 'minimax-h3', available: true }], qualities: [] } as unknown as VideoStatusResponse })
    return () => null
  } }))
  const event = () => ({ target: { files: [new File(['image'], 'frame.png', { type: 'image/png' })], value: '' } }) as unknown as Event
  const response = { name: 'uploaded' } as Awaited<ReturnType<typeof uploadVideoImage>>
  try {
    await flushPromises()
    tools.addShot(); tools.addShot()
    tools.shots.value.forEach(shot => { shot.prompt = 'A complete shot description' })
    const original = tools.shots.value[0]
    const first = tools.onFramePicked(0, event())
    expect(tools.canSubmit.value).toBe(false)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    tools.moveShot(0, 1)
    pending[0](response); await first
    expect(tools.shots.value[1]).toBe(original)
    expect(original.imageName).toBe('uploaded')
    expect(tools.shots.value[0].imageName).toBe('')
    expect(tools.canSubmit.value).toBe(true)
    const cleared = tools.onFramePicked(1, event())
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    tools.clearFrame(1)
    pending[1](response); await cleared
    expect(original.imageName).toBe('')
    const old = tools.onFramePicked(1, event())
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    const newer = tools.onFramePicked(1, event())
    await vi.waitFor(() => expect(pending).toHaveLength(4))
    pending[2](response); await old
    expect(original.imageName).toBe('')
    tools.shots.value.splice(1, 1)
    pending[3](response); await newer
    const late = tools.onFramePicked(0, event())
    await vi.waitFor(() => expect(pending).toHaveLength(5))
    wrapper.unmount()
    pending[4](response); await late
    expect(create).toHaveBeenCalledTimes(1)
    expect(artworkRepository.putImage).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:new')
  } finally { if (wrapper.exists()) wrapper.unmount(); create.mockRestore(); revoke.mockRestore() }
})


it('applies only the latest explicit character/outfit after draft restore and does not replay on activation', async () => {
  route.query = { character: 'first', outfit: 'chosen', extra: 'keep' }
  let restored!: () => void
  restoreDraft.mockImplementationOnce(() => new Promise(resolve => { restored = resolve }))
  const pending: Array<() => void> = []
  loadReferences.mockImplementation((id, _index, outfit, signal) => new Promise(resolve => pending.push(() => {
    if (!signal?.aborted) cards.value[0] = { characterId: id, outfitId: outfit }
    resolve(0)
  })))
  const active = ref(true)
  let tools!: ReturnType<typeof useShotWorkspace>
  const Page = defineComponent({ setup() { tools = useShotWorkspace({ status: null }); return () => null } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Page) : null }) }))
  try {
    await nextTick()
    expect(loadReferences).not.toHaveBeenCalled()
    route.query = { character: 'second', outfit: 'special', extra: 'keep' }
    restored(); await flushPromises()
    expect(loadReferences.mock.calls[0].slice(0, 3)).toEqual(['second', 0, 'special'])
    const oldSignal = loadReferences.mock.calls[0][3]!
    route.query = { character: 'third', outfit: 'unknown-explicit', extra: 'latest' }
    await nextTick()
    expect(oldSignal.aborted).toBe(true)
    pending[0](); await flushPromises()
    expect(replace).not.toHaveBeenCalled()
    expect(loadReferences.mock.calls[1].slice(0, 3)).toEqual(['third', 0, 'unknown-explicit'])
    pending[1](); await flushPromises()
    expect(route.query).toEqual({ character: undefined, outfit: undefined, extra: 'latest' })
    tools.identityCard.value = 'User edited identity'
    active.value = false; await nextTick()
    active.value = true; await nextTick()
    expect(loadReferences).toHaveBeenCalledTimes(2)
    expect(tools.identityCard.value).toBe('User edited identity')
  } finally { wrapper.unmount() }
})
