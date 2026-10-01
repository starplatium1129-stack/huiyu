import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { apiClient } from '@/api/client'
import { generationApi } from '@/api/generationApi'
import { usePromptBuilderStore, type Scene } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { DRAW_ENGINE_SETTING, settingsRepository } from '@/storage/settingsRepository'
import { usePromptWorkspace } from './usePromptWorkspace'
import type { AnimaSubmission } from '@/composables/generation/animaSessionContract'
import type { PromptGenerationContext } from './promptGenerationActions'
import type { SdResultSnapshot } from './sdResultActions'

vi.mock('@/utils/tempResult', () => ({ clearTempResult: vi.fn(), readTempResult: vi.fn(() => null), writeTempResult: vi.fn(() => true) }))

const scene: Scene = { id: 'fixture-one', title: '隔离场景', char: 'nene', story: 'A quiet garden.', prompt: 'garden', recommendedSize: '1216x832' }
const secondScene: Scene = { ...scene, id: 'fixture-two', title: '隔离场景二', story: 'A sunny window.', prompt: 'window', recommendedSize: '832x1216' }
const wrappers: VueWrapper[] = []

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('aics_pb_director_mode', 'pro')
  settingsRepository.set(DRAW_ENGINE_SETTING, 'sd')
  // Every backend request is an isolated fixture; no local gateway or model is contacted.
  vi.spyOn(apiClient, 'request').mockResolvedValue({ ok: true, online: false, models: [], samplers: [], schedulers: [] })
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(query = '', loadData: () => Promise<void> = async () => {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const pb = usePromptBuilderStore()
  const catalog = useSceneStore()
  catalog.scenes = [scene, secondScene]
  catalog.curation = { personaCoreSceneIds: [scene.id], curatedSceneIds: [secondScene.id] }
  const load = vi.spyOn(pb, 'loadData').mockImplementation(loadData)
  const loadHistory = vi.spyOn(pb, 'loadHistory').mockResolvedValue()
  const restoreDraft = vi.spyOn(pb, 'restoreDraft').mockReturnValue(false)
  const saveDraft = vi.spyOn(pb, 'saveDraft').mockImplementation(() => {})
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/prompt-builder', component: { render: () => null } }] })
  await router.push('/prompt-builder' + query)
  await router.isReady()
  let workspace!: ReturnType<typeof usePromptWorkspace>
  const wrapper = mount(defineComponent({ setup() { workspace = usePromptWorkspace(); return () => h('div') } }), { global: { plugins: [pinia, router] } })
  wrappers.push(wrapper)
  // SD status and video tools load lazily during mount; flushPromises alone does
  // not wait for Vite to finish those imports before the lifecycle applies links.
  await vi.dynamicImportSettled()
  await flushPromises()
  return { workspace, pb, catalog, router, wrapper, load, loadHistory, restoreDraft, saveDraft }
}

describe('workspace ownership and panel boundaries', () => {
  it('hires freezes the completed recipe before cold loading, supports loading cancellation and refuses unknown recipes', async () => {
    const anima: AnimaSubmission = { family: 'anima', request: { prompt: 'recipe A', negative: 'negative A', profileId: 'profile A',
      modelId: 'model A', loraId: null, loraStrength: null, character: null, width: 832, height: 1216, steps: 28, cfg: 4.5, seed: 0 }, context: { characterId: 'role A' } }
    const { workspace, pb } = await setup()
    workspace.drawEngine.value = 'anima'
    workspace.animaSession.patchState({ online: true, family: 'anima', phase: 'succeeded', resultContext: anima.context,
      result: { url: 'blob:original-A', blob: new Blob(['original'], { type: 'image/png' }), metadata: { ...anima.request,
        id: 'original-A', engine: 'anima', seed: 0, sampler: 'original', scheduler: 'original', createdAt: 0, resultUrl: null } } })
    const source = vi.spyOn(workspace.animaSession, 'resultSubmission').mockReturnValue(anima)
    vi.mocked(apiClient.request).mockRejectedValue(new Error('isolated submission failure'))
    const loading = workspace.upscaleCurrentResult()
    expect(source).toHaveBeenCalledOnce(); expect(workspace.generationBusy.value).toBe(true)
    source.mockReturnValue({ ...anima, request: { ...anima.request, prompt: 'recipe B', modelId: 'model B' } })
    pb.story = 'recipe B'
    await loading
    const posts = () => vi.mocked(apiClient.request).mock.calls.filter(([url, options]) => url === '/api/anima/jobs' && options?.method === 'POST')
    expect(posts()).toHaveLength(1)
    expect(posts()[0]![1]!.body).toMatchObject({ prompt: 'recipe A', modelId: 'model A', seed: 0, hiresFix: true })
    expect(workspace.animaSession.restoreStashedResult()).toBe(true)
    source.mockReturnValue(anima)
    const cancelled = workspace.upscaleCurrentResult()
    workspace.cancelGeneration(); await cancelled
    expect(posts()).toHaveLength(1)
    expect(workspace.generationBusy.value).toBe(false)

    const { upscaleCurrentResultAction } = await import('./promptGenerationActions')
    const sd = { prompt: 'recipe A', negative: 'negative A', checkpoint: 'model A', sampler: 'Euler', size: '832x1216', seed: 0, cfg: 7, steps: 24,
      hiresFix: false, hiresScale: 1.5, denoisingStrength: 0.5, context: { char: 'nene' } } as SdResultSnapshot
    const current = { prompt: 'recipe B', model: 'model B', hiresFix: false }
    const generate = vi.fn().mockResolvedValue(undefined), run = vi.fn().mockResolvedValue('blob:hires')
    const capture = vi.fn(() => current), flash = vi.fn(), saved = vi.fn()
    const context = { pb: { flash, sdParams: current }, drawEngine: ref('anima'), generationBusy: ref(false),
      generateAnima: generate, captureJob: capture, applyManagedRoute: capture, runJob: run,
      sd: { errorMsg: ref('') }, sdErrorReport: ref(null), tempResultTools: { handleSdResult: saved },
    } as unknown as PromptGenerationContext
    await upscaleCurrentResultAction(context, { engine: 'anima', anima, sd: null })
    expect(generate).toHaveBeenCalledExactlyOnceWith({ hiresFix: true, hiresScale: 2, hiresDenoise: 0.35 }, anima)
    context.drawEngine.value = 'sd'
    await upscaleCurrentResultAction(context, { engine: 'sd', anima: null, sd })
    expect(run).toHaveBeenCalledExactlyOnceWith({ ...sd, hiresFix: true, hiresScale: 2, denoisingStrength: 0.35 })
    expect(saved).toHaveBeenCalledOnce(); expect(capture).not.toHaveBeenCalled()
    expect(current).toEqual({ prompt: 'recipe B', model: 'model B', hiresFix: false }); expect(sd.hiresFix).toBe(false)
    context.drawEngine.value = 'anima'
    await upscaleCurrentResultAction(context, { engine: 'anima', anima: null, sd: null })
    expect(generate).toHaveBeenCalledOnce()
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('未知'))
  })
  it('projects live store fields and keeps draft subscription single across mode changes', async () => {
    const { workspace, pb, catalog, saveDraft } = await setup()
    const { renderBindings, styleBindings, healthBindings, deliveryBindings } = workspace
    expect(renderBindings.pb).not.toBe(pb)
    expect(Object.keys(healthBindings.pb)).toEqual(['directorMode', 'isPopular'])
    expect('generate' in deliveryBindings).toBe(false)
    renderBindings.pb.sdModelName = 'fixture-checkpoint'
    expect(pb.sdModelName).toBe('fixture-checkpoint')
    const replacementParams = { ...pb.sdParams, steps: 19 }
    renderBindings.pb.sdParams = replacementParams
    expect(pb.sdParams.steps).toBe(19)
    pb.directorMode = 'basic'
    expect(styleBindings.pb.directorMode).toBe('basic')
    expect(healthBindings.pb.directorMode).toBe('basic')
    workspace.setDirectorMode('pro')
    await flushPromises()
    saveDraft.mockClear()
    pb.story = 'One shared draft update.'
    await nextTick()
    expect(deliveryBindings.pb.story).toBe(pb.story)
    expect(saveDraft).toHaveBeenCalledOnce()
    const previousScenes = deliveryBindings.scenes.value
    catalog.sceneBlueprints = [...catalog.sceneBlueprints]
    expect(deliveryBindings.scenes.value).toBe(catalog.sceneBlueprints)
    expect(deliveryBindings.scenes.value).not.toBe(previousScenes)
  })

  it('selects studio scenes through one action with size, caption and style reset intact', async () => {
    const { workspace, pb } = await setup()
    const caption = vi.fn()
    workspace.deliveryBindings.voiceStudioRef.value = { setSuggestedCaption: caption }
    workspace.animaSession.patchState({ styleLoraId: 'fixture-style' })
    workspace.materialBindings.sceneLimit.value = 80
    workspace.materialBindings.selectScene(scene)
    expect(pb.sceneId).toBe(scene.id)
    expect(pb.story).toBe(scene.story)
    expect(workspace.genBarSize.value).toBe(scene.recommendedSize)
    expect(workspace.animaState.value.styleLoraId).toBe('')
    expect(workspace.materialBindings.sceneLimit.value).toBe(20)
    expect(caption).toHaveBeenCalledWith(scene.story)
  })

  it('replays changed scene links on the same instance and preserves the material ref', async () => {
    const { workspace, pb, router, restoreDraft } = await setup('?scene=fixture-one')
    const limit = workspace.materialBindings.sceneLimit
    expect(pb.sceneId).toBe(scene.id)
    expect(restoreDraft).not.toHaveBeenCalled()
    await router.push('/prompt-builder?scene=fixture-two')
    await flushPromises()
    expect(pb.sceneId).toBe(secondScene.id)
    expect(pb.story).toBe(secondScene.story)
    expect(workspace.genBarSize.value).toBe(secondScene.recommendedSize)
    expect(workspace.materialBindings.sceneLimit).toBe(limit)
    workspace.materialBindings.setSceneCollection('core')
    expect(workspace.materialBindings.availableScenes.value.map(item => item.id)).toEqual([scene.id])
    pb.sceneSearch = secondScene.title
    await nextTick()
    expect(workspace.materialBindings.availableScenes.value.map(item => item.id)).toEqual([secondScene.id])
  })

  it('keeps explicit generation parameters on failure and retries through the same job path', async () => {
    const { workspace, pb } = await setup()
    workspace.materialBindings.selectScene(scene)
    pb.sdParams = { ...pb.sdParams, steps: 23, cfg: 5.5, seed: 123, seedLock: true, hiresFix: false, faceDetailer: false }
    const request = vi.spyOn(generationApi, 'createJob').mockRejectedValue(new Error('isolated failure'))
    await workspace.callGenerate()
    expect(request).toHaveBeenCalledOnce()
    const submitted = request.mock.calls[0][0]
    // The current SD queue conveys identity through its prompt/LoRAs; its gateway
    // character field is empty. This refactor deliberately keeps that request contract.
    expect(submitted).toMatchObject({ character: '', width: 1216, height: 832, steps: 23, cfg: 5.5, seed: 123, hiresFix: false, faceDetailer: false })
    expect(submitted.prompt).toContain('garden')
    expect(workspace.generationBusy.value).toBe(false)
    expect(workspace.deliveryBindings.sdErrorReport.value).not.toBeNull()
    await workspace.callGenerate()
    expect(request.mock.calls[1][0]).toEqual(submitted)
  })

  it('does not continue delayed initialization after the workspace is destroyed', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const { wrapper, loadHistory, restoreDraft } = await setup('?scene=fixture-one&generate=1', () => waiting)
    const generate = vi.spyOn(generationApi, 'createJob')
    wrapper.unmount()
    release()
    await flushPromises()
    expect(loadHistory).not.toHaveBeenCalled()
    expect(restoreDraft).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })
})
